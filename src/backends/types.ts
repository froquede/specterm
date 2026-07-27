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

// State a window collects once, on mount.
export interface WindowInit {
  // A tab torn off another window that this one was created to host.
  tab: TransferTab | null;
  // Whether this window owns the single launch-time update check.
  autoCheckUpdates: boolean;
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
  onPtyOutput(cb: (id: number, data: Uint8Array) => void): Promise<UnlistenFn>;
  onPtyExit(cb: (id: number) => void): Promise<UnlistenFn>;

  // Filesystem
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, content: string): Promise<void>;
  readDir(path: string): Promise<FileEntry[]>;
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

  // Multi-window. Backends that only ever have one window return an inert
  // WindowInit, no-op the rest, and simply never fire onAdoptTab.
  //
  // What this window was created with — read once, on mount.
  takeWindowInit(): Promise<WindowInit>;
  // Open another window on the same app.
  newWindow(): Promise<void>;
  // Land a torn-off tab wherever the cursor released it: into another Specterm
  // window if one is under it, otherwise into a new window of its own. The host
  // decides, since only it can see the real cursor and every window's bounds.
  dropTransfer(tab: TransferTab): Promise<void>;
  // A tab another window tore off and dropped onto this one.
  onAdoptTab(cb: (tab: TransferTab) => void): Promise<UnlistenFn>;

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
