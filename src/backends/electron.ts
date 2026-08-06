import type {
  Backend,
  SpawnPtyOptions,
  FileEntry,
  FileEntryStats,
  DriveEntry,
  ProcessInfo,
  UnlistenFn,
  UpdaterEvent,
  TransferTab,
  WindowInit,
} from "./types";

// The preload script exposes window.specterm via contextBridge
interface SpectermAPI {
  spawnPty(opts: SpawnPtyOptions): Promise<number>;
  writePty(id: number, data: string): Promise<void>;
  resizePty(id: number, cols: number, rows: number): Promise<void>;
  killPty(id: number): Promise<void>;
  releasePty(ids: number[]): Promise<void>;
  adoptPty(
    id: number,
    cols: number,
    rows: number
  ): Promise<{ buffered: Uint8Array; exited: boolean }>;
  ptyCwd(id: number): Promise<string | null>;
  ptyDescendants(ids: number[]): Promise<Record<number, ProcessInfo[]>>;
  readProcessEnv(pid: number, names: string[]): Promise<Record<string, string>>;
  onPtyOutput(cb: (id: number, data: Uint8Array) => void): () => void;
  onPtyExit(cb: (id: number) => void): () => void;
  filePathFor(file: File): string | null;
  readTextFile(path: string): Promise<string>;
  readFileTail(path: string, maxBytes: number): Promise<string>;
  writeTextFile(path: string, content: string): Promise<void>;
  readDir(path: string): Promise<FileEntry[]>;
  readDirStats(path: string): Promise<FileEntryStats[]>;
  listDrives(): Promise<DriveEntry[]>;
  revealInFileManager(path: string, isDirectory: boolean): Promise<void>;
  openExternal(url: string): Promise<void>;
  clipboardHasImage(): Promise<boolean>;
  clipboardReadText(): Promise<string>;
  clipboardWriteText(text: string): Promise<void>;
  watchDir(path: string, cb: () => void): () => void;
  onOpenPath(cb: (path: string) => void): () => void;
  getHomePath(): Promise<string>;
  getHostname(): Promise<string>;
  isFullscreen(): Promise<boolean>;
  setFullscreen(value: boolean): Promise<void>;
  onFullscreenChange(cb: (value: boolean) => void): () => void;
  setWindowOpacity(value: number): Promise<void>;
  drawsOwnWindowControls(): Promise<boolean>;
  minimizeWindow(): Promise<void>;
  toggleMaximizeWindow(): Promise<boolean>;
  closeWindow(): Promise<void>;
  isMaximized(): Promise<boolean>;
  onMaximizedChange(cb: (maximized: boolean) => void): () => void;
  // Plain data read from the window's launch arguments by the preload — no IPC.
  // Consumed by windowBoot() in backends/index.ts, not through this class.
  windowBoot: unknown;
  takeWindowInit(): Promise<WindowInit>;
  newWindow(): Promise<void>;
  quitApp(): Promise<void>;
  dropTransfer(tab: TransferTab): Promise<void>;
  onAdoptTab(cb: (tab: TransferTab) => void): () => void;
  detachPtys(ids: number[]): Promise<void>;
  onDetachRequest(cb: () => void): () => void;
  parkSession(tabs: TransferTab[]): Promise<void>;
  setBackgroundSessions(enabled: boolean): void;
  pushLayout(layout: { tabs: unknown[]; activeTabIndex: number } | null): void;
  pushSessionPrefs(prefs: {
    restoreLastSession: boolean;
    backgroundSessions: boolean;
    customTitleBar: boolean;
  }): void;
  reattachSession(): Promise<boolean>;
  detachedSessionCount(): Promise<number>;
  writeScreens(screens: Record<string, string> | null): void;
  readScreens(): Promise<Record<string, string>>;
  beginTransfer(): Promise<{ toWindow: boolean }>;
  dragHover(): void;
  dragEnd(): void;
  onDragOver(cb: (over: boolean) => void): () => void;
  broadcast(channel: string, payload?: unknown): void;
  onBroadcast(cb: (channel: string, payload?: unknown) => void): () => void;
  setAttentionBadge(count: number): Promise<void>;
  notifyWaiting(payload: { title: string; body: string }): Promise<void>;
  checkForUpdate(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  installUpdate(): Promise<void>;
  getCurrentVersion(): Promise<string>;
  onUpdaterEvent(cb: (event: UpdaterEvent) => void): () => void;
}

declare global {
  interface Window {
    specterm: SpectermAPI;
  }
}

export class ElectronBackend implements Backend {
  private get api(): SpectermAPI {
    return window.specterm;
  }

