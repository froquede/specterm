// User-rebound shortcuts.
//
// The keymap (stores/keymap.ts) stays the source of truth for *what* the app
// can do and what each action is called; this is the thin layer of "except this
// one, which I press differently" on top of it. Keyed by the keymap's stable
// binding id, so a row that changes its default chord in a later version does
// not silently lose the user's override, and an id that disappears entirely is
// simply ignored rather than resurrecting a binding that no longer runs.
//
// Persisted shape (localStorage key "specterm.keybindings"):
//   { "tab.new": { key: "t", ctrl: true, shift: true }, "app.quit": null }
//
// A `null` value means *disabled*: the action keeps existing (it is still in
// the panel, still resettable) but no keystroke reaches it. That is the only
// way to hand a chord back to the terminal without inventing a replacement for
// it, and it is why the map cannot be a plain "id → chord".
import { createSignal } from "solid-js";
import { publishStoreChange, registerStoreSync } from "../lib/store-sync";
import type { Chord } from "../lib/chord";

const STORAGE_KEY = "specterm.keybindings";

/** id → replacement chord, or null for "this shortcut is off". */
export type OverrideMap = Readonly<Record<string, Chord | null>>;

// Read defensively: this file is small enough to hand-edit, and a bad blob must
// not take the whole keymap down with it — an unparseable entry just falls back
// to the built-in default for that row.
function parseChord(v: unknown): Chord | null | undefined {
  if (v === null) return null;
  if (typeof v !== "object" || v === undefined) return undefined;
  const c = v as Record<string, unknown>;
  if (typeof c.key !== "string" || c.key === "") return undefined;
  return {
    key: c.key,
    code: typeof c.code === "string" ? c.code : undefined,
    ctrl: c.ctrl === true || undefined,
    shift: c.shift === true || undefined,
    meta: c.meta === true || undefined,
    alt: c.alt === true || undefined,
  };
}

function load(): OverrideMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, Chord | null> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const chord = parseChord(value);
      if (chord !== undefined) out[id] = chord;
    }
    return out;
  } catch (_) {
    return {};
  }
}

const [overrides, setOverridesSignal] = createSignal<OverrideMap>(load());

export { overrides };

/** How many rows differ from their defaults — drives the "Reset all" control. */
export const overrideCount = () => Object.keys(overrides()).length;

function persist(next: OverrideMap) {
  setOverridesSignal(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (_) {
    // localStorage unavailable — the change just won't survive this session.
  }
  publishStoreChange("keybindings");
}

/** Rebind one action. Pass null to switch it off entirely. */
export function setOverride(id: string, chord: Chord | null) {
  persist({ ...overrides(), [id]: chord });
}

/** Put one action back on its built-in chord. */
export function clearOverride(id: string) {
  const next = { ...overrides() };
  delete next[id];
  persist(next);
}

/** Put every action back on its built-in chord. */
export function resetAllOverrides() {
  persist({});
}

/** Re-read after another window wrote. Registered from initKeybindings. */
export function reloadOverrides() {
  setOverridesSignal(load());
}

export function initKeybindingOverrides() {
  registerStoreSync("keybindings", reloadOverrides);
}
