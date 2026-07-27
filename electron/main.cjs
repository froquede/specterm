const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  Menu,
  clipboard,
  session,
  net,
  screen,
} = require("electron");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const pty = require("node-pty");
const fs = require("fs");
const { watch } = require("chokidar");
const { execFile, spawn } = require("child_process");
const { autoUpdater } = require("electron-updater");

// Linux sandbox fallback for the AppImage build. Chromium needs either a
// setuid-root chrome-sandbox helper OR working unprivileged user namespaces.
// The .deb ships a setuid-root helper (see build/linux/after-install.tpl), but
// an AppImage mounts its payload nosuid, so the helper can never be setuid
// there — the AppImage depends entirely on user namespaces. Ubuntu 23.10+/24.04
// restrict those by default via AppArmor (kernel.apparmor_restrict_unprivileged
// _userns=1), and Debian can disable them via kernel.unprivileged_userns_clone
// =0. On those kernels a sandboxed AppImage aborts at launch. Detect exactly
// that case and drop the renderer sandbox so the terminal still starts; leave
// it on everywhere else. A terminal already grants full shell access to the
// host, so the renderer sandbox adds little threat coverage here.
function unprivilegedUsernsBlocked() {
  const readTrim = (p, fallback) => {
    try {
      return fs.readFileSync(p, "utf8").trim();
    } catch {
      return fallback;
    }
  };
  // Ubuntu 23.10+ AppArmor gate: "1" => unprivileged userns blocked.
  if (readTrim("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "0") === "1") {
    return true;
  }
  // Debian/older sysctl: "0" => unprivileged userns disabled.
  if (readTrim("/proc/sys/kernel/unprivileged_userns_clone", "1") === "0") {
    return true;
  }
  return false;
}

if (
  process.platform === "linux" &&
  process.env.APPIMAGE &&
  unprivilegedUsernsBlocked()
) {
  app.commandLine.appendSwitch("no-sandbox");
}

// Locate PowerShell 7+ (pwsh.exe), which defaults to UTF-8. The built-in
// Windows PowerShell 5.1 instead defaults to the system code page (e.g. CP1252
// on pt-BR installs), which mangles accented/Unicode input on paste.
function findPwsh() {
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const candidate = path.join(programFiles, "PowerShell", "7", "pwsh.exe");
  return fs.existsSync(candidate) ? candidate : null;
}

// Pick the shell to spawn for each platform and any args it needs. On Windows
// `process.env.SHELL` is normally unset, so the old `|| "/bin/bash"` fallback
// spawned a binary that doesn't exist and the terminal died instantly. Prefer
// pwsh 7+ (UTF-8 by default); if only the legacy powershell.exe is available,
// force its console encoding to UTF-8 so accents survive.
function resolveShell() {
  if (process.platform === "win32") {
    if (process.env.SPECTERM_SHELL) {
      return { shell: process.env.SPECTERM_SHELL, args: [] };
    }
    const pwsh = findPwsh();
    if (pwsh) {
      return { shell: pwsh, args: [] };
    }
    return {
      shell: "powershell.exe",
      args: [
        "-NoExit",
        "-Command",
        "[Console]::OutputEncoding=[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding",
      ],
    };
  }
  return { shell: process.env.SHELL || "/bin/bash", args: [] };
}

// PTY instance management. Each instance records which window owns it (`wc`),
// so output routes to that window alone and closing a window kills only its own
// terminals. A PTY in mid-transfer between windows has `wc === null` and buffers
// its output into `pending` until the destination window adopts it.
const ptyInstances = new Map();
let nextPtyId = 1;

// Every open window. A Set — rather than a `mainWindow` singleton — is what lets
// the rest of this file stay window-agnostic: outbound IPC either targets the
// window resolved from a request's sender, or fans out across these.
const windows = new Set();

// Per-window filesystem watcher, keyed by webContents id: each window watches
// for its own sidebar, and its watcher dies with it.
const fsWatchers = new Map();

// What a freshly created window picks up on mount, keyed by webContents id: the
// tab a tear-off handed it, and whether it owns the one automatic update check
// of this process. Consumed exactly once, via "take-window-init".
const windowInit = new Map();

// Set once the automatic (launch-time) update check has been handed to a window,
// so opening more windows doesn't re-check GitHub on every one.
let updateCheckClaimed = false;

// Windows whose renderer has finished loading and is listening for "open-path".
const readyWindows = new WeakSet();

function openWindows() {
  return [...windows].filter((w) => !w.isDestroyed());
}

// The window a renderer request came from.
function windowOf(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

// Where a window-less action (an OS "Open With", a second launch) should land:
// whatever the user is looking at, falling back to the most recent window.
function targetWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && windows.has(focused)) return focused;
  const open = openWindows();
  return open.length ? open[open.length - 1] : null;
}

// Files the OS asked us to open (Finder "Open With", double-click, or a CLI
// path arg) that may arrive before any renderer has finished loading — macOS
// fires `open-file` even before `app` is ready. Queue them and drain into the
// first window that comes up; once one is up, send straight through.
const pendingOpenPaths = [];

