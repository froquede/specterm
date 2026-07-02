import type { Backend, SpawnPtyOptions, FileEntry, UnlistenFn } from "./types";

// The preload script exposes window.specterm via contextBridge
interface SpectermAPI {
  spawnPty(opts: SpawnPtyOptions): Promise<number>;
  writePty(id: number, data: string): Promise<void>;
  resizePty(id: number, cols: number, rows: number): Promise<void>;
  killPty(id: number): Promise<void>;
  onPtyOutput(cb: (id: number, data: number[]) => void): () => void;
  onPtyExit(cb: (id: number) => void): () => void;
  readTextFile(path: string): Promise<string>;
  readDir(path: string): Promise<FileEntry[]>;
  clipboardHasImage(): Promise<boolean>;
  watchDir(path: string, cb: () => void): () => void;
  getHomePath(): Promise<string>;
  isFullscreen(): Promise<boolean>;
  setFullscreen(value: boolean): Promise<void>;
  onFullscreenChange(cb: (value: boolean) => void): () => void;
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

  async readDir(path: string): Promise<FileEntry[]> {
    return this.api.readDir(path);
  }

  async clipboardHasImage(): Promise<boolean> {
    return this.api.clipboardHasImage();
  }

  async onFsChange(cb: () => void): Promise<UnlistenFn> {
    const home = await this.getHomePath();
    return this.api.watchDir(home, cb);
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
}
