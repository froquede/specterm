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
  readDir(path: string): Promise<FileEntry[]>;
  // Mounted Windows volumes; [] on macOS/Linux (single-root filesystems).
  listDrives(): Promise<DriveEntry[]>;
  onFsChange(cb: () => void): Promise<UnlistenFn>;
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
}
