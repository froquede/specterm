import type {
  Backend,
  SpawnPtyOptions,
  FileEntry,
  DriveEntry,
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
  ): Promise<{ buffered: number[]; exited: boolean }>;
  onPtyOutput(cb: (id: number, data: number[]) => void): () => void;
  onPtyExit(cb: (id: number) => void): () => void;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, content: string): Promise<void>;
  readDir(path: string): Promise<FileEntry[]>;
  listDrives(): Promise<DriveEntry[]>;
  revealInFileManager(path: string, isDirectory: boolean): Promise<void>;
  clipboardHasImage(): Promise<boolean>;
  clipboardReadText(): Promise<string>;
  clipboardWriteText(text: string): Promise<void>;
  watchDir(path: string, cb: () => void): () => void;
  onOpenPath(cb: (path: string) => void): () => void;
  getHomePath(): Promise<string>;
  isFullscreen(): Promise<boolean>;
  setFullscreen(value: boolean): Promise<void>;
  onFullscreenChange(cb: (value: boolean) => void): () => void;
  setWindowOpacity(value: number): Promise<void>;
  takeWindowInit(): Promise<WindowInit>;
  newWindow(): Promise<void>;
  dropTransfer(tab: TransferTab): Promise<void>;
  onAdoptTab(cb: (tab: TransferTab) => void): () => void;
  broadcast(channel: string, payload?: unknown): void;
  onBroadcast(cb: (channel: string, payload?: unknown) => void): () => void;
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
    const result = await this.api.adoptPty(id, cols, rows);
    return {
      buffered: new Uint8Array(result.buffered),
      exited: result.exited,
    };
  }

  async onPtyOutput(
    cb: (id: number, data: Uint8Array) => void
  ): Promise<UnlistenFn> {
    return this.api.onPtyOutput((id, data) => {
      cb(id, new Uint8Array(data));
    });
  }

  async onPtyExit(cb: (id: number) => void): Promise<UnlistenFn> {
    return this.api.onPtyExit(cb);
  }

  async readTextFile(path: string): Promise<string> {
    return this.api.readTextFile(path);
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    return this.api.writeTextFile(path, content);
  }

  async readDir(path: string): Promise<FileEntry[]> {
    return this.api.readDir(path);
  }

  async listDrives(): Promise<DriveEntry[]> {
    return this.api.listDrives();
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

  async takeWindowInit(): Promise<WindowInit> {
    return this.api.takeWindowInit();
  }

  async newWindow(): Promise<void> {
    return this.api.newWindow();
  }

  async dropTransfer(tab: TransferTab): Promise<void> {
    return this.api.dropTransfer(tab);
  }

  async onAdoptTab(cb: (tab: TransferTab) => void): Promise<UnlistenFn> {
    return this.api.onAdoptTab(cb);
  }

  broadcast(channel: string, payload?: unknown): void {
    this.api.broadcast(channel, payload);
  }

  async onBroadcast(
    cb: (channel: string, payload?: unknown) => void
  ): Promise<UnlistenFn> {
    return this.api.onBroadcast(cb);
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
