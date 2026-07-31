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
  Tray,
  nativeImage,
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

// PowerShell shell integration: make the shell report its working directory via
// OSC 7 so a new pane/tab opens where this one is. Windows has no /proc and no
// lsof, and reading another process's current directory needs an undocumented
// native call whose struct layout shifts by Windows version and arch — so the
// pty-cwd handler returns null there and inheritance would otherwise fall back
// to the startup path. Instead we let the shell tell us, the same OSC 7 that zsh
// and fish emit by default (see registerCwdHandler in src/lib/osc.ts); the
// renderer already parses it. This is how Windows Terminal / VS Code do it too.
//
// The hook wraps whatever `prompt` the user's profile left in place (it runs
// after the profile via -Command), calls the original so their prompt is
// untouched, and appends a zero-width OSC 7. The path is emitted as a proper
// file URI (file:///C:/...) with an empty host, so it's accepted as local
// without needing the machine's hostname. No backslashes in the source (char 92
// = "\\", 47 = "/", 27 = ESC, 7 = BEL) to keep the -Command string clean.
const PS_CWD_OSC7 =
  "$__spt=$function:prompt; function global:prompt { " +
  "$o = if ($__spt) { & $__spt } else { \"PS $((Get-Location).Path)> \" }; " +
  "try { $d=(Get-Location).ProviderPath; if ($d) { " +
  "$u=([uri]('file:///'+$d.Replace([char]92,[char]47))).AbsoluteUri; " +
  "$Host.UI.Write(\"$([char]27)]7;$u$([char]7)\") } } catch {}; $o }";

// Force the legacy powershell.exe console to UTF-8 (pwsh 7+ already defaults to
// it), then install the OSC 7 hook above.
const PS_UTF8 =
  "[Console]::OutputEncoding=[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding";

// Pick the shell to spawn for each platform and any args it needs. On Windows
// `process.env.SHELL` is normally unset, so the old `|| "/bin/bash"` fallback
// spawned a binary that doesn't exist and the terminal died instantly. Prefer
// pwsh 7+ (UTF-8 by default); if only the legacy powershell.exe is available,
// force its console encoding to UTF-8 so accents survive. Both get the OSC 7
// working-directory hook so splits/new tabs inherit the live directory.
function resolveShell() {
  if (process.platform === "win32") {
    if (process.env.SPECTERM_SHELL) {
      return { shell: process.env.SPECTERM_SHELL, args: [] };
    }
    const pwsh = findPwsh();
    if (pwsh) {
      return { shell: pwsh, args: ["-NoExit", "-Command", PS_CWD_OSC7] };
    }
    return {
      shell: "powershell.exe",
      args: ["-NoExit", "-Command", `${PS_UTF8}; ${PS_CWD_OSC7}`],
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

// === Detached sessions (closing a window doesn't stop your shells) ===========
//
// The tmux model, as far as it can be taken without a separate daemon: closing a
// window *detaches* it instead of killing it. Its shells keep running in this
// process with no window attached, and the tray is how you get back to them.
//
// This is deliberately built on the tear-off protocol rather than beside it. A
// tear-off already reduces a window's tabs to `{ptyId, scrollback, title}` per
// pane, hands the PTYs over with no owner, buffers their output, and rebuilds
// real panes around them somewhere else. A detach is that same handover with
// nobody on the receiving end yet — so the payload is parked here and delivered
// to whichever window reattaches it.
//
// What it does *not* survive is this process dying: an explicit Quit, a crash, a
// reboot. Those fall back to the on-disk restore (lib/session-screens.ts +
// stores/history.ts), which replays the screens and reopens the layout with fresh
// shells. So there are two mechanisms, and they cover different failures:
// detaching keeps the processes, the disk snapshot keeps the picture.
const detachedSessions = [];

// PTYs a window has detached but whose session has not been parked yet, keyed by
// the window's webContents id.
//
// The gap is real and has to be cleaned up. detachWindow releases the PTYs
// *before* it serializes the screens, which is the right order — from the release
// on, output is buffered here instead of being sent to a window that is going away,
// so nothing is lost and nothing arrives twice. But it means that if the renderer
// never gets as far as parking (it threw, or it ran past the timeout below), the
// shells are already detached: they survive `killPtysOwnedBy`, because they no
// longer belong to that window, and no parked session references them. Live shells
// with no route back and nothing to reap them — exactly the leak the pillars call
// out. So the ids are held here until parking claims them, and reaped if it never
// does.
const detachedButUnparked = new Map();

function reapUnparkedPtys(wcId) {
  const ids = detachedButUnparked.get(wcId);
  if (!ids) return;
  detachedButUnparked.delete(wcId);
  for (const id of ids) {
    const instance = ptyInstances.get(id);
    if (!instance) continue;
    clearTransitTimer(instance);
    if (!instance.disposed) {
      instance.process.kill();
      instance.disposed = true;
    }
    ptyInstances.delete(id);
  }
}

// True from the first moment an explicit Quit is underway. Everything that would
// otherwise keep the app alive — the close interception, window-all-closed —
// checks it, because the whole point of Quit is that it wins.
let quitting = false;

// Whether closing a window detaches it. Owned by the renderer (it's a Settings
// toggle, persisted in localStorage) and pushed here on boot and on change,
// because this process is the one that has to decide, in the close handler,
// before any renderer is asked anything. Defaults to on: it's what the feature
// is for, and the toggle exists so an app that refuses to go away is never a
// surprise you can't undo.
let backgroundSessions = true;

let tray = null;

// Per-window filesystem watcher, keyed by webContents id: each window watches
// for its own sidebar, and its watcher dies with it.
const fsWatchers = new Map();

// The torn-off tab a freshly created window was made to host, keyed by
// webContents id. Consumed exactly once, via "take-window-init".
//
// Only the tab lives here. Everything else the window needs to know about
// itself is a flag, and flags go in through `additionalArguments` (see
// windowBootFlags below) so the renderer can read them with no round trip —
// what it builds its first tab from must not wait on IPC.
const windowInit = new Map();

// A window's saved layout, waiting to be collected synchronously by its preload.
const windowRestore = new Map();

// Both are claimed by the first window of the process and never handed out
// again: opening a second window must not re-hit the GitHub feed, and must not
// restore the saved session a second time (which would duplicate every tab and
// every shell in it).
let updateCheckClaimed = false;

// === The saved session ======================================================
//
// One entry per window: its tabs, which one was active, and where the window was.
// Pushed up by each renderer on the same debounce that already batches its store
// writes, so this is always within a second of the truth and no coordination is
// needed when the app goes away.
//
// This used to live in the renderer's localStorage, with exactly one window
// nominated to write it because every window shares one origin. That model could
// only ever save *one* window — quit with three open and two were gone — and the
// nomination itself was a recurring source of bugs: it was claimed once per launch
// and never released, so after the first window closed nothing wrote the snapshot
// again at all.
//
// Here there is nothing to nominate. Each window reports its own layout, this
// process assembles them, and the file it writes is the whole session.
const windowLayouts = new Map();

// Layouts belonging to detached sessions — windows that are closed but whose
// shells are still running. They are part of the saved session too: you hadn't
// finished with them, and if this process dies the shells go but the layout should
// still come back.
const parkedLayouts = [];

// The flags stamped into a window's launch arguments, read back by preload.cjs.
//
// Encoded as `key=0|1` pairs rather than as JSON: a switch value goes through
// Chromium's command-line handling, and on Windows that has a long history of
// mangling embedded quotes. There are no quotes here to mangle, and the result
// is still legible in a process list.
function windowBootArg(opts) {
  // One torn-off tab, or every tab of a reattached session — either way the
  // renderer must take the handover path and *not* restore the saved session on
  // top of it.
  const hasTab = Boolean(opts.tab) || Boolean(opts.tabs?.length);
  const autoCheckUpdates = !updateCheckClaimed;
  updateCheckClaimed = true;

  // Two different kinds of "something is waiting for you", deliberately kept apart
  // because only one of them may cost anything.
  //
  //   hasTabs  — tabs handed over with their PTYs still running (a tear-off, or a
  //              background session being reattached). Possibly megabytes of
  //              serialized screen, fetched asynchronously. That window exists only
  //              because a drag just ended, so a round trip is affordable.
  //   hasRestore — one window's saved layout at launch. Kilobytes, and the window's
  //              first tab is built from it, so it must be readable *synchronously*
  //              (see windowBoot in src/backends/index.ts, which spells out why:
  //              even a microtask in front of the first tab means the app no longer
  //              opens straight into a shell). The preload pulls it over a sync
  //              channel and hands it to the renderer as plain data.
  //   ownControls — whether this window is being created without a frame, and so
  //              has to draw its own minimise/maximise/close. It decides whether
  //              a whole strip of chrome exists, which makes it a layout
  //              question, and layout questions have to be answered before the
  //              first paint or the window visibly reflows a round trip later.
  //              It is stamped here, next to the `frame:` option it describes,
  //              so the two cannot disagree.
  const bit = (b) => (b ? "1" : "0");
  return {
    arg:
      `--specterm-boot=hasTabs=${bit(hasTab)},` +
      `hasRestore=${bit(Boolean(opts.restore))},` +
      `autoCheckUpdates=${bit(autoCheckUpdates)},` +
      `ownControls=${bit(process.platform !== "darwin" && sessionPrefs.customTitleBar)},` +
      `migrateLegacy=${bit(Boolean(opts.migrateLegacy))}`,
  };
}

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
      raise(win);
      return;
    }
    // Running in the background with every window closed: launching Specterm
    // again is the most obvious way to ask for it back, and it's the way that
    // still works when the desktop gave us no tray to put an icon in. Without
    // this, the second launch would hand off to us and then exit, leaving the
    // user with no window and no route to their shells.
    reattachSession();
  });
}

