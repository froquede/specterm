const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("specterm", {
  // PTY
  spawnPty: (opts) => ipcRenderer.invoke("spawn-pty", opts),

  writePty: (id, data) => ipcRenderer.invoke("write-pty", id, data),

  resizePty: (id, cols, rows) => ipcRenderer.invoke("resize-pty", id, cols, rows),

  killPty: (id) => ipcRenderer.invoke("kill-pty", id),

  onPtyOutput: (cb) => {
    const handler = (_event, id, data) => cb(id, data);
    ipcRenderer.on("pty-output", handler);
    return () => ipcRenderer.removeListener("pty-output", handler);
  },

  onPtyExit: (cb) => {
    const handler = (_event, id) => cb(id);
    ipcRenderer.on("pty-exit", handler);
    return () => ipcRenderer.removeListener("pty-exit", handler);
  },

  // Filesystem
  readTextFile: (path) => ipcRenderer.invoke("read-text-file", path),

  writeTextFile: (path, content) =>
    ipcRenderer.invoke("write-text-file", path, content),

  readDir: (path) => ipcRenderer.invoke("read-dir", path),

  listDrives: () => ipcRenderer.invoke("list-drives"),

  clipboardHasImage: () => ipcRenderer.invoke("clipboard-has-image"),

  clipboardReadText: () => ipcRenderer.invoke("clipboard-read-text"),

  clipboardWriteText: (text) => ipcRenderer.invoke("clipboard-write-text", text),

  getHomePath: () => ipcRenderer.invoke("get-home-path"),

  watchDir: (path, cb) => {
    ipcRenderer.invoke("watch-dir", path);
    const handler = () => cb();
    ipcRenderer.on("fs-change", handler);
    return () => {
      ipcRenderer.removeListener("fs-change", handler);
      ipcRenderer.invoke("unwatch-dir");
    };
  },

  // A file the OS asked us to open (Finder "Open With", double-click, CLI arg).
  // The main process queues these until the renderer subscribes, then replays.
  onOpenPath: (cb) => {
    const handler = (_event, path) => cb(path);
    ipcRenderer.on("open-path", handler);
    return () => ipcRenderer.removeListener("open-path", handler);
  },

  // Window
  isFullscreen: () => ipcRenderer.invoke("is-fullscreen"),

  setFullscreen: (value) => ipcRenderer.invoke("set-fullscreen", value),

  onFullscreenChange: (cb) => {
    const handler = (_event, value) => cb(value);
    ipcRenderer.on("fullscreen-change", handler);
    return () => ipcRenderer.removeListener("fullscreen-change", handler);
  },
});
