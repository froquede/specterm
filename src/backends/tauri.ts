import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { readTextFile, readDir as tauriReadDir } from "@tauri-apps/plugin-fs";
import type { Backend, SpawnPtyOptions, FileEntry, UnlistenFn } from "./types";

interface PtyOutput {
  id: number;
  data: number[];
}

export class TauriBackend implements Backend {
  async spawnPty(opts: SpawnPtyOptions): Promise<number> {
    return invoke<number>("spawn_pty", { options: opts });
  }

  async writePty(id: number, data: string): Promise<void> {
    const encoder = new TextEncoder();
    const bytes = Array.from(encoder.encode(data));
    return invoke("write_pty", { id, data: bytes });
  }

  async resizePty(id: number, cols: number, rows: number): Promise<void> {
    return invoke("resize_pty", { id, cols, rows });
  }

  async killPty(id: number): Promise<void> {
    return invoke("kill_pty", { id });
  }

  async onPtyOutput(
    cb: (id: number, data: Uint8Array) => void
  ): Promise<UnlistenFn> {
    return listen<PtyOutput>("pty-output", (event) => {
      cb(event.payload.id, new Uint8Array(event.payload.data));
    });
  }

  async onPtyExit(cb: (id: number) => void): Promise<UnlistenFn> {
    return listen<number>("pty-exit", (event) => {
      cb(event.payload);
    });
  }

  async readTextFile(path: string): Promise<string> {
    return readTextFile(path);
  }

  async readDir(path: string): Promise<FileEntry[]> {
    const entries = await tauriReadDir(path);
    return entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory,
    }));
  }

  async onFsChange(cb: () => void): Promise<UnlistenFn> {
    return listen("fs-change", () => cb());
  }

  async getHomePath(): Promise<string> {
    return invoke<string>("get_home_path");
  }
}