const WINDOW_WIDTH = 1200;
const WINDOW_HEIGHT = 800;

// How long a closing window is given to serialize its tabs and hand its PTYs
// over. Generous: it is the time to walk a handful of split trees and flush each
// terminal's write queue, and the cost of being too impatient is killing shells
// the user expected to find again. The cost of being too patient is a window that
// takes a moment to vanish, once, when a renderer has already broken.
const DETACH_TIMEOUT_MS = 4000;

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
    clearTransitTimer(instance);
    if (!instance.disposed) {
      instance.process.kill();
      instance.disposed = true;
    }
    ptyInstances.delete(id);
  }
}

// Kill the PTYs of every parked session. Called on an explicit Quit: a detached
// shell is only alive because this process is, and Quit means it isn't any more.
// Deliberately narrower than "kill everything" — a PTY mid-tear-off between two
// windows is also unowned, and this is not the thing that reaps those.
function killDetachedPtys() {
  for (const [id, instance] of ptyInstances) {
    if (!instance.detached) continue;
    clearTransitTimer(instance);
    if (!instance.disposed) {
      instance.process.kill();
      instance.disposed = true;
    }
    ptyInstances.delete(id);
  }
  detachedSessions.length = 0;
  parkedLayouts.length = 0;
}

// The tray exists for exactly as long as it's the only way back to something:
// while at least one session is parked. No parked sessions, no tray icon — this
// is a terminal, not a background service, and an icon that never does anything
// is just clutter in someone's status bar.
function updateTray() {
  if (quitting || detachedSessions.length === 0) {
    tray?.destroy();
    tray = null;
    return;
  }

  if (!tray) {
    const icon = nativeImage.createFromPath(path.join(__dirname, "tray.png"));
    try {
      // macOS wants a small monochrome image it can tint for the light/dark menu
      // bar; everywhere else the colour icon at its native size is right.
      tray = new Tray(
        process.platform === "darwin"
          ? (() => {
              const small = icon.resize({ width: 16, height: 16 });
              small.setTemplateImage(true);
              return small;
            })()
          : icon
      );
    } catch (err) {
      // No status bar / no tray host (a bare X session, some Wayland setups).
      // The sessions stay parked and reachable by relaunching the app, which
      // hits the single-instance path below and reattaches them.
      console.warn("[tray] unavailable:", err?.message ?? err);
      return;
    }
    tray.on("click", () => reattachSession());
    tray.on("double-click", () => reattachSession());
  }

  const n = detachedSessions.length;
  const label = `Specterm — ${n} detached session${n === 1 ? "" : "s"}`;
  tray.setToolTip(label);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label, enabled: false },
      { type: "separator" },
      {
        label: n === 1 ? "Reattach session" : "Reattach a session",
        click: () => reattachSession(),
      },
      { label: "New window", click: () => raise(createWindow()) },
      { type: "separator" },
      {
        // The one path that actually stops the shells, so it says so.
        label: "Quit Specterm (ends detached shells)",
        click: () => {
          quitting = true;
          killDetachedPtys();
          updateTray();
          app.quit();
        },
      },
    ])
  );
}

// Give a parked session a window again. Its panes adopt the PTYs that have been
// running all along, so nothing restarted and nothing was replayed — this is a
// reattach, not a restore. Falls back to a plain window when nothing is parked,
// so it's safe to wire to a bare "open a window" gesture (the tray, the dock).
function reattachSession() {
  const parked = detachedSessions.shift();
  if (parked?.layout) {
    // No longer parked, so it stops counting as a parked window in the saved
    // session — the live window it is about to become will report its own layout.
    const i = parkedLayouts.indexOf(parked.layout);
    if (i !== -1) parkedLayouts.splice(i, 1);
  }
  const win = parked
    ? createWindow({ tabs: parked.tabs, bounds: parked.bounds })
    : createWindow();
  updateTray();
  raise(win);
  return win;
}

