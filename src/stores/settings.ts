import { createSignal } from "solid-js";

// User-tunable settings, persisted to localStorage so they survive restarts.
// This is the first real "preferences" surface in specterm — the Settings panel
// (components/SettingsPanel.tsx) reads/writes these signals.
//
// Persisted shape (localStorage key "specterm.settings"):
//   { unfocusedOpacity, startupPath, lastBrowsedPath }
// Old blobs simply lack the newer keys, so loading is backward compatible.
//
// - unfocusedOpacity drives the `--unfocused-split-opacity` CSS variable (see
//   styles/global.css): the visible fraction of a non-active pane, so 1 = no
//   dimming, lower = washed further toward the fill.
// - startupPath is the directory new terminals spawn in AND the folder the file
//   tree opens at. Blank = the OS home directory.
// - lastBrowsedPath is the folder the file tree was last showing; it takes
//   precedence over startupPath when reopening (both are readability-checked).

const STORAGE_KEY = "specterm.settings";

export const UNFOCUSED_OPACITY_DEFAULT = 0.35;
export const UNFOCUSED_OPACITY_MIN = 0.1;
export const UNFOCUSED_OPACITY_MAX = 1;

function clampOpacity(v: number): number {
  if (!Number.isFinite(v)) return UNFOCUSED_OPACITY_DEFAULT;
  return Math.min(UNFOCUSED_OPACITY_MAX, Math.max(UNFOCUSED_OPACITY_MIN, v));
}

interface Persisted {
  unfocusedOpacity: number;
  startupPath: string;
  lastBrowsedPath: string;
}

function load(): Persisted {
  const defaults: Persisted = {
    unfocusedOpacity: UNFOCUSED_OPACITY_DEFAULT,
    startupPath: "",
    lastBrowsedPath: "",
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return {
      unfocusedOpacity:
        parsed && typeof parsed.unfocusedOpacity === "number"
          ? clampOpacity(parsed.unfocusedOpacity)
          : defaults.unfocusedOpacity,
      startupPath:
        parsed && typeof parsed.startupPath === "string"
          ? parsed.startupPath
          : defaults.startupPath,
      lastBrowsedPath:
        parsed && typeof parsed.lastBrowsedPath === "string"
          ? parsed.lastBrowsedPath
          : defaults.lastBrowsedPath,
    };
  } catch (_) {
    // Corrupt or unavailable storage — fall back to defaults.
    return defaults;
  }
}

const initial = load();

const [unfocusedOpacity, setUnfocusedOpacitySignal] = createSignal(
  initial.unfocusedOpacity
);
const [startupPath, setStartupPathSignal] = createSignal(initial.startupPath);
const [lastBrowsedPath, setLastBrowsedPathSignal] = createSignal(
  initial.lastBrowsedPath
);

export { unfocusedOpacity, startupPath, lastBrowsedPath };

// Push the current opacity into the CSS variable on :root. An inline style on
// documentElement overrides the `:root { ... }` rule in global.css.
function applyUnfocusedOpacity() {
  document.documentElement.style.setProperty(
    "--unfocused-split-opacity",
    String(unfocusedOpacity())
  );
}

function persist() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        unfocusedOpacity: unfocusedOpacity(),
        startupPath: startupPath(),
        lastBrowsedPath: lastBrowsedPath(),
      })
    );
  } catch (_) {
    // localStorage unavailable — the change just won't survive this session.
  }
}

export function setUnfocusedOpacity(v: number) {
  setUnfocusedOpacitySignal(clampOpacity(v));
  applyUnfocusedOpacity();
  persist();
}

export function resetUnfocusedOpacity() {
  setUnfocusedOpacity(UNFOCUSED_OPACITY_DEFAULT);
}

// The directory new terminals and the file tree start in. Blank = OS home.
export function setStartupPath(v: string) {
  setStartupPathSignal(v.trim());
  persist();
}

// Remembered on every file-tree navigation so the sidebar reopens where it was.
export function setLastBrowsedPath(v: string) {
  setLastBrowsedPathSignal(v);
  persist();
}

// Apply persisted values to the DOM once at startup. Called from App's onMount.
export function initSettings() {
  applyUnfocusedOpacity();
}
