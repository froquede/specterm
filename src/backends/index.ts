import type { Backend } from "./types";

// SUPPORTED TARGET: Electron only. The Tauri backend is experimental/incomplete
// (e.g. get_home_path isn't registered, listDrives is a stub) and is kept behind
// this runtime check purely so the abstraction stays honest. Ship and test on
// Electron; new features (like Windows drive enumeration) target it first.
let backend: Backend | null = null;

export async function getBackend(): Promise<Backend> {
  if (backend) return backend;

  // Detect the (experimental) Tauri runtime; otherwise use the supported
  // Electron backend.
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