// Windows come up without taking focus, and without jumping in front of what
// you were looking at, when SPECTERM_BACKGROUND_WINDOWS is set. The e2e suites
// set it (see test/README): between them they open and close a few dozen
// windows over a few minutes, and a suite that snatches the keyboard every time
// one appears is a suite you can only run when you have nothing else to do.
//
// Deliberately not a setting. It is not a way anyone would want to use the app —
// clicking "new window" and having it open behind the current one is wrong — it
// is a way to run the app while somebody else is using the desktop.
const BACKGROUND_WINDOWS = process.env.SPECTERM_BACKGROUND_WINDOWS === "1";

// Bring a window to the front, unless we have been asked not to. Every place
// that used to call win.focus() goes through here, so there is one answer to
// "does opening a window steal focus" rather than seven.
function raise(win) {
  if (win && !win.isDestroyed() && !BACKGROUND_WINDOWS) win.focus();
  return win;
}

function createWindow(opts = {}) {
  const isMac = process.platform === "darwin";

  // Solid, opaque window on every platform — no transparency, blur or vibrancy.
  //
  // The tab bar *is* the title bar. macOS has always worked that way (an inset
  // titlebar, with the traffic lights overlapping the tab bar and the drag handled
  // by `.tab-drag-region`); Windows and Linux now do too, with the window controls
  // drawn in the tab bar by TabBar.tsx.
  //
  // Two different mechanisms, because the platforms don't offer the same one:
  // Windows can hide the title bar and keep the frame, which is what preserves
  // native snapping and edge-resizing. Linux has no equivalent, so the frame comes
  // off entirely — see the note on the setting in stores/settings.ts for why this is
  // switchable rather than unconditional.
  const custom = sessionPrefs.customTitleBar;
  const platformWindow = isMac
    ? {
        backgroundColor: "#1a1b26",
        titleBarStyle: "hiddenInset",
        trafficLightPosition: { x: 14, y: 11 },
      }
    : custom
      ? {
          backgroundColor: "#1a1b26",
          ...(process.platform === "win32"
            ? { titleBarStyle: "hidden" }
            : { frame: false }),
        }
      : { backgroundColor: "#1a1b26" };

  // Flags first: they go into the renderer's own launch arguments, so they have
  // to be decided before the BrowserWindow exists.
  const boot = windowBootArg(opts);

  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    ...(opts.bounds || {}),
    title: "Specterm",
    autoHideMenuBar: true,
    // Held back and then shown *inactive* below, so the window appears where it
    // belongs without pulling focus off whatever has it.
    ...(BACKGROUND_WINDOWS ? { show: false } : {}),
    ...platformWindow,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      // Read synchronously by the preload (see preload.cjs). This is the whole
      // point: the renderer knows what kind of window it is at module load, so
      // the first terminal spawns without waiting on a round trip to us.
      additionalArguments: [boot.arg],
    },
  });

  windows.add(win);

  if (BACKGROUND_WINDOWS) {
    // ready-to-show rather than straight away: the window has painted by then,
    // so it appears complete instead of as a white rectangle that fills in.
    win.once("ready-to-show", () => {
      if (!win.isDestroyed()) win.showInactive();
    });
  }

  // The tabs this window was created to host, if any — fetched separately because
  // they carry serialized screens and have no business on a command line. One tab
  // for a tear-off, all of them for a session being reattached.
  const initTabs = opts.tabs?.length ? opts.tabs : opts.tab ? [opts.tab] : null;
  if (initTabs) windowInit.set(win.webContents.id, { tabs: initTabs });
  // A saved layout, for a window being reopened at launch. Kept in its own map
  // because it is collected over a *synchronous* channel by the preload, before the
  // renderer's first line runs — see windowBootArg above.
  if (opts.restore) windowRestore.set(win.webContents.id, opts.restore);

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

  // Send genuinely external links to the default browser, but never hijack
  // in-app navigations. Comparing full URLs treated every same-origin reload
  // (the Vite dev server's, a trailing-slash difference, a hash change) as
  // "external" and fired openExternal + preventDefault on it — in dev that
  // preventing-then-reopening looped the browser and stalled the renderer.
  // Gate on origin instead: same-origin (and non-http, e.g. file://) stays in
  // the window; only a different http(s) origin goes out.
  win.webContents.on("will-navigate", (event, url) => {
    let external = false;
    try {
      const target = new URL(url);
      const current = new URL(win.webContents.getURL());
      external = /^https?:$/.test(target.protocol) && target.origin !== current.origin;
    } catch {
      external = false;
    }
    if (external) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Notify the renderer when the OS fullscreen state changes (e.g. macOS green
  // button, F11, or our own toggle) so the tab-bar icon stays in sync.
  // The tab bar's maximise button reflects the real state, which the user can also
  // change from outside the app (a WM keybinding, a double-click on the drag
  // region, snapping).
  win.on("maximize", () => {
    if (!win.isDestroyed()) win.webContents.send("window-maximized", true);
  });
  win.on("unmaximize", () => {
    if (!win.isDestroyed()) win.webContents.send("window-maximized", false);
  });

  win.on("enter-full-screen", () => {
    if (!win.isDestroyed()) win.webContents.send("fullscreen-change", true);
  });
  win.on("leave-full-screen", () => {
    if (!win.isDestroyed()) win.webContents.send("fullscreen-change", false);
  });

  // The user is here now, so stop asking for them. The badge count itself is
  // left alone — the renderer owns it and clears it as panes are visited; this
  // only stops the taskbar flash, which on Windows would otherwise keep going
  // after the window is already in front.
  win.on("focus", () => {
    if (!win.isDestroyed()) win.flashFrame(false);
  });

  // --- detach-on-close ----------------------------------------------------
  //
  // A close is intercepted once, to give the renderer a chance to hand its shells
  // over before its terminals are destroyed. It can't be done from the renderer's
  // own `beforeunload`: serializing a screen has to wait on xterm's write queue,
  // and nothing asynchronous is guaranteed to finish there. So the close is
  // cancelled, the renderer is asked to park itself, and the real close happens
  // when it reports back (see the "park-session" handler).
  //
  // `parking` makes it a one-shot: the destroy below re-enters this handler, and
  // a second interception would deadlock the window shut.
  const wcIdOf = (w) => (w.isDestroyed() ? -1 : w.webContents.id);

  let parking = false;
  win.on("close", (event) => {
    if (quitting || parking || !backgroundSessions) return;
    if (win.webContents.isDestroyed() || win.webContents.isCrashed()) return;
    event.preventDefault();
    parking = true;
    win.webContents.send("detach-window");
    // A renderer that never answers — hung script, a throw between the two
    // steps — must not leave a window that can't be closed. Its shells die with
    // it in that case, which is exactly the old behavior.
    setTimeout(() => {
      if (win.isDestroyed()) return;
      // The renderer never answered. Anything it already detached is unreachable —
      // no session will be parked to hold it — so it dies with the window rather
      // than being left running with nothing pointing at it.
      reapUnparkedPtys(wcIdOf(win));
      win.destroy();
    }, DETACH_TIMEOUT_MS).unref?.();
  });

  // Tear down everything this window owned. `closed` fires after the webContents
  // is gone, so capture its id up front.
  const wc = win.webContents;
  const wcId = wc.id;
  win.on("closed", () => {
    windows.delete(win);
    windowInit.delete(wcId);
    windowRestore.delete(wcId);
    // Backstop for every path that reaches `closed` without parking — a crashed
    // renderer, a destroy from somewhere else. A no-op once park-session has
    // claimed the ids, which is the normal case.
    reapUnparkedPtys(wcId);

    windowLayouts.delete(wcId);
    attentionCounts.delete(wcId);
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

// How long a released PTY may sit with no owner before it is killed.
//
// A tear-off releases the PTYs first and only then asks where the tab landed, so
// there is always a window where a shell is running that no window is holding.
// Normally it lasts as long as it takes the destination to boot. If the handover
// never completes — the renderer threw between the two steps, the new window
// failed to load, the process was killed mid-drag — nothing would ever claim it,
// and a live shell would keep running (and keep filling a megabyte of buffer)
// until the app quit. Reclaiming it is what makes the release safe to do first.
//
// Generous on purpose: this is a backstop for a broken handover, not a deadline
// for a working one, and killing a shell someone is about to get back would be
// far worse than holding a dead one for a few seconds too long.
const TRANSIT_RECLAIM_MS = 30_000;

const EMPTY_BYTES = Buffer.alloc(0);

function clearTransitTimer(instance) {
  if (instance.transitTimer) {
    clearTimeout(instance.transitTimer);
    instance.transitTimer = null;
  }
}

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
    // The Buffer goes over as-is. Electron's structured clone carries a
    // Uint8Array natively, so this is one length-prefixed copy of the bytes —
    // whereas `Array.from(data)` (what this used to do) turned every single byte
    // into a boxed JS number, then serialized that array element by element.
    // This is the hottest path in the app: everything a shell prints comes
    // through it, and a `cat` of anything sizeable made it the bottleneck.
    instance.wc.send("pty-output", id, data);
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
    // Set only while this PTY is in transit between windows — see release-pty.
    transitTimer: null,
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
    // Armed from here, disarmed by adopt-pty. If nobody claims this PTY the
    // handover broke somewhere, and an unowned shell is not something to leave
    // running for the rest of the session.
    clearTransitTimer(instance);
    instance.transitTimer = setTimeout(() => {
      instance.transitTimer = null;
      if (instance.wc !== null) return; // adopted after all
      if (!instance.disposed) {
        instance.process.kill();
        instance.disposed = true;
      }
      instance.pending = [];
      instance.pendingBytes = 0;
      ptyInstances.delete(id);
    }, TRANSIT_RECLAIM_MS);
    // A reclaim that is the only thing left running must not hold the process
    // open past its own window.
    instance.transitTimer.unref?.();
  }
});

// Take ownership of a released PTY. The buffered output comes back as the return
// value rather than as an event, which is what fixes the ordering: the adopting
// renderer writes the serialized scrollback first, then these bytes, and only
// then does live output start flowing to it.
ipcMain.handle("adopt-pty", (event, id, cols, rows) => {
  const instance = ptyInstances.get(id);
  if (!instance) return { buffered: EMPTY_BYTES, exited: true };

  instance.wc = event.sender;
  clearTransitTimer(instance);
  // Concatenated once and sent as bytes, not as an array of numbers — this can
  // be a megabyte of a build's output, and boxing every byte of it would stall
  // the adopting window at exactly the moment it is trying to appear.
  const buffered = instance.pending.length
    ? Buffer.concat(instance.pending)
    : EMPTY_BYTES;
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

// Where a terminal's shell currently is, asked of the OS rather than of the
// shell. A new pane should open in the directory you're looking at, and the
// portable way to learn that — OSC 7 — only works if the shell is configured to
// emit it: zsh and fish do out of the box, but a plain bash (no VTE hook, empty
// PROMPT_COMMAND) reports nothing at all, which is the common case on Linux.
// So the shell's own process is the source of truth and OSC 7 is treated as a
// faster hint on top of it (see registerCwdHandler in src/lib/osc.ts).
//
//   Linux — /proc/<pid>/cwd is a symlink to the live working directory.
//   macOS — no /proc; lsof reports the cwd descriptor (-d cwd) in field format.
//   Windows — neither exists, and the Win32 equivalent needs a native call into
//             the target process, so this returns null and the caller falls
//             back to the configured startup path.
//
// Every failure path returns null instead of throwing: the pty may have exited
// between the renderer asking and us looking, and a missing cwd is never worth
// breaking a split over.
ipcMain.handle("pty-cwd", async (_event, id) => {
  const instance = ptyInstances.get(id);
  if (!instance || instance.disposed) return null;

  const pid = instance.process.pid;
  if (!pid) return null;

  try {
    if (process.platform === "linux") {
      return await fs.promises.readlink(`/proc/${pid}/cwd`);
    }
    if (process.platform === "darwin") {
      const out = await new Promise((resolve, reject) => {
        execFile("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], (err, stdout) =>
          err ? reject(err) : resolve(stdout)
        );
      });
      // -F output is one field per line, each prefixed by its letter; the cwd
      // path is the `n` line. Take the last one — lsof emits the process
      // header (p<pid>) first, and only one n line follows for -d cwd.
      const line = out
        .split("\n")
        .filter((l) => l.startsWith("n"))
        .pop();
      return line ? line.slice(1) : null;
    }
  } catch (_) {
    // Process gone, /proc unreadable, or lsof missing — no cwd to report.
  }
  return null;
});

// === Process inspection IPC ===
//
// What's running inside a pane, so the renderer's session providers (see
// src/lib/session-providers/) can recognize a resumable program and write down
// how to pick it back up. Deliberately generic: this side knows about parents,
// children and named environment variables, and nothing about any particular
// tool.
//
// Both handlers are best-effort by construction. A process can exit between the
// scan and the read, /proc can be unreadable, and Windows offers no equivalent
// without a native call into each target — every one of those returns empty
// rather than throwing, because the only consequence is that a restored pane
// comes back as a plain shell.

// Direct children of a pid, from the kernel's own list.
//
// This is the whole reason the Linux path doesn't enumerate /proc. Walking down
// from the shells we care about touches a handful of files; scanning every
// process on the machine touches hundreds, and doing that with Promise.all
// floods libuv's threadpool — which is only four threads wide by default and is
// the *same* pool node-pty uses for terminal I/O. A background poll that stalls
// every terminal in the app is far worse than no session detection at all.
async function linuxChildren(pid) {
  const out = [];
  try {
    // Children are listed per-thread, and a shell can have more than one.
    const tids = await fs.promises.readdir(`/proc/${pid}/task`);
    for (const tid of tids) {
      const raw = await fs.promises.readFile(
        `/proc/${pid}/task/${tid}/children`,
        "utf8"
      );
      for (const c of raw.trim().split(/\s+/)) {
        const n = Number(c);
        if (Number.isInteger(n)) out.push(n);
      }
    }
  } catch (_) {
    // Process gone, or a kernel built without CONFIG_PROC_CHILDREN. Either way
    // this pane reports nothing rather than falling back to a full scan.
  }
  return out;
}

// A process's own working directory. This is what makes a provider's answer
// correct while a full-screen program is running: the *shell's* cached cwd goes
// stale the moment something takes over the screen (no new prompt is drawn, so
// no OSC 7 arrives and the probe is off), but the program itself always knows
// where it is.
async function processCwd(pid) {
  if (process.platform !== "linux") return null;
  try {
    return await fs.promises.readlink(`/proc/${pid}/cwd`);
  } catch (_) {
    // Exited, or not ours to inspect.
    return null;
  }
}

async function linuxComm(pid) {
  try {
    return (await fs.promises.readFile(`/proc/${pid}/comm`, "utf8")).trim();
  } catch (_) {
    return null;
  }
}

// macOS has no /proc, so its path does need a table — but it's one `ps` call for
// the whole machine, not one syscall per process, so the threadpool concern
// above doesn't apply. Returns pid -> { pid, ppid, comm }.
async function scanProcessTable() {
  const table = new Map();

  if (process.platform === "darwin") {
    try {
      const out = await new Promise((resolve, reject) => {
        execFile("ps", ["-Ao", "pid=,ppid=,comm="], (err, stdout) =>
          err ? reject(err) : resolve(stdout)
        );
      });
      for (const line of out.split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (!m) continue;
        // `comm` here is the executable path; the basename is what a provider
        // matches on, matching Linux's shorter form.
        table.set(Number(m[1]), {
          pid: Number(m[1]),
          ppid: Number(m[2]),
          comm: path.basename(m[3].trim()),
        });
      }
    } catch (_) {
      // ps missing or refused — no table, no session detection.
    }
    return table;
  }

  // Linux walks the kernel's child lists instead (see linuxChildren); Windows
  // has no cheap equivalent at all, so panes there restore as plain shells.
  return table;
}

// Descendants of one shell, breadth-first. `table` is the macOS process table;
// on Linux it's unused and the kernel's per-pid child lists are walked directly.
// Capped so a pathological tree (a fork bomb, a pid-reuse cycle) can't turn a
// background poll into an unbounded walk.
const MAX_DESCENDANTS = 64;

async function descendantsOf(rootPid, table) {
  const found = [];
  const queue = [rootPid];
  const seen = new Set(queue);

  while (queue.length && found.length < MAX_DESCENDANTS) {
    const pid = queue.shift();

    if (process.platform === "linux") {
      for (const childPid of await linuxChildren(pid)) {
        if (seen.has(childPid)) continue;
        seen.add(childPid);
        const comm = await linuxComm(childPid);
        // No comm means it exited between being listed and being read.
        if (comm !== null) found.push({ pid: childPid, ppid: pid, comm });
        queue.push(childPid);
      }
      continue;
    }

    for (const child of table.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push(child);
      queue.push(child.pid);
    }
  }

  return found;
}

// The full command line of a process, for providers that need to tell two uses
// of the same binary apart. Null whenever it can't be read.
async function processArgs(pid) {
  try {
    if (process.platform === "linux") {
      const raw = await fs.promises.readFile(`/proc/${pid}/cmdline`, "utf8");
      return raw.split("\0").filter(Boolean).join(" ");
    }
    if (process.platform === "darwin") {
      return await new Promise((resolve) => {
        execFile("ps", ["-o", "args=", "-p", String(pid)], (err, stdout) =>
          resolve(err ? null : stdout.trim())
        );
      });
    }
  } catch (_) {
    // Gone or unreadable.
  }
  return null;
}

// Descendants of each pty's shell, breadth-first, as { [ptyId]: [proc, ...] }.
// The shell itself is excluded — a provider is looking for what's *running in*
// the pane, and the shell is the pane.
ipcMain.handle("pty-descendants", async (_event, ids) => {
  const result = {};
  if (!Array.isArray(ids) || ids.length === 0) return result;

  if (process.platform === "win32") return result;

  // macOS builds its pid -> children index once for every pane; Linux doesn't
  // need one (descendantsOf walks the kernel's lists directly).
  let children = new Map();
  if (process.platform === "darwin") {
    const table = await scanProcessTable();
    if (table.size === 0) return result;
    for (const proc of table.values()) {
      const siblings = children.get(proc.ppid);
      if (siblings) siblings.push(proc);
      else children.set(proc.ppid, [proc]);
    }
  }

  for (const id of ids) {
    const instance = ptyInstances.get(id);
    if (!instance || instance.disposed || !instance.process.pid) continue;

    const found = await descendantsOf(instance.process.pid, children);

    // Command lines are read one at a time rather than with Promise.all, for
    // the same threadpool reason as above — and `found` is a handful of
    // processes, so the sequencing costs nothing measurable.
    const procs = [];
    for (const p of found) {
      procs.push({
        pid: p.pid,
        ppid: p.ppid,
        comm: p.comm,
        args: await processArgs(p.pid),
        cwd: await processCwd(p.pid),
      });
    }
    result[id] = procs;
  }

  return result;
});

// Named environment variables of a process. Named, never bulk: a shell's
// environment routinely holds API tokens and ssh material, and none of that has
// any business crossing into the renderer just because something wanted to know
// which session was running. Requests for anything that looks like a secret are
// refused here rather than filtered at the call site.
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const ENV_SECRET_RE = /(TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|CREDENTIAL|AUTH)/;

ipcMain.handle("read-process-env", async (_event, pid, names) => {
  const out = {};
  if (!Number.isInteger(pid) || !Array.isArray(names)) return out;

  const wanted = names.filter(
    (n) => typeof n === "string" && ENV_NAME_RE.test(n) && !ENV_SECRET_RE.test(n)
  );
  if (wanted.length === 0) return out;

  let raw = null;
  try {
    if (process.platform === "linux") {
      raw = await fs.promises.readFile(`/proc/${pid}/environ`, "utf8");
    } else if (process.platform === "darwin") {
      // `ps -E` prints the environment after the command, space-separated. Only
      // works for processes this user owns, which is exactly our case; when the
      // OS refuses, providers fall back to whatever else they have.
      const out2 = await new Promise((resolve) => {
        execFile("ps", ["-Eo", "command=", "-p", String(pid)], (err, stdout) =>
          resolve(err ? null : stdout)
        );
      });
      raw = out2 ? out2.replace(/ /g, "\0") : null;
    }
  } catch (_) {
    // Process gone or environ unreadable (it's mode 0400, owner-only).
  }
  if (!raw) return out;

  for (const pair of raw.split("\0")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq);
    if (wanted.includes(key)) out[key] = pair.slice(eq + 1);
  }
  return out;
});

// === Filesystem IPC ===

ipcMain.handle("get-home-path", () => {
  return os.homedir();
});

// A directory listing with modification times — the plain read-dir the file tree
// uses doesn't stat, and providers need mtimes to tell which of several session
// files is the live one. Missing directory = empty list, not an error: "this
// tool has never run here" is the common answer.
ipcMain.handle("read-dir-stats", async (_event, dirPath) => {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const stats = await Promise.all(
      entries.map(async (e) => {
        try {
          const s = await fs.promises.stat(path.join(dirPath, e.name));
          return { name: e.name, isDirectory: e.isDirectory(), mtimeMs: s.mtimeMs };
        } catch (_) {
          return null; // vanished between readdir and stat
        }
      })
    );
    return stats.filter(Boolean);
  } catch (_) {
    return [];
  }
});

// This machine's name, used to tell a local OSC 7 report from one arriving over
// ssh — the sequence carries the host that produced it, and a remote path is
// meaningless locally. See registerCwdHandler in src/lib/osc.ts.
ipcMain.handle("get-hostname", () => {
  return os.hostname();
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

// The tab a tear-off handed this window. Read once, on mount, and only by a
// window whose boot flags said one is waiting — everything else it needs to
// know came in through its launch arguments.
ipcMain.handle("take-window-init", (event) => {
  const id = event.sender.id;
  const init = windowInit.get(id) ?? { tabs: [] };
  windowInit.delete(id);
  return init;
});

// Collected by the preload, synchronously, before the renderer's first line runs.
// Synchronous on purpose: the window's first tab is built from this, and the one
// startup property worth protecting is that nothing sits in front of the first
// shell. It costs a blocking IPC on exactly the launches that are restoring
// something, and the answer is already in memory here.
ipcMain.on("window-restore-sync", (event) => {
  // Deliberately *not* consumed on read. A preload runs once per document load, and
  // a window gets more than one — so deleting the payload here handed it to the
  // first run and `null` to the second, which is the one the renderer ended up
  // with. It is dropped when the window closes instead. Answering a renderer
  // *reload* with the same layout is harmless: the store refuses to restore across
  // a reload anyway, because the previous shells are still running.
  event.returnValue = windowRestore.get(event.sender.id) ?? null;
});

ipcMain.handle("new-window", () => {
  raise(createWindow());
});

// The keyboard route out. `before-quit` does the rest: it sets `quitting`, which
// stops the close handler from turning this into a detach, and kills the parked
// shells.
ipcMain.handle("quit-app", () => {
  app.quit();
});

// === Window controls =======================================================
// With the tab bar acting as the title bar there is no frame to click, so the
// minimise/maximise/close buttons it draws come back here.

ipcMain.handle("window-minimize", (event) => {
  windowOf(event)?.minimize();
});

ipcMain.handle("window-toggle-maximize", (event) => {
  const win = windowOf(event);
  if (!win) return false;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  // The state as it actually is, not as it was asked to be. Maximising goes through
  // the window manager and it is entitled to refuse (or not exist — a bare X server
  // with no WM simply ignores it), and reporting the request back would leave the
  // button saying "Restore" over a window that never moved. The maximize/unmaximize
  // events are the real authority; this is just the immediate answer.
  return win.isMaximized();
});

// Deliberately `close()`, not `destroy()`: this is the same gesture as the X on a
// native frame, so it goes through the detach path like any other close.
ipcMain.handle("window-close", (event) => {
  windowOf(event)?.close();
});

ipcMain.handle("window-is-maximized", (event) => {
  return windowOf(event)?.isMaximized() ?? false;
});

// Whether this window has no frame of its own, so the renderer knows to draw the
// controls. Not the same question as the setting: macOS keeps its traffic lights,
// and a window created before the setting changed still has whatever it was born
// with.
ipcMain.handle("window-draws-own-controls", () => {
  return process.platform !== "darwin" && sessionPrefs.customTitleBar;
});

// === Saved screens (the picture half of session restore) ====================
//
// The *layout* of a saved session — tabs, splits, directories, names — stays in
// the renderer's localStorage, because it has to be read synchronously at boot,
// before anything renders and therefore before the first shell spawns. Asking us
// for it would put a round trip in front of every launch, which is the cost this
// app deliberately doesn't pay (see WindowBoot in backends/types.ts).
//
// The *screens* belong here instead, and localStorage was the wrong home for
// them on three counts:
//
//   - It is synchronous, on the thread that draws the terminal. Reading a couple
//     of megabytes back sat squarely in front of the first paint.
//   - The quota is ~5MB for the whole origin, shared with settings, themes,
//     favourites, the closed-tab stack and markdown drafts. Screens could never
//     have a real budget there, which is why the renderer had to cap them hard
//     and shed entries on a failed write.
//   - It bills UTF-16 code units, so a "2MB" string could cost 4MB of that
//     shared quota — a cap counted in characters was quietly wrong.
//
// On disk none of that applies: no shared quota, bytes are bytes, and the write
// is off the renderer's thread entirely.
function screensPath() {
  return path.join(app.getPath("userData"), "session-screens.json");
}

function sessionPath() {
  return path.join(app.getPath("userData"), "session.json");
}

// The two session settings this process has to know *before* any renderer exists:
// how many windows to open at launch, and whether closing one detaches it. They
// belong to the user and live in the renderer's settings, so they are mirrored here
// whenever the renderer pushes them, and read back at boot when there is nobody to
// ask.
function prefsPath() {
  return path.join(app.getPath("userData"), "session-prefs.json");
}

let sessionPrefs = { restoreLastSession: true, customTitleBar: true };

function loadSessionPrefs() {
  try {
    const parsed = JSON.parse(fs.readFileSync(prefsPath(), "utf8"));
    if (typeof parsed?.restoreLastSession === "boolean") {
      sessionPrefs.restoreLastSession = parsed.restoreLastSession;
    }
    if (typeof parsed?.backgroundSessions === "boolean") {
      backgroundSessions = parsed.backgroundSessions;
    }
    if (typeof parsed?.customTitleBar === "boolean") {
      sessionPrefs.customTitleBar = parsed.customTitleBar;
    }
  } catch (_) {
    // No file yet, or unreadable — the defaults above are the right answer.
  }
}

function saveSessionPrefs() {
  try {
    fs.writeFileSync(
      prefsPath(),
      JSON.stringify({
        restoreLastSession: sessionPrefs.restoreLastSession,
        backgroundSessions,
        customTitleBar: sessionPrefs.customTitleBar,
      }),
      "utf8"
    );
  } catch (_) {
    // Not worth failing a settings change over; the defaults still apply.
  }
}

// Every window worth reopening: the ones still on screen, and the ones that were
// detached into the background. Both are things the user hadn't finished with.
function collectSessionWindows() {
  const windowsOut = [];
  for (const win of openWindows()) {
    const layout = windowLayouts.get(win.webContents.id);
    if (!layout?.tabs?.length) continue;
    windowsOut.push({
      tabs: layout.tabs,
      activeTabIndex: layout.activeTabIndex ?? 0,
      // Read now rather than from the layout: the window may have been moved or
      // resized since its last store write, and neither touches the tab state.
      bounds: win.getBounds(),
    });
  }
  for (const parked of parkedLayouts) {
    if (!parked?.tabs?.length) continue;
    windowsOut.push(parked);
  }
  return windowsOut;
}

// Written synchronously, on the way out. Synchronous because this is `before-quit`
// and the process is about to stop — an async write has nobody left to finish it —
// and it costs nothing here: this is the main process, not the thread drawing a
// terminal, and the payload is kilobytes.
function writeSessionFile() {
  try {
    const windowsOut = collectSessionWindows();
    if (!windowsOut.length) {
      fs.rmSync(sessionPath(), { force: true });
      return;
    }
    fs.writeFileSync(
      sessionPath(),
      JSON.stringify({ version: 2, savedAt: Date.now(), windows: windowsOut }),
      "utf8"
    );
  } catch (err) {
    console.warn("[session] writing the session failed:", err?.message ?? err);
  }
}

function readSessionFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionPath(), "utf8"));
    if (!parsed || parsed.version !== 2 || !Array.isArray(parsed.windows)) return [];
    // Shape-checked properly on the renderer side, which already has the validators
    // for a tab snapshot and has to distrust this blob anyway. Here it only needs to
    // be an array of things with tabs in them, so we know how many windows to open.
    return parsed.windows.filter(
      (w) => w && Array.isArray(w.tabs) && w.tabs.length > 0
    );
  } catch (_) {
    return [];
  }
}

