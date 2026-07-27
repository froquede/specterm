const { app, BrowserWindow, ipcMain, shell, Menu, clipboard, session, net } = require("electron");
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

  // Send genuinely external links to the default browser, but never hijack
  // in-app navigations. Comparing full URLs treated every same-origin reload
  // (the Vite dev server's, a trailing-slash difference, a hash change) as
  // "external" and fired openExternal + preventDefault on it — in dev that
  // preventing-then-reopening looped the browser and stalled the renderer.
  // Gate on origin instead: same-origin (and non-http, e.g. file://) stays in
  // the window; only a different http(s) origin goes out.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    let external = false;
    try {
      const target = new URL(url);
      const current = new URL(mainWindow.webContents.getURL());
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

function sendUpdaterEvent(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("updater:event", payload);
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
