import type { Backend } from "./types";

let backend: Backend | null = null;

export async function getBackend(): Promise<Backend> {
  if (backend) return backend;

  // Detect Tauri runtime
  if ("__TAURI_INTERNALS__" in window) {
    const { TauriBackend } = await import("./tauri");
    backend = new TauriBackend();
  } else {
    const { ElectronBackend } = await import("./electron");
    backend = new ElectronBackend();
  }

  return backend;
}

export type { Backend, UnlistenFn } from "./types";