// How many windows a saved session may reopen. A backstop against a corrupt or
// hand-edited file trying to open hundreds; nobody works with more than a handful.
const MAX_RESTORED_WINDOWS = 12;

// Bring a saved session back: one window per saved window, each where it was, each
// handed its own layout. Returns how many it opened.
function restoreSessionWindows() {
  if (!sessionPrefs.restoreLastSession) return 0;
  const saved = readSessionFile().slice(0, MAX_RESTORED_WINDOWS);
  let opened = 0;
  for (const w of saved) {
    createWindow({
      restore: { tabs: w.tabs, activeTabIndex: w.activeTabIndex ?? 0 },
      bounds: sanitizeBounds(w.bounds),
    });
    opened++;
  }
  return opened;
}

// A saved rectangle is only usable if it still lands on a display that exists —
// unplug the monitor a window was on and restoring its bounds would put it
// somewhere unreachable. Anything that doesn't fit is dropped, and the window opens
// at the default size instead.
function sanitizeBounds(bounds) {
  if (
    !bounds ||
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    bounds.width < 300 ||
    bounds.height < 200
  ) {
    return undefined;
  }
  const displays = screen.getAllDisplays();
  const onScreen = displays.some((d) => {
    const a = d.workArea;
    // The title bar has to be grabbable: require the window's top-left corner to
    // sit inside a work area, not merely to overlap it somewhere.
    return (
      bounds.x >= a.x - 40 &&
      bounds.y >= a.y - 10 &&
      bounds.x < a.x + a.width - 100 &&
      bounds.y < a.y + a.height - 60
    );
  });
  return onScreen ? bounds : undefined;
}

