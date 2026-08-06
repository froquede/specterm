const { contextBridge, ipcRenderer } = require("electron");

// What kind of window this is, stamped into our own launch arguments by the main
// process (see `additionalArguments` in main.cjs). Read here, at preload time,
// so the renderer has it before its first line runs — the first tab is built
// from it, and putting an IPC round trip in front of that would delay the shell
// of every launch.
//
// A window that somehow starts without the flag (an unexpected reload path, a
// backend that doesn't set it) falls back to the single-window answer: it owns
// the session and the update check, which is exactly right when it is the only
// window there is.
function readBootFlags() {
  const prefix = "--specterm-boot=";
  const arg = process.argv.find((a) => a.startsWith(prefix));
  if (arg) {
    const flags = {};
    for (const pair of arg.slice(prefix.length).split(",")) {
      const eq = pair.indexOf("=");
      if (eq > 0) flags[pair.slice(0, eq)] = pair.slice(eq + 1) === "1";
    }
    // Only trust a value that was actually there — a missing key means an older
    // host, or a shape we don't recognize, and the defaults below are safer.
    if ("ownsSession" in flags) {
      return {
        hasTab: flags.hasTab === true,
        autoCheckUpdates: flags.autoCheckUpdates === true,
        ownsSession: flags.ownsSession === true,
      };
    }
  }
  return { hasTab: false, autoCheckUpdates: true, ownsSession: true };
}

const windowBoot = readBootFlags();

contextBridge.exposeInMainWorld("specterm", {
  // Plain data, not a function: there is nothing to ask anyone.
  windowBoot,

  // PTY
  spawnPty: (opts) => ipcRenderer.invoke("spawn-pty", opts),

  writePty: (id, data) => ipcRenderer.invoke("write-pty", id, data),

  resizePty: (id, cols, rows) => ipcRenderer.invoke("resize-pty", id, cols, rows),

  killPty: (id) => ipcRenderer.invoke("kill-pty", id),

  // Tear-off handover: the source window releases its PTYs (they keep running,
  // buffering output, with no owner), the destination window adopts them and
  // gets whatever was buffered in between as the return value.
  releasePty: (ids) => ipcRenderer.invoke("release-pty", ids),

  adoptPty: (id, cols, rows) => ipcRenderer.invoke("adopt-pty", id, cols, rows),
  ptyCwd: (id) => ipcRenderer.invoke("pty-cwd", id),

  // What's running inside each pane, and named env vars off a process, for the
  // session providers. See the handlers in main.cjs for why both are narrow.
  ptyDescendants: (ids) => ipcRenderer.invoke("pty-descendants", ids),

  readProcessEnv: (pid, names) =>
    ipcRenderer.invoke("read-process-env", pid, names),

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

  readDirStats: (path) => ipcRenderer.invoke("read-dir-stats", path),

  listDrives: () => ipcRenderer.invoke("list-drives"),

  revealInFileManager: (path, isDirectory) =>
    ipcRenderer.invoke("reveal-in-file-manager", path, isDirectory),

  clipboardHasImage: () => ipcRenderer.invoke("clipboard-has-image"),

  clipboardReadText: () => ipcRenderer.invoke("clipboard-read-text"),

  clipboardWriteText: (text) => ipcRenderer.invoke("clipboard-write-text", text),

  getHomePath: () => ipcRenderer.invoke("get-home-path"),

  getHostname: () => ipcRenderer.invoke("get-hostname"),

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

  setWindowOpacity: (value) => ipcRenderer.invoke("set-window-opacity", value),

  // Multi-window
  takeWindowInit: () => ipcRenderer.invoke("take-window-init"),

  newWindow: () => ipcRenderer.invoke("new-window"),

  closeWindow: () => ipcRenderer.invoke("close-window"),

  // Announce a released tear-off and learn where it is headed, before anything
  // is handed over: `{ toWindow: true }` means the cursor is over another
  // Specterm window, which is the only case in which giving away this window's
  // last tab makes sense.
  beginTransfer: () => ipcRenderer.invoke("begin-transfer"),

  // Hand a serialized tab to wherever the cursor let go: another Specterm
  // window if one is under it, otherwise a new window of its own.
  dropTransfer: (tab) => ipcRenderer.invoke("drop-transfer", tab),

  onAdoptTab: (cb) => {
    const handler = (_event, tab) => cb(tab);
    ipcRenderer.on("adopt-tab", handler);
    return () => ipcRenderer.removeListener("adopt-tab", handler);
  },

  // Fire-and-forget position report for a drag that has left this window, so the
  // host can light up whatever is under the cursor. `send`, not `invoke`: this
  // runs on pointermove and there is nothing to wait for.
  dragHover: () => ipcRenderer.send("drag-hover"),

  dragEnd: () => ipcRenderer.send("drag-end"),

  // This window is the one under a drag happening in another window.
  onDragOver: (cb) => {
    const handler = (_event, over) => cb(over);
    ipcRenderer.on("drag-over", handler);
    return () => ipcRenderer.removeListener("drag-over", handler);
  },

  // Cross-window state sync (settings, theme, favorites).
  broadcast: (channel, payload) =>
    ipcRenderer.send("broadcast", channel, payload),

  onBroadcast: (cb) => {
    const handler = (_event, channel, payload) => cb(channel, payload);
    ipcRenderer.on("broadcast", handler);
    return () => ipcRenderer.removeListener("broadcast", handler);
  },
  setAttentionBadge: (count) =>
    ipcRenderer.invoke("set-attention-badge", count),

  // Auto-update
  checkForUpdate: () => ipcRenderer.invoke("updater:check"),

  downloadUpdate: () => ipcRenderer.invoke("updater:download"),

  installUpdate: () => ipcRenderer.invoke("updater:install"),

  getCurrentVersion: () => ipcRenderer.invoke("updater:current-version"),

  onUpdaterEvent: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("updater:event", handler);
    return () => ipcRenderer.removeListener("updater:event", handler);
  },
});