  async spawnPty(opts: SpawnPtyOptions): Promise<number> {
    return this.api.spawnPty(opts);
  }

  async writePty(id: number, data: string): Promise<void> {
    return this.api.writePty(id, data);
  }

  async resizePty(id: number, cols: number, rows: number): Promise<void> {
    return this.api.resizePty(id, cols, rows);
  }

  async killPty(id: number): Promise<void> {
    return this.api.killPty(id);
  }

  async releasePty(ids: number[]): Promise<void> {
    return this.api.releasePty(ids);
  }

  async adoptPty(
    id: number,
    cols: number,
    rows: number
  ): Promise<{ buffered: Uint8Array; exited: boolean }> {
    // Same as onPtyOutput: the host answers with a Buffer, which arrives here
    // as a Uint8Array already.
    return this.api.adoptPty(id, cols, rows);
  }

  async ptyCwd(id: number): Promise<string | null> {
    return this.api.ptyCwd(id);
  }

  async ptyDescendants(
    ids: number[]
  ): Promise<Record<number, ProcessInfo[]>> {
    return this.api.ptyDescendants(ids);
  }

  async readProcessEnv(
    pid: number,
    names: string[]
  ): Promise<Record<string, string>> {
    return this.api.readProcessEnv(pid, names);
  }

  async onPtyOutput(
    cb: (id: number, data: Uint8Array) => void
  ): Promise<UnlistenFn> {
    // Straight through. The host sends a Buffer and structured clone delivers it
    // as a Uint8Array, so there is nothing left to convert — re-wrapping it
    // would copy every byte of every chunk a shell ever prints, for nothing.
    return this.api.onPtyOutput(cb);
  }

  async onPtyExit(cb: (id: number) => void): Promise<UnlistenFn> {
    return this.api.onPtyExit(cb);
  }

  filePathFor(file: File): string | null {
    return this.api.filePathFor(file);
  }

  async readTextFile(path: string): Promise<string> {
    return this.api.readTextFile(path);
  }

  async readFileTail(path: string, maxBytes: number): Promise<string> {
    return this.api.readFileTail(path, maxBytes);
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    return this.api.writeTextFile(path, content);
  }

  async readDir(path: string): Promise<FileEntry[]> {
    return this.api.readDir(path);
  }

  async readDirStats(path: string): Promise<FileEntryStats[]> {
    return this.api.readDirStats(path);
  }

  async listDrives(): Promise<DriveEntry[]> {
    return this.api.listDrives();
  }

  async openExternal(url: string): Promise<void> {
    return this.api.openExternal(url);
  }

  async revealInFileManager(path: string, isDirectory: boolean): Promise<void> {
    return this.api.revealInFileManager(path, isDirectory);
  }

  async clipboardHasImage(): Promise<boolean> {
    return this.api.clipboardHasImage();
  }

  async clipboardReadText(): Promise<string> {
    return this.api.clipboardReadText();
  }

  async clipboardWriteText(text: string): Promise<void> {
    return this.api.clipboardWriteText(text);
  }

  async onFsChange(cb: () => void): Promise<UnlistenFn> {
    const home = await this.getHomePath();
    return this.api.watchDir(home, cb);
  }

  async onOpenPath(cb: (path: string) => void): Promise<UnlistenFn> {
    return this.api.onOpenPath(cb);
  }

  async getHomePath(): Promise<string> {
    return this.api.getHomePath();
  }

  async getHostname(): Promise<string> {
    return this.api.getHostname();
  }

  async isFullscreen(): Promise<boolean> {
    return this.api.isFullscreen();
  }

  async setFullscreen(value: boolean): Promise<void> {
    return this.api.setFullscreen(value);
  }