// Pushed by each renderer on the debounce that already batches its store writes.
ipcMain.on("session:layout", (event, payload) => {
  if (!payload || !Array.isArray(payload.tabs)) {
    windowLayouts.delete(event.sender.id);
    return;
  }
  windowLayouts.set(event.sender.id, {
    tabs: payload.tabs,
    activeTabIndex: payload.activeTabIndex ?? 0,
  });
});

ipcMain.on("session:prefs", (_event, prefs) => {
  if (typeof prefs?.restoreLastSession === "boolean") {
    sessionPrefs.restoreLastSession = prefs.restoreLastSession;
  }
  // Read at window-creation time, so a change takes effect on the next window
  // rather than the current one — a frame can't be added to or taken off a live
  // BrowserWindow.
  if (typeof prefs?.customTitleBar === "boolean") {
    sessionPrefs.customTitleBar = prefs.customTitleBar;
  }
  if (typeof prefs?.backgroundSessions === "boolean") {
    backgroundSessions = prefs.backgroundSessions;
  }
  saveSessionPrefs();
});

// Generous rather than absent. The renderer's own serialization is bounded by
// xterm's scrollback (1000 rows a pane), so these are a backstop against a
// pathological blob filling someone's disk, not a budget anyone should feel.
const MAX_SCREEN_FILE_BYTES = 32 * 1024 * 1024;

