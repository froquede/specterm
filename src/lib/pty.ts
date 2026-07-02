import { getBackend, type UnlistenFn } from "../backends";

export async function spawnPty(options: {
  cols: number;
  rows: number;
  cwd?: string;
}): Promise<number> {
  const backend = await getBackend();
  return backend.spawnPty(options);
}

export async function writePty(id: number, data: string): Promise<void> {
  const backend = await getBackend();
  return backend.writePty(id, data);
}

export async function resizePty(
  id: number,
  cols: number,
  rows: number
): Promise<void> {
  const backend = await getBackend();
  return backend.resizePty(id, cols, rows);
}

export async function killPty(id: number): Promise<void> {
  const backend = await getBackend();
  return backend.killPty(id);
}

export function onPtyOutput(
  callback: (id: number, data: Uint8Array) => void
): Promise<UnlistenFn> {
  return getBackend().then((b) => b.onPtyOutput(callback));
}

export function onPtyExit(callback: (id: number) => void): Promise<UnlistenFn> {
  return getBackend().then((b) => b.onPtyExit(callback));
}

export async function clipboardHasImage(): Promise<boolean> {
  const backend = await getBackend();
  return backend.clipboardHasImage();
}
