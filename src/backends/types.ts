export type UnlistenFn = () => void;

export interface SpawnPtyOptions {
  cols: number;
  rows: number;
  cwd?: string;
}

export interface FileEntry {
  name: string;
  isDirectory: boolean;
}

// A directory entry with its modification time. Separate from FileEntry because
// the file tree lists directories constantly and has no use for a stat per
// entry; only the session providers need mtimes, to pick the live file out of a
// directory of them.
export interface FileEntryStats extends FileEntry {
  mtimeMs: number;
}

// A process running inside a pane, as seen from the host. `args` is the full
// command line where the platform can report one, null where it can't.
export interface ProcessInfo {
  pid: number;
  // The parent, so a caller can tell a process running *under* something it
  // found from one that merely shares the same shell. That distinction matters
  // for anything reading inherited environment variables.
  ppid: number;
  comm: string;
  args: string | null;
  // The process's own working directory, where the host can read it (Linux).
  // Worth having separately from the pane's: a shell's cached directory goes
  // stale while a full-screen program runs, and the program's own is exact.
  cwd: string | null;
}

// A mounted volume on Windows (e.g. { name: "C:", path: "C:\\" }). Empty on
// other platforms, which have a single "/" root.
export interface DriveEntry {
  name: string;
  path: string;
}

// Live status streamed from the host while an update check/download runs. Also
// the shape the renderer reduces into its Settings UI.
//   dev          — running unpackaged; no update feed available
//   checking     — a check is in flight
//   available    — a newer release exists (version = its tag)
//   not-available— already on the latest
//   progress     — download running (percent 0–100)
//   downloaded   — ready to install on restart
//   error        — something failed (message = why)
export type UpdaterStatus =
  | "dev"
  | "checking"
  | "available"
  | "not-available"
  | "progress"
  | "downloaded"
  | "error";

export interface UpdaterEvent {
  status: UpdaterStatus;
  version?: string;
  percent?: number;
  message?: string;
}

// A tab (or a single pane, as a one-leaf tab) in the form it travels between
// windows: no pane ids — the destination mints its own — and every terminal
// reduced to its live PTY plus a serialized copy of its screen and scrollback.
export type TransferPane =
  | { kind: "terminal"; ptyId: number; scrollback: string; title: string }
  | { kind: "markdown"; filePath: string }
  | { kind: "text"; filePath: string };

export type TransferNode =
  | { type: "leaf"; pane: TransferPane }
  | {
      type: "split";
      direction: "h" | "v";
      ratio: number;
      first: TransferNode;
      second: TransferNode;
    };

export interface TransferTab {
  title: string;
  manualTitle: boolean;
  root: TransferNode;
}

// What a window is, known *synchronously* — before the first paint, with no IPC.
//
// This exists for one reason: opening has to be instant. Deciding what goes in a
// window used to be free (there was only ever one, and it always got a plain
// terminal), and multi-window turned it into a question for the host. Asking
// over IPC would put a round trip in front of the first shell of every launch,
// which is exactly the cost the app can't afford. So the host stamps the answer
// into the window's own launch arguments, and the preload reads it back with no
// round trip at all — see `additionalArguments` in electron/main.cjs.
//
// Only the flags travel this way. A torn-off tab carries a serialized screen and
// has no business on a command line, so `hasTab` says one is waiting and the
// (async) takeWindowInit fetches it — a round trip nobody can perceive, since
// that window exists only because a drag just ended.
export interface WindowBoot {
  // Tabs are waiting in takeWindowInit() — handed over with their PTYs still
  // running, from a tear-off or a background session being reattached. Fetched
  // asynchronously: they can carry megabytes of serialized screen, and that window
  // exists only because a drag just ended.
  hasTabs: boolean;
  // Whether a saved layout was collected for this window. `restore` below is it.
  hasRestore: boolean;
  // This window's saved layout, already here — collected synchronously by the
  // preload before the renderer's first line ran, because the first tab is built
  // from it and nothing may sit in front of the first shell.
  restore: RestoreWindow | null;
  // Whether this window owns the single launch-time update check.
  autoCheckUpdates: boolean;
  // This one window may look for a session left in localStorage by the version
  // that kept it there, so an upgrade doesn't cost the user their tabs. Only ever
  // true for the single window opened at launch when the host had nothing of its
  // own to restore — two windows both migrating the same blob would duplicate it.
  migrateLegacy: boolean;
}

// A window's tabs as the host saved them: no live processes behind them, unlike a
// TransferTab. The renderer validates and hydrates this into fresh shells.
export interface RestoreWindow {
  tabs: unknown[];
  activeTabIndex: number;
}