async function writeScreensToDisk(screens) {
  try {
    if (!screens || typeof screens !== "object") {
      await fs.promises.rm(screensPath(), { force: true });
      return;
    }
    const body = JSON.stringify({ version: 1, screens });
    if (body.length > MAX_SCREEN_FILE_BYTES) return;
    // Write-then-rename, so a crash mid-write leaves the previous screens intact
    // rather than a truncated file that parses to nothing.
    const target = screensPath();
    const tmp = `${target}.tmp`;
    await fs.promises.writeFile(tmp, body, "utf8");
    await fs.promises.rename(tmp, target);
  } catch (err) {
    // Disk full, permissions, a userData dir that vanished. The layout snapshot
    // is unaffected, so the session still restores — without its scrollback.
    console.warn("[session] writing screens failed:", err?.message ?? err);
  }
}

// Fired by a window on its way out, which is why it is `on` and not `handle`:
// there is no renderer left to receive a reply, and this process is still here to
// finish the job.
ipcMain.on("session:write-screens-async", (_event, screens) => {
  void writeScreensToDisk(screens);
});

ipcMain.handle("session:read-screens", async () => {
  try {
    const raw = await fs.promises.readFile(screensPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || typeof parsed.screens !== "object") {
      return {};
    }
    return parsed.screens ?? {};
  } catch (_) {
    // No file yet (the common case on a first run), or an unreadable one.
    return {};
  }
});

