import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface SpawnOptions {
  cols: number;
  rows: number;
  cwd?: string;
}

interface PtyOutput {
  id: number;
  data: number[];
}

export async function spawnPty(options: SpawnOptions): Promise<number> {
  return invoke<number>("spawn_pty", { options });
}

export async function writePty(id: number, data: string): Promise<void> {
  const encoder = new TextEncoder();
  const bytes = Array.from(encoder.encode(data));
  return invoke("write_pty", { id, data: bytes });
}

export async function resizePty(
  id: number,
  cols: number,
  rows: number
): Promise<void> {
  return invoke("resize_pty", { id, cols, rows });
}

export async function killPty(id: number): Promise<void> {
  return invoke("kill_pty", { id });
}

export function onPtyOutput(
  callback: (id: number, data: Uint8Array) => void
): Promise<UnlistenFn> {
  return listen<PtyOutput>("pty-output", (event) => {
    callback(event.payload.id, new Uint8Array(event.payload.data));
  });
}

export function onPtyExit(
  callback: (id: number) => void
): Promise<UnlistenFn> {
  return listen<number>("pty-exit", (event) => {
    callback(event.payload);
  });
}
