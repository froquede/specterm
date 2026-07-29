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

export interface Backend {
  // PTY
  spawnPty(opts: SpawnPtyOptions): Promise<number>;
  writePty(id: number, data: string): Promise<void>;
  resizePty(id: number, cols: number, rows: number): Promise<void>;
  killPty(id: number): Promise<void>;
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
  // How many panes are waiting on the user (see stores/attention). Surfaced on
  // whatever the OS gives us to say so from outside the window — a dock badge,
  // a flashing taskbar entry — because a pane can be waiting while the whole
  // app is behind a browser. 0 clears it. A no-op wherever the platform has
  // nothing to show.
  setAttentionBadge(count: number): Promise<void>;

  // Auto-update. checkForUpdate/downloadUpdate kick off async work whose
  // progress arrives via onUpdaterEvent; installUpdate quits and swaps in the
  // downloaded build. No-ops on backends that can't self-update.
  checkForUpdate(): Promise<void>;
  downloadUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  getCurrentVersion(): Promise<string>;
  onUpdaterEvent(cb: (event: UpdaterEvent) => void): Promise<UnlistenFn>;
}
