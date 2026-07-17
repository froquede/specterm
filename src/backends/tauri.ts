import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readTextFile, readDir as tauriReadDir } from "@tauri-apps/plugin-fs";
import type {
  Backend,
  SpawnPtyOptions,
  FileEntry,
  DriveEntry,
  UnlistenFn,
} from "./types";

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

  async listDrives(): Promise<DriveEntry[]> {
    // TODO: implement a `list_drives` Tauri command (probe C:..Z: existence in
    // Rust) once the Tauri backend is completed. Electron is the shipping
    // Windows target today, so this stub keeps the interface satisfied.
    return [];
  }

  async onFsChange(cb: () => void): Promise<UnlistenFn> {
    return listen("fs-change", () => cb());
  }

  async clipboardHasImage(): Promise<boolean> {
    // Not yet wired on the Tauri backend; image paste is Electron-only for now.
    return false;
  }

  async clipboardReadText(): Promise<string> {
    // Tauri's webview generally allows navigator.clipboard; no native bridge yet.
    return navigator.clipboard.readText();
  }

  async clipboardWriteText(text: string): Promise<void> {
    return navigator.clipboard.writeText(text);
  }

  async getHomePath(): Promise<string> {
    return invoke<string>("get_home_path");
  }

  async isFullscreen(): Promise<boolean> {
    return getCurrentWindow().isFullscreen();
  }

  async setFullscreen(value: boolean): Promise<void> {
    return getCurrentWindow().setFullscreen(value);
  }

  async onFullscreenChange(
    cb: (value: boolean) => void
  ): Promise<UnlistenFn> {
    // Tauri has no dedicated fullscreen event; resize fires on enter/leave, so
    // re-read the state from there.
    const win = getCurrentWindow();
    return win.onResized(async () => {
      cb(await win.isFullscreen());
    });
  }

  async setWindowOpacity(_value: number): Promise<void> {
    // Tauri's window API exposes no JS setOpacity; honoring this would need a
    // native `set_window_opacity` command. Electron is the shipping target, so
    // this is a no-op stub (matching listDrives/clipboardHasImage) — the window
    // stays opaque under Tauri.
  }
}