// State a window collects once, on mount — the half that needs a round trip.
export interface WindowInit {
  // The tabs this window was created to host: one, for a tab torn off another
  // window, or all of them for a background session being reattached. Empty when
  // there is nothing waiting (which the boot flags already said, so this is only
  // ever read by a window that expects something).
  tabs: TransferTab[];
}

export interface Backend {
  // PTY
  spawnPty(opts: SpawnPtyOptions): Promise<number>;
  writePty(id: number, data: string): Promise<void>;
  resizePty(id: number, cols: number, rows: number): Promise<void>;
  killPty(id: number): Promise<void>;
  // Give up ownership of these PTYs without killing them — the handover half of
  // a tear-off. They keep running and buffer output until adoptPty claims them.
  releasePty(ids: number[]): Promise<void>;
  // Claim a released PTY for this window, resized to the adopting pane. Resolves
  // with the output buffered while it had no owner.
  adoptPty(
    id: number,
    cols: number,
    rows: number
  ): Promise<{ buffered: Uint8Array; exited: boolean }>;
  // The shell's live working directory, read from the OS process. null when the
  // pty is gone or the platform can't report it (Windows) — callers fall back
  // to the configured startup path rather than treating this as an error.
  ptyCwd(id: number): Promise<string | null>;
  onPtyOutput(cb: (id: number, data: Uint8Array) => void): Promise<UnlistenFn>;
  onPtyExit(cb: (id: number) => void): Promise<UnlistenFn>;

  // Process inspection, for the session providers (src/lib/session-providers).
  // Both answer emptily wherever the platform can't report — Windows, a hardened
  // process, one that exited mid-question — so a caller never has to distinguish
  // "nothing running" from "couldn't look".
  //
  // ptyDescendants takes every pane at once because the host answers them from a
  // single scan of the process table; asking per pane would multiply that cost
  // by the number of open terminals.
  ptyDescendants(ids: number[]): Promise<Record<number, ProcessInfo[]>>;
  // Only the named variables come back, and names that look like secrets are
  // refused host-side — a shell's environment is full of credentials that have
  // no reason to enter the renderer.
  readProcessEnv(
    pid: number,
    names: string[]
  ): Promise<Record<string, string>>;

