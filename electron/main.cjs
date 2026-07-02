const { app, BrowserWindow, ipcMain, shell, Menu } = require("electron");
const path = require("path");
const os = require("os");
const pty = require("node-pty");
const fs = require("fs");
const { watch } = require("chokidar");

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

  // In dev, connect to Vite dev server; in prod, load built files
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

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

  const ptyProcess = pty.spawn(shell, args, {
    name: "xterm-256color",
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd || os.homedir(),
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

ipcMain.handle("read-dir", async (_event, dirPath) => {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  return entries.map((e) => ({
    name: e.name,
    isDirectory: e.isDirectory(),
  }));
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

app.whenReady().then(() => {
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
