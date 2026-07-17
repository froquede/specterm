const { app, BrowserWindow, ipcMain, shell, Menu, clipboard, session } = require("electron");
const path = require("path");
const os = require("os");
const pty = require("node-pty");
const fs = require("fs");
const { watch } = require("chokidar");
const { execFile } = require("child_process");

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

// PTY instance management
const ptyInstances = new Map();
let nextPtyId = 1;
let mainWindow = null;
let fsWatcher = null;

// Files the OS asked us to open (Finder "Open With", double-click, or a CLI
// path arg) that may arrive before the renderer has finished loading — macOS
// fires `open-file` even before `app` is ready. Queue them and drain once the
// renderer is up; while it's up, send straight through.
const pendingOpenPaths = [];
let rendererReady = false;

function openPath(filePath) {
  if (!filePath) return;
  if (rendererReady && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("open-path", filePath);
  } else {
    pendingOpenPaths.push(filePath);
  }
}

function flushOpenPaths() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  rendererReady = true;
  while (pendingOpenPaths.length) {
    mainWindow.webContents.send("open-path", pendingOpenPaths.shift());
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
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow() {
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

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "Specterm",
    autoHideMenuBar: true,
    ...platformWindow,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Remove menu bar entirely
  mainWindow.setMenuBarVisibility(false);

  // Fresh window: the renderer hasn't attached its open-path listener yet, so
  // any queued file waits until did-finish-load flushes it below.
  rendererReady = false;

  // In dev, connect to Vite dev server; in prod, load built files
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  // Once the renderer is loaded, hand it any files queued while it booted (and
  // mark it ready so later open-file events go straight through). Fires again on
  // reloads — harmless, the queue is empty by then.
  mainWindow.webContents.on("did-finish-load", flushOpenPaths);

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const currentUrl = mainWindow.webContents.getURL();
    if (url !== currentUrl) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Notify the renderer when the OS fullscreen state changes (e.g. macOS green
  // button, F11, or our own toggle) so the tab-bar icon stays in sync.
  mainWindow.on("enter-full-screen", () => {
    mainWindow?.webContents.send("fullscreen-change", true);
  });
  mainWindow.on("leave-full-screen", () => {
    mainWindow?.webContents.send("fullscreen-change", false);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// === IPC Handlers ===

ipcMain.handle("spawn-pty", (_event, opts) => {
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

  ptyInstances.set(id, { process: ptyProcess, disposed: false });

  ptyProcess.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(
        "pty-output",
        id,
        Array.from(Buffer.from(data))
      );
    }
  });

  ptyProcess.onExit(() => {
    const instance = ptyInstances.get(id);
    if (instance) {
      instance.disposed = true;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("pty-exit", id);
    }
  });

  return id;
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

ipcMain.handle("watch-dir", (_event, dirPath) => {
  if (fsWatcher) {
    fsWatcher.close();
  }

  fsWatcher = watch(dirPath, {
    ignored: /(^|[/\\])\.|node_modules|target|dist|build/,
    persistent: true,
    ignoreInitial: true,
    depth: 5,
    usePolling: false,
  });

  fsWatcher.on("all", (_eventType, changedPath) => {
    if (
      typeof changedPath === "string" &&
      changedPath.endsWith(".md") &&
      mainWindow &&
      !mainWindow.isDestroyed()
    ) {
      mainWindow.webContents.send("fs-change");
    }
  });
});

ipcMain.handle("unwatch-dir", () => {
  if (fsWatcher) {
    fsWatcher.close();
    fsWatcher = null;
  }
});

// === Window IPC ===

ipcMain.handle("is-fullscreen", () => {
  return mainWindow ? mainWindow.isFullScreen() : false;
});

ipcMain.handle("set-fullscreen", (_event, value) => {
  if (mainWindow) {
    mainWindow.setFullScreen(Boolean(value));
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

ipcMain.handle("set-window-opacity", (_event, value) => {
  if (!mainWindow) return;
  const n = Number(value);
  const opacity = Number.isFinite(n) ? Math.min(1, Math.max(0.3, n)) : 1;
  mainWindow.setOpacity(opacity); // Windows/macOS
  if (process.platform === "linux") {
    setX11WindowOpacity(mainWindow, opacity);
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
      submenu: [{ role: "minimize" }, { role: "zoom" }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

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

app.on("window-all-closed", () => {
  for (const [, instance] of ptyInstances) {
    if (!instance.disposed) {
      instance.process.kill();
    }
  }
  ptyInstances.clear();

  if (fsWatcher) {
    fsWatcher.close();
  }

  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