  // Filesystem
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, content: string): Promise<void>;
  readDir(path: string): Promise<FileEntry[]>;
  // Same listing with modification times. Returns [] for a missing directory
  // rather than throwing — callers use it to ask "has anything happened here?".
  readDirStats(path: string): Promise<FileEntryStats[]>;
  // Mounted Windows volumes; [] on macOS/Linux (single-root filesystems).
  listDrives(): Promise<DriveEntry[]>;
  // Show a path in the OS file manager (Explorer/Finder/Nautilus). A directory
  // opens itself; a file is revealed selected in its containing folder.
  revealInFileManager(path: string, isDirectory: boolean): Promise<void>;
  onFsChange(cb: () => void): Promise<UnlistenFn>;
  // A file the OS asked the app to open (Finder "Open With", double-click, CLI
  // path arg). Fires once per file, replaying any that queued before subscribe.
  onOpenPath(cb: (path: string) => void): Promise<UnlistenFn>;
  getHomePath(): Promise<string>;
  /** This machine's hostname, for validating OSC 7 reports. */
  getHostname(): Promise<string>;
  // True when the OS clipboard holds an image — drives image-vs-text paste.
  clipboardHasImage(): Promise<boolean>;
  // OS text clipboard. Routed through the host (not navigator.clipboard) so
  // copy/paste is reliable regardless of document focus or permissions.
  clipboardReadText(): Promise<string>;
  clipboardWriteText(text: string): Promise<void>;

  // Window
  isFullscreen(): Promise<boolean>;
  setFullscreen(value: boolean): Promise<void>;
  onFullscreenChange(cb: (value: boolean) => void): Promise<UnlistenFn>;
  // Whole-window alpha (0–1); values below 1 let the desktop show through.
  // A no-op on backends/platforms that can't honor it.
  setWindowOpacity(value: number): Promise<void>;

  // --- Window controls ------------------------------------------------------
  //
  // The tab bar acts as the title bar, so on platforms where that means the window
  // has no frame of its own, it also draws the minimise/maximise/close buttons —
  // and they need somewhere to go. `drawsOwnWindowControls` is what decides whether
  // to draw them: it is a question about *this window*, not about the setting, since
  // macOS keeps its native traffic lights and a window created before the setting
  // changed still has whatever frame it was born with.
  drawsOwnWindowControls(): Promise<boolean>;
  minimizeWindow(): Promise<void>;
  /** Toggles, and resolves to whether the window ended up maximized. */
  toggleMaximizeWindow(): Promise<boolean>;
  /** The same gesture as the X on a native frame — so it detaches like any close. */
  closeWindow(): Promise<void>;
  isMaximized(): Promise<boolean>;
  // Fires when the window is maximized or restored, including from outside the app
  // (a WM keybinding, snapping).
  onMaximizedChange(cb: (maximized: boolean) => void): Promise<UnlistenFn>;
  // How many panes are waiting on the user (see stores/attention). Surfaced on
  // whatever the OS gives us to say so from outside the window — a dock badge,
  // a flashing taskbar entry — because a pane can be waiting while the whole
  // app is behind a browser. 0 clears it. A no-op wherever the platform has
  // nothing to show.
  setAttentionBadge(count: number): Promise<void>;

  // Multi-window. Backends that only ever have one window report a lone
  // session-owning window, no-op the rest, and simply never fire onAdoptTab.
  //
  // The torn-off tab this window was created to host. Only ever called when
  // windowBoot() (backends/index.ts — synchronous, so the first tab doesn't
  // wait on it) said one is waiting.
  takeWindowInit(): Promise<WindowInit>;
  // Open another window on the same app.
  newWindow(): Promise<void>;
  // End the whole app, detached sessions and all. Distinct from closing a window,
  // which with background sessions on parks it instead (see below).
  quitApp(): Promise<void>;
  // Land a torn-off tab wherever the cursor released it: into another Specterm
  // window if one is under it, otherwise into a new window of its own. The host
  // decides, since only it can see the real cursor and every window's bounds.
  dropTransfer(tab: TransferTab): Promise<void>;
  // A tab another window tore off and dropped onto this one.
  onAdoptTab(cb: (tab: TransferTab) => void): Promise<UnlistenFn>;

  // --- Detaching (closing a window without stopping its shells) -------------
  //
  // The host holds a closing window open until the renderer has serialized its
  // tabs and handed the PTYs over, then parks the payload until a window
  // reattaches it. Backends with no such notion never fire onDetachRequest, and
  // their windows close the way they always did.

  // Give up ownership of these PTYs with no reclaim deadline — they are waiting
  // for the user, not for a window that is already booting. (releasePty is the
  // tear-off version, and is reaped if nothing claims it.)
  detachPtys(ids: number[]): Promise<void>;
  // The host is closing this window and is waiting on us. Must always be
  // answered with parkSession, even with nothing to park.
  onDetachRequest(cb: () => void): Promise<UnlistenFn>;
  // Hand this window's tabs to the host to hold while it's closed, and let the
  // close complete. An empty list just completes the close.
  parkSession(tabs: TransferTab[]): Promise<void>;
  // Whether closing a window should detach it at all. The setting lives in the
  // renderer; the host has to decide in its close handler, so it's pushed.
  setBackgroundSessions(enabled: boolean): void;

  // --- The saved session ----------------------------------------------------
  //
  // The host assembles one entry per window and writes the lot on quit, which is
  // what makes quitting with three windows open bring three back. Each renderer
  // only ever reports its own.

  // This window's tabs, pushed on the renderer's existing save debounce.
  pushLayout(layout: { tabs: unknown[]; activeTabIndex: number } | null): void;
  // The two session settings the host needs before any window exists.
  pushSessionPrefs(prefs: {
    restoreLastSession: boolean;
    backgroundSessions: boolean;
    customTitleBar: boolean;
  }): void;
  // Bring a parked session back into a window. False when nothing was parked.
  reattachSession(): Promise<boolean>;

  // --- Saved screens --------------------------------------------------------
  //
  // A restored session's scrollback, held by the host rather than in the
  // renderer's localStorage (see lib/session-screens.ts for the three reasons).
  // Backends with nowhere to put it no-op the write and return nothing to read,
  // and a session then restores its layout without its screens.

  // Fire-and-forget: the one caller runs as the window is being torn down, where
  // an awaited round trip has no guarantee of finishing. `null` clears them.
  writeScreens(screens: Record<string, string> | null): Promise<void>;
  readScreens(): Promise<Record<string, string>>;
  // How many sessions are currently parked, so the UI can offer the reattach only
  // when there is one.
  detachedSessionCount(): Promise<number>;

  // Cross-window sync for state each window keeps its own copy of (settings,
  // theme, favorites): the writer persists, then tells everyone else to re-read.
  broadcast(channel: string, payload?: unknown): void;
  onBroadcast(
    cb: (channel: string, payload?: unknown) => void
  ): Promise<UnlistenFn>;

  // Auto-update. checkForUpdate/downloadUpdate kick off async work whose
  // progress arrives via onUpdaterEvent; installUpdate quits and swaps in the
  // downloaded build. No-ops on backends that can't self-update.
  checkForUpdate(): Promise<void>;
  downloadUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  getCurrentVersion(): Promise<string>;
  onUpdaterEvent(cb: (event: UpdaterEvent) => void): Promise<UnlistenFn>;
}