function openPath(filePath) {
  if (!filePath) return;
  const win = targetWindow();
  if (win && readyWindows.has(win)) {
    win.webContents.send("open-path", filePath);
  } else {
    pendingOpenPaths.push(filePath);
  }
}

function flushOpenPaths(win) {
  if (!win || win.isDestroyed()) return;
  readyWindows.add(win);
  while (pendingOpenPaths.length) {
    win.webContents.send("open-path", pendingOpenPaths.shift());
  }
}

// Pull a markdown file path out of a process argv array — the Windows/Linux way
// the OS passes a double-clicked/"Open With" file (cold start via process.argv,
// warm start via the second-instance event). Scan for the first existing *.md.
// macOS uses the `open-file` event instead, so this never runs there.
function markdownPathFromArgv(argv) {
  for (const arg of argv.slice(1)) {
    if (typeof arg === "string" && arg.toLowerCase().endsWith(".md")) {
      try {
        if (fs.existsSync(arg)) return arg;
      } catch {
        // ignore unreadable args
      }
    }
  }
  return null;
}

// macOS delivers "Open With"/double-click through this event, which can fire
// before the app is ready and before any window exists. Register it at module
// scope (not inside whenReady) and let openPath() queue until the renderer is
// up. preventDefault stops Electron's default (which would otherwise warn).
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  openPath(filePath);
});

// Windows/Linux: a second launch (e.g. double-clicking another .md) starts a
// fresh process. Take a single-instance lock so that process forwards its file
// to the already-running window instead of opening a duplicate. macOS routes
// through `open-file` above and doesn't need this.
const singleInstanceOk =
  process.platform === "darwin" || app.requestSingleInstanceLock();

