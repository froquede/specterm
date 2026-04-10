const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const pty = require("node-pty");
const fs = require("fs");
const { watch } = require("chokidar");

// PTY instance management
const ptyInstances = new Map();
let nextPtyId = 1;
let mainWindow = null;
let fsWatcher = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "Specterm",
    backgroundColor: "#1a1b26",
    autoHideMenuBar: true,
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

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// === IPC Handlers ===

ipcMain.handle("spawn-pty", (_event, opts) => {
  const shell = process.env.SHELL || "/bin/bash";
  const id = nextPtyId++;

  const ptyProcess = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd || process.env.HOME || "/",
    env: Object.assign({}, process.env, {
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    }),
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
  return process.env.HOME || "/";
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

// === App lifecycle ===

app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");

app.whenReady().then(createWindow);

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