// Whether closing a window should detach it. The renderer owns the setting; this
// is the push that keeps the close handler in step with it.
ipcMain.on("set-background-sessions", (_event, enabled) => {
  backgroundSessions = enabled !== false;
  saveSessionPrefs();
});

// Reattach a parked session into a window. The tray is the obvious route, but it
// can't be the only one: a desktop may give us no status bar to put an icon in
// (some Wayland compositors), and with another window already open the tray is
// otherwise the single way back to a session detached behind it. Also on the
// Window menu, so it's discoverable and keyboard-reachable.
ipcMain.handle("reattach-session", () => {
  if (detachedSessions.length === 0) return false;
  reattachSession();
  return true;
});

// How many sessions are parked — so the UI can offer the reattach only when there
// is something to reattach.
ipcMain.handle("detached-session-count", () => detachedSessions.length);

// The detach half of a close: like release-pty, but with no reclaim deadline.
//
// That difference is the whole reason this exists. A released PTY is reaped after
// TRANSIT_RECLAIM_MS because an unclaimed one means a tear-off broke. A *detached*
// PTY has no deadline at all — it is waiting for the user to come back, which may
// be tomorrow — so the timer must not be armed, and it's marked so an explicit
// Quit can find it.
ipcMain.handle("detach-ptys", (event, ids) => {
  const claimed = detachedButUnparked.get(event.sender.id) ?? new Set();
  for (const id of Array.isArray(ids) ? ids : [ids]) {
    const instance = ptyInstances.get(id);
    if (!instance) continue;
    clearTransitTimer(instance);
    instance.wc = null;
    instance.detached = true;
    instance.pending = [];
    instance.pendingBytes = 0;
    claimed.add(id);
  }
  detachedButUnparked.set(event.sender.id, claimed);
});

