import { createSignal } from "solid-js";

// User-tunable appearance settings, persisted to localStorage so they survive
// restarts. This is the first real "preferences" surface in specterm — the
// Settings panel (components/SettingsPanel.tsx) reads/writes these signals.
//
// The unfocused-pane opacity drives the `--unfocused-split-opacity` CSS variable
// (see styles/global.css): it's the visible fraction of a pane that isn't the
// active one, so 1 = no dimming at all, lower = washed further toward the fill.

const STORAGE_KEY = "specterm.settings";

export const UNFOCUSED_OPACITY_DEFAULT = 0.35;
export const UNFOCUSED_OPACITY_MIN = 0.1;
export const UNFOCUSED_OPACITY_MAX = 1;

function clampOpacity(v: number): number {
  if (!Number.isFinite(v)) return UNFOCUSED_OPACITY_DEFAULT;
  return Math.min(UNFOCUSED_OPACITY_MAX, Math.max(UNFOCUSED_OPACITY_MIN, v));
}

function load(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return UNFOCUSED_OPACITY_DEFAULT;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.unfocusedOpacity === "number") {
      return clampOpacity(parsed.unfocusedOpacity);
    }
    return UNFOCUSED_OPACITY_DEFAULT;
  } catch (_) {
    // Corrupt or unavailable storage — fall back to the default.
    return UNFOCUSED_OPACITY_DEFAULT;
  }
}

const [unfocusedOpacity, setUnfocusedOpacitySignal] = createSignal(load());

export { unfocusedOpacity };

// Push the current value into the CSS variable on :root. An inline style on
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
      JSON.stringify({ unfocusedOpacity: unfocusedOpacity() })
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

// Apply persisted values to the DOM once at startup. Called from App's onMount.
export function initSettings() {
  applyUnfocusedOpacity();
}