  async onFullscreenChange(
    cb: (value: boolean) => void
  ): Promise<UnlistenFn> {
    return this.api.onFullscreenChange(cb);
  }

  async setWindowOpacity(value: number): Promise<void> {
    return this.api.setWindowOpacity(value);
  }

  async drawsOwnWindowControls(): Promise<boolean> {
    return this.api.drawsOwnWindowControls();
  }

  async minimizeWindow(): Promise<void> {
    return this.api.minimizeWindow();
  }

  async toggleMaximizeWindow(): Promise<boolean> {
    return this.api.toggleMaximizeWindow();
  }

  async closeWindow(): Promise<void> {
    return this.api.closeWindow();
  }

  async isMaximized(): Promise<boolean> {
    return this.api.isMaximized();
  }

  async onMaximizedChange(cb: (maximized: boolean) => void): Promise<UnlistenFn> {
    return this.api.onMaximizedChange(cb);
  }

  async takeWindowInit(): Promise<WindowInit> {
    return this.api.takeWindowInit();
  }

  async newWindow(): Promise<void> {
    return this.api.newWindow();
  }

  async quitApp(): Promise<void> {
    return this.api.quitApp();
  }

  async beginTransfer(): Promise<{ toWindow: boolean }> {
    return this.api.beginTransfer();
  }

  async dropTransfer(tab: TransferTab): Promise<void> {
    return this.api.dropTransfer(tab);
  }

  async onAdoptTab(cb: (tab: TransferTab) => void): Promise<UnlistenFn> {
    return this.api.onAdoptTab(cb);
  }

  async detachPtys(ids: number[]): Promise<void> {
    return this.api.detachPtys(ids);
  }

  async onDetachRequest(cb: () => void): Promise<UnlistenFn> {
    return this.api.onDetachRequest(cb);
  }

  async parkSession(tabs: TransferTab[]): Promise<void> {
    return this.api.parkSession(tabs);
  }

  setBackgroundSessions(enabled: boolean): void {
    this.api.setBackgroundSessions(enabled);
  }

  pushLayout(layout: { tabs: unknown[]; activeTabIndex: number } | null): void {
    this.api.pushLayout(layout);
  }

  pushSessionPrefs(prefs: {
    restoreLastSession: boolean;
    backgroundSessions: boolean;
    customTitleBar: boolean;
  }): void {
    this.api.pushSessionPrefs(prefs);
  }

  async reattachSession(): Promise<boolean> {
    return this.api.reattachSession();
  }

  async writeScreens(screens: Record<string, string> | null): Promise<void> {
    // The preload's channel is a `send`, so this resolves as soon as the payload
    // is handed over — which is the point. The host finishes the write.
    this.api.writeScreens(screens);
  }

  async readScreens(): Promise<Record<string, string>> {
    return this.api.readScreens();
  }

  async detachedSessionCount(): Promise<number> {
    return this.api.detachedSessionCount();
  }

  dragHover(): void {
    this.api.dragHover();
  }

  dragEnd(): void {
    this.api.dragEnd();
  }

  async onDragOver(cb: (over: boolean) => void): Promise<UnlistenFn> {
    return this.api.onDragOver(cb);
  }

  broadcast(channel: string, payload?: unknown): void {
    this.api.broadcast(channel, payload);
  }

  async onBroadcast(
    cb: (channel: string, payload?: unknown) => void
  ): Promise<UnlistenFn> {
    return this.api.onBroadcast(cb);
  }

  async setAttentionBadge(count: number): Promise<void> {
    return this.api.setAttentionBadge(count);
  }

  async notifyWaiting(payload: {
    title: string;
    body: string;
  }): Promise<void> {
    return this.api.notifyWaiting(payload);
  }

  async checkForUpdate(): Promise<void> {
    await this.api.checkForUpdate();
  }

  async downloadUpdate(): Promise<void> {
    await this.api.downloadUpdate();
  }

  async installUpdate(): Promise<void> {
    return this.api.installUpdate();
  }

  async getCurrentVersion(): Promise<string> {
    return this.api.getCurrentVersion();
  }

  async onUpdaterEvent(
    cb: (event: UpdaterEvent) => void
  ): Promise<UnlistenFn> {
    return this.api.onUpdaterEvent(cb);
  }
}
