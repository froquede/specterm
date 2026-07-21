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

export interface Backend {
  // PTY
  spawnPty(opts: SpawnPtyOptions): Promise<number>;
  writePty(id: number, data: string): Promise<void>;
  resizePty(id: number, cols: number, rows: number): Promise<void>;
  killPty(id: number): Promise<void>;
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

  // Auto-update. checkForUpdate/downloadUpdate kick off async work whose
  // progress arrives via onUpdaterEvent; installUpdate quits and swaps in the
  // downloaded build. No-ops on backends that can't self-update.
  checkForUpdate(): Promise<void>;
  downloadUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  getCurrentVersion(): Promise<string>;
  onUpdaterEvent(cb: (event: UpdaterEvent) => void): Promise<UnlistenFn>;
}
