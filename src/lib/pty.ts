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

// Text clipboard helpers. The backend hits the OS clipboard through the host
// (Electron main process) which — unlike navigator.clipboard in the renderer —
// works regardless of window focus or clipboard permissions. navigator.clipboard
// is only a last-ditch fallback if the host bridge throws.
export async function clipboardReadText(): Promise<string> {
  try {
    const backend = await getBackend();
    return await backend.clipboardReadText();
  } catch {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return "";
    }
  }
}

export async function clipboardWriteText(text: string): Promise<void> {
  try {
    const backend = await getBackend();
    await backend.clipboardWriteText(text);
  } catch {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Both paths failed — nothing more we can do; swallow so the caller
      // (a keybinding handler) doesn't throw into the event loop.
    }
  }
}