if (!singleInstanceOk) {
  app.quit();
} else if (process.platform !== "darwin") {
  app.on("second-instance", (_event, argv) => {
    const p = markdownPathFromArgv(argv);
    if (p) openPath(p);
    const win = targetWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

const WINDOW_WIDTH = 1200;
const WINDOW_HEIGHT = 800;

// Where a torn-off tab's new window should sit: centered on the drop point, but
// nudged back inside the display it landed on so no window opens with its title
// bar off-screen (which on macOS would leave it undraggable).
function windowBoundsAt(point) {
  const area = screen.getDisplayNearestPoint(point).workArea;
  const x = Math.round(point.x - WINDOW_WIDTH / 2);
  const y = Math.round(point.y - 20);
  return {
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x: Math.min(Math.max(x, area.x), area.x + area.width - WINDOW_WIDTH),
    y: Math.min(Math.max(y, area.y), area.y + area.height - WINDOW_HEIGHT),
  };
}

// Kill every PTY a window owned. Called when that window closes: its terminals
// die with it, while PTYs belonging to other windows — and any mid-transfer
// (`wc === null`, see the tear-off flow) — are left alone.
function killPtysOwnedBy(wc) {
  for (const [id, instance] of ptyInstances) {
    if (instance.wc !== wc) continue;
    if (!instance.disposed) {
      instance.process.kill();
      instance.disposed = true;
    }
    ptyInstances.delete(id);
  }
}

function createWindow(opts = {}) {
  const isMac = process.platform === "darwin";

  // Solid, opaque window on every platform — no transparency, blur or vibrancy.
  // macOS keeps the inset titlebar so the custom tab bar can host the traffic
  // lights (drag handled by `.tab-drag-region`); other platforms use their
  // native title bar.
  const platformWindow = isMac
    ? {
        backgroundColor: "#1a1b26",
        titleBarStyle: "hiddenInset",
        trafficLightPosition: { x: 14, y: 11 },
      }
    : { backgroundColor: "#1a1b26" };

  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    ...(opts.bounds || {}),
    title: "Specterm",
    autoHideMenuBar: true,
    ...platformWindow,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  windows.add(win);

  // What this window collects on mount. The automatic update check belongs to
  // the first window only — every later one would otherwise re-hit the GitHub
  // feed just for being opened.
  windowInit.set(win.webContents.id, {
    tab: opts.tab ?? null,
    autoCheckUpdates: !updateCheckClaimed,
  });
  updateCheckClaimed = true;

  // Remove menu bar entirely
  win.setMenuBarVisibility(false);

  // In dev, connect to Vite dev server; in prod, load built files
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  // Once the renderer is loaded, hand it any files queued while it booted (and
  // mark it ready so later open-file events go straight through). Fires again on
  // reloads — harmless, the queue is empty by then.
  win.webContents.on("did-finish-load", () => flushOpenPaths(win));

  // Open external links in default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Notify the renderer when the OS fullscreen state changes (e.g. macOS green
  // button, F11, or our own toggle) so the tab-bar icon stays in sync.
  win.on("enter-full-screen", () => {
    if (!win.isDestroyed()) win.webContents.send("fullscreen-change", true);
  });
  win.on("leave-full-screen", () => {
    if (!win.isDestroyed()) win.webContents.send("fullscreen-change", false);
  });

  // Tear down everything this window owned. `closed` fires after the webContents
  // is gone, so capture its id up front.
  const wc = win.webContents;
  const wcId = wc.id;
  win.on("closed", () => {
    windows.delete(win);
    windowInit.delete(wcId);
    killPtysOwnedBy(wc);
    const watcher = fsWatchers.get(wcId);
    if (watcher) {
      watcher.close();
      fsWatchers.delete(wcId);
    }
  });

  return win;
}

// === IPC Handlers ===

// How much output to hold for a PTY in transit between windows (a tear-off).
// Enough to cover the window-creation gap even for a chatty process; past that
// the oldest bytes go, exactly as scrollback does.
const TRANSIT_BUFFER_LIMIT = 1024 * 1024;

// Route PTY output to the window that owns it. A PTY handed over by a tear-off
// has no owner for the moment it takes the destination window to boot, so its
// output is parked instead of dropped — otherwise a build running in the torn-off
// tab would lose whatever it printed mid-flight.
function deliverPtyOutput(instance, id, data) {
  if (instance.wc === null) {
    instance.pending.push(data);
    instance.pendingBytes += data.length;
    while (
      instance.pendingBytes > TRANSIT_BUFFER_LIMIT &&
      instance.pending.length > 1
    ) {
      instance.pendingBytes -= instance.pending.shift().length;
    }
    return;
  }
  if (!instance.wc.isDestroyed()) {
    instance.wc.send("pty-output", id, Array.from(data));
  }
}

ipcMain.handle("spawn-pty", (event, opts) => {
  const { shell, args } = resolveShell();
  const id = nextPtyId++;

  const env = Object.assign({}, process.env, {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  });
  // On Unix the shell renders input/output per the locale. GUI apps launched
  // from Finder/Dock don't inherit LANG, so the shell falls back to the C
  // locale and shows UTF-8 accents as mojibake. Force a UTF-8 locale when none
  // is set. (Windows uses code pages instead — handled in resolveShell.)
  if (process.platform !== "win32") {
    env.LANG = process.env.LANG || "en_US.UTF-8";
    env.LC_CTYPE = process.env.LC_CTYPE || env.LANG;
  }

  // Guard against a stale/deleted configured cwd — node-pty throws if the
  // directory doesn't exist, which would kill terminal creation. Fall back to
  // home when the path is blank or gone.
  const cwd =
    opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : os.homedir();

  // Record the directory the terminal was opened in. This is the spawn cwd,
  // before the user's shell rc runs — so it survives an rc that `cd`s on
  // startup (which would otherwise mask where the terminal actually opened).
  env.SPECTERM_CWD = cwd;

  const ptyProcess = pty.spawn(shell, args, {
    name: "xterm-256color",
    cols: opts.cols,
    rows: opts.rows,
    cwd,
    env,
  });

  const instance = {
    process: ptyProcess,
    disposed: false,
    // The window this terminal belongs to. Reassigned by adopt-pty when a
    // tear-off moves the terminal to another window; null while in transit.
    wc: event.sender,
    pending: [],
    pendingBytes: 0,
  };
  ptyInstances.set(id, instance);

  ptyProcess.onData((data) => {
    deliverPtyOutput(instance, id, Buffer.from(data));
  });

  ptyProcess.onExit(() => {
    instance.disposed = true;
    if (instance.wc && !instance.wc.isDestroyed()) {
      instance.wc.send("pty-exit", id);
    }
  });

  return id;
});

// Hand a set of PTYs over: they keep running with no owner, buffering output,
// until the destination window adopts them. The source window calls this before
// it drops its terminals, so no output falls through the gap.
ipcMain.handle("release-pty", (_event, ids) => {
  for (const id of Array.isArray(ids) ? ids : [ids]) {
    const instance = ptyInstances.get(id);
    if (!instance) continue;
    instance.wc = null;
    instance.pending = [];
    instance.pendingBytes = 0;
  }
});

// Take ownership of a released PTY. The buffered output comes back as the return
// value rather than as an event, which is what fixes the ordering: the adopting
// renderer writes the serialized scrollback first, then these bytes, and only
// then does live output start flowing to it.
ipcMain.handle("adopt-pty", (event, id, cols, rows) => {
  const instance = ptyInstances.get(id);
  if (!instance) return { buffered: [], exited: true };

  instance.wc = event.sender;
  const buffered = instance.pending.length
    ? Array.from(Buffer.concat(instance.pending))
    : [];
  instance.pending = [];
  instance.pendingBytes = 0;

  if (!instance.disposed && cols > 0 && rows > 0) {
    try {
      instance.process.resize(cols, rows);
    } catch {
      // The process died between the check and the resize. The adopting window
      // learns that from `exited` below; failing the adopt instead would leave
      // it with a pane and no terminal.
    }
  }
  return { buffered, exited: instance.disposed };
});

ipcMain.handle("write-pty", (_event, id, data) => {
  const instance = ptyInstances.get(id);
  if (instance && !instance.disposed) {
    instance.process.write(data);
  }
});

ipcMain.handle("resize-pty", (_event, id, cols, rows) => {
  const instance = ptyInstances.get(id);
  if (instance && !instance.disposed) {
    instance.process.resize(cols, rows);
  }
});

ipcMain.handle("kill-pty", (_event, id) => {
  const instance = ptyInstances.get(id);
  if (instance && !instance.disposed) {
    instance.process.kill();
    instance.disposed = true;
  }
  ptyInstances.delete(id);
});

// === Filesystem IPC ===

ipcMain.handle("get-home-path", () => {
  return os.homedir();
});

ipcMain.handle("read-text-file", async (_event, filePath) => {
  return fs.promises.readFile(filePath, "utf-8");
});

ipcMain.handle("write-text-file", async (_event, filePath, content) => {
  return fs.promises.writeFile(filePath, content, "utf-8");
});

ipcMain.handle("read-dir", async (_event, dirPath) => {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  return entries.map((e) => ({
    name: e.name,
    isDirectory: e.isDirectory(),
  }));
});

// Enumerate mounted volumes so the sidebar can offer a "This PC" drive picker.
// Windows only — probe A:..Z: in parallel (fs.access is cheap and needs no
// child_process, unlike the deprecated wmic). Other platforms have a single "/"
// root and get an empty list.
ipcMain.handle("list-drives", async () => {
  if (process.platform !== "win32") return [];
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  const checks = await Promise.all(
    letters.map(async (letter) => {
      const root = `${letter}:\\`;
      try {
        await fs.promises.access(root);
        return { name: `${letter}:`, path: root };
      } catch {
        return null;
      }
    })
  );
  return checks.filter(Boolean);
});

// Reveal a path in the OS file manager (Explorer/Finder/the Linux default).
// A directory opens itself; a file is shown selected inside its parent folder.
// showItemInFolder is the cross-platform reveal; for a directory we prefer
// openPath so it opens *into* the folder, falling back to a reveal if the OS
// declines to open it (e.g. a path that no longer exists).
ipcMain.handle("reveal-in-file-manager", async (_event, targetPath, isDirectory) => {
  if (isDirectory) {
    const err = await shell.openPath(targetPath);
    if (err) shell.showItemInFolder(targetPath);
  } else {
    shell.showItemInFolder(targetPath);
  }
});

// True when the OS clipboard holds a bitmap. The renderer uses this to decide
// whether Ctrl+Shift+V should trigger Claude Code's inline image paste (by
// forwarding its Alt+V/Ctrl+V escape) or fall back to a normal text paste.
// Nothing is written to disk — the foreground app reads the clipboard itself.
ipcMain.handle("clipboard-has-image", () => {
  return !clipboard.readImage().isEmpty();
});

// Text clipboard via the main process. The renderer used to call
// navigator.clipboard directly, but in Electron that's unreliable — it rejects
// when the document isn't focused and is gated by permissions/secure-context,
// so copies silently failed to reach the OS clipboard (text pasted only inside
// the app, or not at all). The main-process `clipboard` module has no such
// constraints and always hits the real OS clipboard.
ipcMain.handle("clipboard-read-text", () => {
  return clipboard.readText();
});

ipcMain.handle("clipboard-write-text", (_event, text) => {
  clipboard.writeText(typeof text === "string" ? text : String(text));
});

// One watcher per window: each has its own sidebar browsing its own directory,
// and only that window is told when something under it changes.
ipcMain.handle("watch-dir", (event, dirPath) => {
  const wc = event.sender;
  const previous = fsWatchers.get(wc.id);
  if (previous) previous.close();

  const watcher = watch(dirPath, {
    ignored: /(^|[/\\])\.|node_modules|target|dist|build/,
    persistent: true,
    ignoreInitial: true,
    depth: 5,
    usePolling: false,
  });
  fsWatchers.set(wc.id, watcher);

  watcher.on("all", (_eventType, changedPath) => {
    if (
      typeof changedPath === "string" &&
      changedPath.endsWith(".md") &&
      !wc.isDestroyed()
    ) {
      wc.send("fs-change");
    }
  });
});

ipcMain.handle("unwatch-dir", (event) => {
  const watcher = fsWatchers.get(event.sender.id);
  if (watcher) {
    watcher.close();
    fsWatchers.delete(event.sender.id);
  }
});

// === Window IPC ===

ipcMain.handle("is-fullscreen", (event) => {
  const win = windowOf(event);
  return win ? win.isFullScreen() : false;
});

ipcMain.handle("set-fullscreen", (event, value) => {
  const win = windowOf(event);
  if (win) {
    win.setFullScreen(Boolean(value));
  }
});

// Whole-window alpha so the desktop shows through the terminal. Clamp to
// [0.3, 1] — the same floor the renderer enforces — so a bad value can never
// render the window invisible and unrecoverable.
//
// Windows/macOS honor BrowserWindow.setOpacity natively. On Linux/X11 that call
// is a no-op (Electron never sets the property the compositor reads), so we set
// _NET_WM_WINDOW_OPACITY on our own window ourselves via xprop — the value a
// compositing WM (Mutter, KWin, picom…) applies. Best-effort: on a bare X11
// session with no compositor, or without x11-utils installed, it simply doesn't
// dim, exactly as before.
function setX11WindowOpacity(win, opacity) {
  let xid;
  try {
    // getNativeWindowHandle returns the window's own X11 id (little-endian in
    // the buffer) — set the property on THIS window, never a name match.
    const handle = win.getNativeWindowHandle();
    if (handle.length < 4) return;
    xid = handle.readUInt32LE(0);
  } catch {
    return;
  }
  // _NET_WM_WINDOW_OPACITY is a 32-bit CARDINAL: 0xFFFFFFFF = opaque.
  const cardinal = Math.round(0xffffffff * opacity) >>> 0;
  execFile(
    "xprop",
    [
      "-id",
      `0x${xid.toString(16)}`,
      "-f",
      "_NET_WM_WINDOW_OPACITY",
      "32c",
      "-set",
      "_NET_WM_WINDOW_OPACITY",
      String(cardinal),
    ],
    () => {
      /* xprop missing or failed — leave the window opaque. */
    }
  );
}

ipcMain.handle("set-window-opacity", (event, value) => {
  const win = windowOf(event);
  if (!win) return;
  const n = Number(value);
  const opacity = Number.isFinite(n) ? Math.min(1, Math.max(0.3, n)) : 1;
  win.setOpacity(opacity); // Windows/macOS
  if (process.platform === "linux") {
    setX11WindowOpacity(win, opacity);
  }
});

// === Multi-window IPC ===

// Whatever this window was created with: a tab handed over by a tear-off, and
// whether it owns the process's one automatic update check. Read once, on mount.
ipcMain.handle("take-window-init", (event) => {
  const id = event.sender.id;
  const init = windowInit.get(id) ?? { tab: null, autoCheckUpdates: false };
  windowInit.delete(id);
  return init;
});

ipcMain.handle("new-window", () => {
  createWindow().focus();
});

// The landing half of a tear-off. The renderer has already released the tab's
// PTYs; here we decide where it goes, using the OS cursor position rather than
// anything the renderer measured — a drag that leaves the window may stop
// delivering pointer events to it, but the real cursor is always knowable.
//
// Drop over another Specterm window and the tab moves into it; drop anywhere
// else and it becomes a window of its own, centered on where it landed.
ipcMain.handle("drop-transfer", (event, tab) => {
  if (!tab) return;
  const point = screen.getCursorScreenPoint();
  const source = windowOf(event);

  for (const win of openWindows()) {
    if (win === source) continue;
    const b = win.getBounds();
    if (
      point.x >= b.x &&
      point.x < b.x + b.width &&
      point.y >= b.y &&
      point.y < b.y + b.height
    ) {
      win.webContents.send("adopt-tab", tab);
      if (win.isMinimized()) win.restore();
      win.focus();
      return;
    }
  }

  createWindow({ tab, bounds: windowBoundsAt(point) }).focus();
});

// Relay for state every window keeps its own copy of (settings, theme,
// favorites). The writer persists to localStorage and fires this; everyone else
// re-reads. Without it, changing the theme in one window would leave the others
// on the old one until the next launch.
ipcMain.on("broadcast", (event, channel, payload) => {
  for (const win of openWindows()) {
    if (win.webContents === event.sender) continue;
    win.webContents.send("broadcast", channel, payload);
  }
});

// === Application menu ===
// Minimal menu so the OS default accelerators (⌘C/⌘V/⌘W/⌘T/⌘D) don't get
// captured by the menu — those are handled in the renderer as terminal
// actions. We keep ⌘Q (quit), ⌘H (hide) and ⌘M (minimize).
function buildAppMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "Window",
      submenu: [
        // The renderer's keymap owns ⌘N like it owns ⌘T/⌘W/⌘D, so this shows
        // the shortcut without claiming it — registerAccelerator: false renders
        // the hint but leaves the key to reach the page.
        {
          label: "New Window",
          accelerator: isMac ? "Cmd+N" : "Ctrl+Shift+N",
          registerAccelerator: false,
          click: () => createWindow().focus(),
        },
        { type: "separator" },
        { role: "minimize" },
        { role: "zoom" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// === Auto-update (electron-updater) ===
// Pulls new releases from the GitHub feed declared in package.json `build.publish`
// (public repo → no token needed). The renderer drives the flow: it asks to
// check, then to download, then to install; every step's progress is streamed
// back over the "updater:event" channel so Settings can show live status.
//
// Manual download (autoDownload=false) — we never fetch a build behind the
// user's back; they press the buttons. autoInstallOnAppQuit only means anything
// where electron-updater owns the download, i.e. everywhere except macOS.
let updaterWired = false;
const isMac = process.platform === "darwin";

// macOS custom-updater state. electron-updater's mac path uses Squirrel.Mac,
// which refuses to apply an update unless the app carries a valid, consistent
// code signature — our builds are only ad-hoc signed, so Squirrel rejects them.
// We keep electron-updater for *detection* (reading latest-mac.yml needs no
// signature), then download + swap the .app bundle ourselves, exactly like the
// terminal install script does.
//
// macUpdateFile is the asset the *check* resolved — url, sha512 and size copied
// straight out of latest-mac.yml. The download must use this and nothing else:
// re-deriving the asset from a second GitHub query would let the installed build
// drift from the one the user was shown, and dropping the sha512 would mean
// replacing a working app with bytes we never verified.
let macLatestVersion = null;
let macUpdateFile = null;
let macStagedAppPath = null;
let macStagedWorkDir = null;

// The update flow belongs to the app, not to one window: any window's Settings
// panel can drive it, so every window hears every step.
function sendUpdaterEvent(payload) {
  for (const win of openWindows()) {
    win.webContents.send("updater:event", payload);
  }
}

// Never forward electron-updater's raw error to the renderer: its message/stack
// can embed the full HTTP response (including GitHub Set-Cookie headers), which
// has no business rendering in the Settings UI. Log the detail to the main
// process only and hand the renderer a short, safe, category-based message.
function reportUpdaterError(err) {
  console.error("[updater]", err);
  const raw = String((err && (err.message || err.code)) || err || "");
  let message = "Update failed. Please try again later.";
  if (/ENOTFOUND|ENETUNREACH|ETIMEDOUT|ECONNREFUSED|net::/i.test(raw)) {
    message = "Couldn't reach the update server. Check your connection.";
  } else if (/\b404\b/.test(raw)) {
    message = "No update feed found for this release.";
  } else if (/\b403\b|rate limit/i.test(raw)) {
    message = "Update server is rate-limiting. Try again shortly.";
  } else if (/sha512|checksum|integrity|truncated|size mismatch/i.test(raw)) {
    message = "Downloaded update failed its integrity check.";
  } else if (/no macos package/i.test(raw)) {
    message = "This release has no package for your Mac's architecture.";
  }
  sendUpdaterEvent({ status: "error", message });
  return message;
}

function wireAutoUpdater() {
  if (updaterWired) return;
  updaterWired = true;

  autoUpdater.autoDownload = false;
  // On macOS the download never goes through electron-updater, so there is
  // nothing staged for it to apply on quit — leaving this on would only claim a
  // behavior we don't have.
  autoUpdater.autoInstallOnAppQuit = !isMac;

  autoUpdater.on("checking-for-update", () =>
    sendUpdaterEvent({ status: "checking" })
  );
  autoUpdater.on("update-available", (info) => {
    // Pin the exact asset this check resolved so the macOS custom flow (which
    // bypasses Squirrel.Mac — see the mac section below) downloads that file and
    // verifies it against that hash, rather than asking GitHub again later.
    macLatestVersion = info.version;
    macUpdateFile = isMac ? macAssetFromUpdateInfo(info) : null;
    sendUpdaterEvent({ status: "available", version: info.version });
  });
  autoUpdater.on("update-not-available", (info) =>
    sendUpdaterEvent({ status: "not-available", version: info.version })
  );
  autoUpdater.on("download-progress", (p) =>
    sendUpdaterEvent({ status: "progress", percent: p.percent })
  );
  autoUpdater.on("update-downloaded", (info) =>
    sendUpdaterEvent({ status: "downloaded", version: info.version })
  );
  autoUpdater.on("error", (err) => reportUpdaterError(err));
}

// === macOS custom updater ===
// Detection still goes through electron-updater; only download + install are
// hand-rolled here to sidestep Squirrel.Mac's signature requirement.

// Which release owner/repo to hit. electron-builder bakes this into
// app-update.yml (from build.publish) at package time; parse it so we never
// hardcode a repo that could drift from the real publish target.
function readUpdateFeedRepo() {
  try {
    const ymlPath = path.join(process.resourcesPath, "app-update.yml");
    const text = fs.readFileSync(ymlPath, "utf8");
    const owner = /(^|\n)\s*owner:\s*([^\s#]+)/.exec(text)?.[2];
    const repo = /(^|\n)\s*repo:\s*([^\s#]+)/.exec(text)?.[2];
    if (owner && repo) return { owner, repo };
  } catch {
    // fall through
  }
  return null;
}

// Pick the mac zip for *this* machine's architecture out of the update info the
// check already parsed from latest-mac.yml. Returns null when the release has no
// package for this arch — the caller turns that into a visible error rather than
// installing a bundle for the wrong architecture, which would replace a working
// app with one that cannot launch.
function macAssetFromUpdateInfo(info) {
  const files = Array.isArray(info && info.files) ? info.files : [];
  const wantArch = process.arch === "arm64" ? "arm64" : "x64";
  const file = files.find(
    (f) =>
      f &&
      typeof f.url === "string" &&
      new RegExp(`mac-${wantArch}\\.zip$`).test(f.url) &&
      typeof f.sha512 === "string"
  );
  if (!file) return null;
  return {
    name: file.url,
    sha512: file.sha512,
    size: Number(file.size) || 0,
    arch: wantArch,
  };
}

// latest-mac.yml stores each asset as a bare filename, relative to the release
// it belongs to. Rebuild the download URL from the feed's owner/repo plus the
// version the check reported — the release workflow tags as v<version>.
function macAssetUrl(fileName, version) {
  const repo = readUpdateFeedRepo();
  if (!repo) throw new Error("No update feed configured.");
  return `https://github.com/${repo.owner}/${repo.repo}/releases/download/v${version}/${fileName}`;
}

// Stream a URL to disk, emitting "progress" as bytes arrive and hashing the body
// as it goes (so integrity costs no extra pass over the file). Resolves the
// sha512 digest, base64-encoded to match the encoding used in latest-mac.yml.
//
// Honors backpressure: a fast link into a slow disk would otherwise queue the
// whole archive in memory.
function downloadTo(url, destPath) {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, redirect: "follow" });
    request.setHeader("User-Agent", "Specterm-Updater");
    request.on("response", (response) => {
      if (response.statusCode !== 200) {
        response.on("data", () => {});
        reject(new Error(`Download HTTP ${response.statusCode}`));
        return;
      }
      const total = Number(response.headers["content-length"]) || 0;
      let received = 0;
      const hash = crypto.createHash("sha512");
      const out = fs.createWriteStream(destPath);

      const fail = (err) => {
        out.destroy();
        reject(err);
      };

      response.on("data", (chunk) => {
        received += chunk.length;
        hash.update(chunk);
        if (!out.write(chunk)) {
          response.pause();
          out.once("drain", () => response.resume());
        }
        if (total > 0) {
          sendUpdaterEvent({
            status: "progress",
            percent: (received / total) * 100,
          });
        }
      });
      response.on("end", () => {
        // A truncated body that never raised an error still has to fail here —
        // this file is about to replace the user's installed app.
        if (total > 0 && received !== total) {
          fail(
            new Error(`Download truncated: got ${received} of ${total} bytes.`)
          );
          return;
        }
        out.end(() => resolve(hash.digest("base64")));
      });
      response.on("error", fail);
      out.on("error", fail);
    });
    request.on("error", reject);
    request.end();
  });
}

// Resolve the running .app bundle root from the executable path:
// /Applications/Specterm.app/Contents/MacOS/Specterm → /Applications/Specterm.app
function currentAppBundlePath() {
  const marker = `.app${path.sep}Contents${path.sep}MacOS${path.sep}`;
  const idx = process.execPath.indexOf(marker);
  if (idx === -1) return null;
  return process.execPath.slice(0, idx + ".app".length);
}

// Where staged updates live. Deliberately *not* app.getPath("temp"): macOS
// purges $TMPDIR periodically, and a user who downloads today and restarts
// tomorrow would reach the install step with the staged bundle already gone.
function macUpdateRoot() {
  return path.join(app.getPath("userData"), "updates");
}

// Drop every staged directory except `keep`. Each one holds a zip plus an
// extracted .app — hundreds of MB per version — so without this the app quietly
// hoards a copy of every update it ever downloaded.
function pruneMacUpdateDirs(keep) {
  const root = macUpdateRoot();
  let entries = [];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry);
    if (full === keep) continue;
    fs.rmSync(full, { recursive: true, force: true });
  }
}

// Download the mac zip the check resolved, verify it against the sha512 from
// latest-mac.yml, and extract the new .app. Leaves the extracted bundle at
// macStagedAppPath and emits "downloaded".
//
// The hash is the whole point of this function: the install step deletes the
// running application, so nothing may reach it that we haven't proven is the
// file the update feed advertised. (It proves integrity, not provenance —
// publisher identity needs a Developer ID signature, which these builds don't
// carry. See the ad-hoc signing note above.)
async function macDownloadUpdate() {
  if (!macUpdateFile || !macLatestVersion) {
    throw new Error(
      `No macOS package for ${process.arch} in the latest release.`
    );
  }

  const workDir = path.join(
    macUpdateRoot(),
    `specterm-update-${macLatestVersion}-${macUpdateFile.arch}`
  );
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  pruneMacUpdateDirs(workDir);
  const zipPath = path.join(workDir, macUpdateFile.name);

  const digest = await downloadTo(
    macAssetUrl(macUpdateFile.name, macLatestVersion),
    zipPath
  );
  if (digest !== macUpdateFile.sha512) {
    fs.rmSync(workDir, { recursive: true, force: true });
    throw new Error("sha512 mismatch for the downloaded update.");
  }
  if (macUpdateFile.size > 0) {
    const actual = fs.statSync(zipPath).size;
    if (actual !== macUpdateFile.size) {
      fs.rmSync(workDir, { recursive: true, force: true });
      throw new Error(
        `Update size mismatch: expected ${macUpdateFile.size}, got ${actual}.`
      );
    }
  }

  // ditto preserves bundle metadata and the ad-hoc signature (plain unzip can
  // strip extended attributes and break the app).
  const extractDir = path.join(workDir, "extracted");
  fs.mkdirSync(extractDir, { recursive: true });
  await new Promise((resolve, reject) =>
    execFile("ditto", ["-x", "-k", zipPath, extractDir], (err) =>
      err ? reject(err) : resolve()
    )
  );

  const appName = fs
    .readdirSync(extractDir)
    .find((n) => n.endsWith(".app"));
  if (!appName) throw new Error("Extracted package had no .app bundle.");
  macStagedAppPath = path.join(extractDir, appName);
  macStagedWorkDir = workDir;
  // The archive is only needed to produce the bundle; the bundle is what the
  // install step copies.
  fs.rmSync(zipPath, { force: true });
  sendUpdaterEvent({ status: "downloaded", version: macLatestVersion });
}

// Swap the staged bundle in for the running one, then relaunch. The app can't
// overwrite its own bundle while running, so a detached shell waits for us to
// quit and does the swap.
//
// The installed app is never deleted before its replacement is in place: the
// new bundle is copied alongside and checked for a launchable executable, the
// old one is moved aside (not removed), and only a successful rename of the new
// bundle into place retires it. Any failure restores what was there. The naive
// order — rm then copy — turns a full disk or a missing staged bundle into "the
// user has no application at all", with no way to re-run the updater.
function macInstallUpdate() {
  const target = currentAppBundlePath();
  if (!target || !macStagedAppPath || !fs.existsSync(macStagedAppPath)) {
    throw new Error("No staged macOS update to install.");
  }
  const execName = path.basename(process.execPath);
  const script = `#!/bin/bash
set -e

TARGET=${JSON.stringify(target)}
STAGED=${JSON.stringify(macStagedAppPath)}
WORKDIR=${JSON.stringify(macStagedWorkDir || "")}
NEW="$TARGET.new"
OLD="$TARGET.old"

# Wait for this app to fully exit before touching its bundle. If it is somehow
# still alive, abort rather than swap a bundle out from under a running process.
for i in $(seq 1 60); do
  if ! kill -0 ${process.pid} 2>/dev/null; then break; fi
  sleep 0.5
done
if kill -0 ${process.pid} 2>/dev/null; then
  exit 1
fi

rm -rf "$NEW" "$OLD"

# Copy first, into a sibling path. ditto preserves bundle metadata and the
# ad-hoc signature; plain cp/unzip can strip extended attributes.
ditto "$STAGED" "$NEW"
test -x "$NEW/Contents/MacOS/"${JSON.stringify(execName)}

# Retire the current bundle only now, and only by moving it — so it is still
# there to restore if the rename below fails.
mv "$TARGET" "$OLD"
if ! mv "$NEW" "$TARGET"; then
  mv "$OLD" "$TARGET"
  rm -rf "$NEW"
  exit 1
fi

rm -rf "$OLD"
if [ -n "$WORKDIR" ]; then rm -rf "$WORKDIR"; fi
open "$TARGET"
`;
  const scriptPath = path.join(app.getPath("temp"), "specterm-install.sh");
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  const child = spawn("/bin/bash", [scriptPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  app.quit();
}

// Check: unpackaged/dev has no app-update.yml, so electron-updater throws.
// Report a "dev" status instead of surfacing that as an error in the UI.
ipcMain.handle("updater:check", async () => {
  if (!app.isPackaged) {
    sendUpdaterEvent({ status: "dev", version: app.getVersion() });
    return { status: "dev", version: app.getVersion() };
  }
  wireAutoUpdater();
  try {
    await autoUpdater.checkForUpdates();
    return { status: "ok" };
  } catch (err) {
    return { status: "error", message: reportUpdaterError(err) };
  }
});

ipcMain.handle("updater:download", async () => {
  if (!app.isPackaged) return { status: "dev" };
  wireAutoUpdater();
  try {
    // macOS: hand-rolled download+extract (Squirrel.Mac can't apply our ad-hoc
    // signed builds). Windows/Linux use electron-updater's native downloader.
    if (isMac) {
      await macDownloadUpdate();
    } else {
      await autoUpdater.downloadUpdate();
    }
    return { status: "ok" };
  } catch (err) {
    return { status: "error", message: reportUpdaterError(err) };
  }
});

// Quit and swap in the downloaded update. On Windows/Linux electron-updater
// handles it (NSIS wizard / AppImage relaunch). On macOS we swap the .app
// bundle ourselves, mirroring the terminal install.
ipcMain.handle("updater:install", () => {
  if (!app.isPackaged) return;
  try {
    if (isMac) {
      macInstallUpdate();
    } else {
      autoUpdater.quitAndInstall(false, true);
    }
  } catch (err) {
    reportUpdaterError(err);
  }
});

ipcMain.handle("updater:current-version", () => app.getVersion());

// === App lifecycle ===

app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");

// The renderer only ever loads bundled local content, so we grant the handful
// of web permissions the UI actually uses rather than the default deny: the
// Local Font Access API (system font list for the terminal font picker) and
// clipboard read/write (smart paste + copy). Everything else stays denied.
const GRANTED_PERMISSIONS = new Set([
  "local-fonts",
  "clipboard-read",
  "clipboard-sanitized-write",
]);

app.whenReady().then(() => {
  // Lost the single-instance race (Windows/Linux): the running instance already
  // got our file via second-instance, so this process is quitting — don't build
  // a second window.
  if (!singleInstanceOk) return;

  session.defaultSession.setPermissionRequestHandler(
    (_wc, permission, callback) => callback(GRANTED_PERMISSIONS.has(permission))
  );
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    GRANTED_PERMISSIONS.has(permission)
  );

  // Windows/Linux cold start: the launched-with file arrives as an argv path.
  // (macOS already queued it via the open-file event before we got here.)
  if (process.platform !== "darwin") {
    const p = markdownPathFromArgv(process.argv);
    if (p) openPath(p);
  }

  buildAppMenu();
  createWindow();
});

// Safety net. Each window already kills its own PTYs and closes its own watcher
// on `closed`; what can still be here is a PTY caught mid-transfer between two
// windows, which has no owner to clean it up.
app.on("window-all-closed", () => {
  for (const [, instance] of ptyInstances) {
    if (!instance.disposed) {
      instance.process.kill();
    }
  }
  ptyInstances.clear();

  for (const [, watcher] of fsWatchers) {
    watcher.close();
  }
  fsWatchers.clear();

  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