// A window reporting that it has handed everything over and can now be closed.
//
// This is the second half of the intercepted close above, and it is also the only
// place a window is really destroyed on that path — including when the payload is
// empty (nothing worth keeping, or the renderer failed to build one), because a
// close that was cancelled has to complete either way.
ipcMain.handle("park-session", (event, payload) => {
  const win = windowOf(event);
  const tabs = payload?.tabs;
  // Whatever this window detached is now owned by the session about to be parked,
  // so it is no longer at risk of being reaped as an orphan.
  detachedButUnparked.delete(event.sender.id);
  if (Array.isArray(tabs) && tabs.length) {
    const bounds = win && !win.isDestroyed() ? win.getBounds() : undefined;
    const layout = windowLayouts.get(event.sender.id);
    detachedSessions.push({
      tabs,
      // Reattach where it was. A session that comes back in a different corner of
      // the screen than it left reads as a new window, not the one you closed.
      bounds,
      // The layout this window last reported, carried alongside the live PTYs. It
      // is what makes a detached window part of the *saved* session too: if this
      // process dies before anyone reattaches, the shells go, but the next launch
      // still reopens the window with its tabs and directories.
      layout: layout?.tabs?.length
        ? { tabs: layout.tabs, activeTabIndex: layout.activeTabIndex ?? 0, bounds }
        : null,
    });
    if (layout?.tabs?.length) {
      parkedLayouts.push({
        tabs: layout.tabs,
        activeTabIndex: layout.activeTabIndex ?? 0,
        bounds,
      });
    }
    updateTray();
  }
  if (win && !win.isDestroyed()) win.destroy();
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
      raise(win);
      return;
    }
  }

  raise(createWindow({ tab, bounds: windowBoundsAt(point) }));
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

// How many panes are waiting on the user, shown outside the window — the point
// of the badge is the case where the window isn't the one you're looking at.
//
// Two mechanisms, because no single one covers the three platforms:
//   - setBadgeCount: the number on the macOS dock icon, and the Unity launcher
//     count on the Linux desktops that implement it. Silently false elsewhere,
//     which is why it isn't the only thing here.
//   - flashFrame: the taskbar-entry highlight on Windows and most Linux WMs
//     (macOS bounces the dock icon). Only ever raised while the window is
//     unfocused — flashing the window someone is already typing in is noise —
//     and always lowered when it isn't needed, since on Windows it otherwise
//     keeps flashing until the window is activated.
// Each window reports its own count, so they're kept per window: the flash belongs
// to the window whose panes are waiting, and the badge — which the OS has exactly
// one of — is their total. Before this, both halves read a `mainWindow` singleton
// that the multi-window work had already replaced with a Set, so every update threw
// and the taskbar flash never fired at all.
const attentionCounts = new Map();

ipcMain.handle("set-attention-badge", (event, count) => {
  const n = Number.isFinite(Number(count)) ? Math.max(0, Number(count)) : 0;
  attentionCounts.set(event.sender.id, n);

  let total = 0;
  for (const value of attentionCounts.values()) total += value;
  try {
    app.setBadgeCount(total);
  } catch (_) {
    /* No badge support on this desktop — the flash below still applies. */
  }

  const win = windowOf(event);
  if (!win || win.isDestroyed()) return;
  win.flashFrame(n > 0 && !win.isFocused());
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
          click: () => raise(createWindow()),
        },
        {
          // Enabled state is fixed at build time, and the menu is only rebuilt at
          // startup — so this stays clickable and simply does nothing when there
          // is no parked session, rather than being greyed out at the moment the
          // user needs it. reattachSession() falls back to a plain window, which
          // is a defensible answer to "reattach" with nothing to reattach.
          label: "Reattach Detached Session",
          click: () => reattachSession(),
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

  loadSessionPrefs();
  buildAppMenu();

  // One window per window that was open when the app last quit, each where it was.
  // Nothing here decides *what* goes in them beyond handing over the saved layout —
  // the renderer validates it and hydrates, exactly as it does for a tab handed over
  // by a tear-off.
  if (restoreSessionWindows() === 0) {
    // Nothing of ours to restore. This one window — and only this one — is allowed
    // to look for a session left behind by the version that kept it in the
    // renderer's localStorage, so an upgrade doesn't cost the user their tabs. A
    // ⌘N window must not: two windows both restoring the same legacy blob would
    // duplicate it.
    createWindow({ migrateLegacy: sessionPrefs.restoreLastSession });
  }
});

// An explicit Quit is the one thing that ends a detached session, so it is also
// the one place their shells are killed. Setting `quitting` first is what stops
// the close handler intercepting the windows on their way out — a Quit that got
// itself deferred into a detach would never finish.
app.on("before-quit", () => {
  quitting = true;
  // Before anything is torn down: the windows are still open, so their bounds are
  // still readable, and the layouts they pushed are still current.
  writeSessionFile();
  killDetachedPtys();
  updateTray();
});

// Safety net. Each window already kills its own PTYs and closes its own watcher
// on `closed`; what can still be here is a PTY caught mid-transfer between two
// windows, which has no owner to clean it up.
app.on("window-all-closed", () => {
  // Detached sessions are the reason to stay alive with no windows open: their
  // shells are still running and the tray is how you get back to them. Nothing
  // else is torn down here either — the PTYs are the point, and the watchers
  // belong to windows that already closed their own.
  if (!quitting && detachedSessions.length > 0) return;

  for (const [, instance] of ptyInstances) {
    clearTransitTimer(instance);
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
    // Clicking the dock icon with a session parked means "give me my shells
    // back", not "give me a blank terminal". Falls through to a plain window when
    // there is nothing parked.
    reattachSession();
  }
});
