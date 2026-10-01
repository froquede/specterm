import type { Backend, WindowBoot } from "./types";

// Electron is the only host. The Backend interface stays as the seam between
// the renderer and it: every host call is in one typed place, and the renderer
// never reaches for the preload bridge directly.
let backend: Backend | null = null;

export async function getBackend(): Promise<Backend> {
  if (backend) return backend;
  const { ElectronBackend } = await import("./electron");
  backend = new ElectronBackend();
  return backend;
}

/**
 * What kind of window this is — synchronously, at any point after load.
 *
 * The one thing here that doesn't go through the Backend instance, and
 * deliberately so: getBackend() resolves a dynamic import, and the window's
 * first tab is built from this. Putting even a microtask in front of it would
 * mean the app no longer opens straight into a shell, which is the one startup
 * property worth protecting. The host stamps the flags into the renderer's own
 * launch arguments and the preload hands them over as plain data (see
 * electron/preload.cjs), so there is nothing to await and nothing to ask.
 *
 * The fallback is the single-window answer, for an Electron window that somehow
 * started without the flag.
 */
export function windowBoot(): WindowBoot {
  const boot = (window as { specterm?: { windowBoot?: WindowBoot } }).specterm
    ?.windowBoot;
  return (
    boot ?? {
      hasTabs: false,
      hasRestore: false,
      restore: null,
      autoCheckUpdates: true,
      ownControls: false,
      migrateLegacy: false,
    }
  );
}

export type { Backend, UnlistenFn } from "./types";
