const { contextBridge, ipcRenderer, webUtils } = require("electron");

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
    if ("hasTabs" in flags) {
      return {
        hasTabs: flags.hasTabs === true,
        hasRestore: flags.hasRestore === true,
        autoCheckUpdates: flags.autoCheckUpdates === true,
        ownControls: flags.ownControls === true,
        migrateLegacy: flags.migrateLegacy === true,
      };
    }
  }
  return {
    hasTabs: false,
    hasRestore: false,
    autoCheckUpdates: true,
    ownControls: false,
    migrateLegacy: false,
  };
}

const flags = readBootFlags();

// A saved layout for this window, collected here rather than asked for later.
//
// Synchronous, and that is the point: the renderer builds its first tab from this,
// and the one startup property worth protecting is that nothing — not even a
// microtask — sits in front of the first shell (see windowBoot in
// src/backends/index.ts). So it is pulled over a blocking channel at preload time,
// on exactly the launches that are restoring something, and handed to the renderer
// as plain data alongside the flags.
//
// Handed-over *tabs* deliberately do not come this way: they can carry megabytes of
// serialized screen, and the window receiving them exists only because a drag just
// ended, so that one can afford a round trip.
const windowBoot = {
  ...flags,
  restore: flags.hasRestore
    ? (() => {
        try {
          return ipcRenderer.sendSync("window-restore-sync");
        } catch (_) {
          // Older host, or a channel that isn't there — fall back to a plain window
          // rather than failing the launch.
          return null;
        }
      })()
    : null,
};

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

  // Detach handover: like releasePty, but with no reclaim deadline — a detached
  // shell is waiting for the user to come back, not for a window that is already
  // booting. See the "detach-ptys" handler in main.cjs.
  detachPtys: (ids) => ipcRenderer.invoke("detach-ptys", ids),
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
  //
  // Where a dropped File actually lives on disk. Electron ≥32 removed the
  // non-standard `File.path` the web used to expose, and webUtils only exists in
  // the preload — so a drop handler in the renderer has no other way to learn a
  // path. Synchronous (no IPC): the drop handler has to read the DataTransfer
  // before it is neutered.
  filePathFor: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch (_) {
      // Not a real OS file (a drag from inside a web page, say) — no path.
      return null;
    }
  },

  readTextFile: (path) => ipcRenderer.invoke("read-text-file", path),

  readFileTail: (path, maxBytes) =>
    ipcRenderer.invoke("read-file-tail", path, maxBytes),

  writeTextFile: (path, content) =>
    ipcRenderer.invoke("write-text-file", path, content),

  readDir: (path) => ipcRenderer.invoke("read-dir", path),

  readDirStats: (path) => ipcRenderer.invoke("read-dir-stats", path),

  listDrives: () => ipcRenderer.invoke("list-drives"),

  revealInFileManager: (path, isDirectory) =>
    ipcRenderer.invoke("reveal-in-file-manager", path, isDirectory),

  openExternal: (url) => ipcRenderer.invoke("open-external", url),

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

  // Window controls, for the frameless layout where the tab bar is the title bar.
  minimizeWindow: () => ipcRenderer.invoke("window-minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("window-toggle-maximize"),
  closeWindow: () => ipcRenderer.invoke("window-close"),
  isMaximized: () => ipcRenderer.invoke("window-is-maximized"),
  drawsOwnWindowControls: () => ipcRenderer.invoke("window-draws-own-controls"),

  onMaximizedChange: (cb) => {
    const handler = (_event, value) => cb(value);
    ipcRenderer.on("window-maximized", handler);
    return () => ipcRenderer.removeListener("window-maximized", handler);
  },

  // Multi-window
  takeWindowInit: () => ipcRenderer.invoke("take-window-init"),

  newWindow: () => ipcRenderer.invoke("new-window"),

  // Ends the app and every detached session with it — see the Alt+F4 binding in
  // stores/keymap.ts for why this needs a keyboard route.
  quitApp: () => ipcRenderer.invoke("quit-app"),

  // Saved screens live on disk, written by the main process — see the block in
  // main.cjs for why localStorage was the wrong home for megabytes captured at
  // teardown. `send`, not `invoke`: the write is fired as the window is going
  // away, and there is nobody left to await a reply. The main process outlives
  // the window, so it finishes the write on its own.
  writeScreens: (screens) => ipcRenderer.send("session:write-screens-async", screens),

  readScreens: () => ipcRenderer.invoke("session:read-screens"),

  // Hand a serialized tab to wherever the cursor let go: another Specterm
  // window if one is under it, otherwise a new window of its own.
  dropTransfer: (tab) => ipcRenderer.invoke("drop-transfer", tab),

  onAdoptTab: (cb) => {
    const handler = (_event, tab) => cb(tab);
    ipcRenderer.on("adopt-tab", handler);
    return () => ipcRenderer.removeListener("adopt-tab", handler);
  },

  // The host is closing this window and is holding the close until we hand our
  // shells over. Answer with parkSession — always, even with nothing to park, or
  // the window waits out the host's timeout before it disappears.
  onDetachRequest: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("detach-window", handler);
    return () => ipcRenderer.removeListener("detach-window", handler);
  },

  parkSession: (tabs) => ipcRenderer.invoke("park-session", { tabs }),

  // Bring a parked session back into a window. False when nothing was parked.
  reattachSession: () => ipcRenderer.invoke("reattach-session"),

  detachedSessionCount: () => ipcRenderer.invoke("detached-session-count"),


  setBackgroundSessions: (enabled) =>
    ipcRenderer.send("set-background-sessions", enabled),

  // The layout of this window's tabs, pushed on the renderer's own save debounce.
  // The host assembles every window's into the saved session and writes it on quit
  // — which is why quitting with three windows open now brings three back.
  pushLayout: (layout) => ipcRenderer.send("session:layout", layout),

  // The two session settings the host has to know before any window exists: how
  // many windows to reopen at launch, and whether closing one detaches it.
  pushSessionPrefs: (prefs) => ipcRenderer.send("session:prefs", prefs),

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
  notifyWaiting: (payload) => ipcRenderer.invoke("notify-waiting", payload),

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
