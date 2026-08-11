// A chord — one key plus its modifiers — and the three things the app needs to
// do with one: show it, compare it, and read one off a keystroke.
//
// The type lives here rather than next to the dispatcher because the settings
// panel needs it too, and the panel has no business importing the dispatcher.
// stores/keybindings.ts re-exports it, so the keymap keeps its old import.
import { isMac } from "./platform";

export interface Chord {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  alt?: boolean;
  // Physical key code (layout-independent). When set it matches instead of
  // `key` — preferred for punctuation/digits that shift under other layouts.
  code?: string;
}

// Keys that are only ever a modifier. A chord is not finished while one of
// these is the key being held, so the recorder waits for a real one.
const MODIFIER_KEYS = new Set([
  "control",
  "shift",
  "meta",
  "alt",
  "altgraph",
  "capslock",
  "os",
  "hyper",
  "super",
  "fn",
]);

// How a key reads on screen. Arrows become glyphs (they are the only keys whose
// name is longer than the chord it sits in), the rest get the capitalization
// people expect from a shortcut table rather than the lowercase we match on.
const KEY_LABELS: Record<string, string> = {
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
  enter: "Enter",
  escape: "Esc",
  " ": "Space",
  spacebar: "Space",
  backspace: "Backspace",
  delete: "Del",
  tab: "Tab",
  home: "Home",
  end: "End",
  pageup: "PgUp",
  pagedown: "PgDn",
  insert: "Ins",
};

/** The printable name of a chord's key, without its modifiers. */
export function keyLabel(key: string): string {
  const k = key.toLowerCase();
  const named = KEY_LABELS[k];
  if (named) return named;
  if (/^f\d{1,2}$/.test(k)) return k.toUpperCase();
  if (k.length === 1) return k.toUpperCase();
  // Anything else (a media key, an IME name) reads best as the browser spells it.
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * A chord as the host OS writes it: ⌃⌥⇧⌘K on macOS (in the order Apple's own
 * menus use), Ctrl+Alt+Shift+K elsewhere.
 */
export function formatChord(chord: Chord): string {
  const key = keyLabel(chord.key);
  if (isMac) {
    return (
      (chord.ctrl ? "⌃" : "") +
      (chord.alt ? "⌥" : "") +
      (chord.shift ? "⇧" : "") +
      (chord.meta ? "⌘" : "") +
      key
    );
  }
  const parts: string[] = [];
  if (chord.ctrl) parts.push("Ctrl");
  if (chord.meta) parts.push("Win");
  if (chord.alt) parts.push("Alt");
  if (chord.shift) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

/**
 * A canonical string for equality. Two chords collide when this matches, which
 * is exactly the condition under which the dispatcher would hand the keystroke
 * to whichever of them it happened to see first.
 *
 * `code` wins when present because that is what the dispatcher matches on — a
 * chord recorded as `{key:"=", code:"Equal"}` and one authored as
 * `{key:"=", code:"Equal"}` are the same key however the two got there.
 */
export function chordSignature(chord: Chord): string {
  const mods =
    (chord.ctrl ? "c" : "") +
    (chord.shift ? "s" : "") +
    (chord.meta ? "m" : "") +
    (chord.alt ? "a" : "");
  return `${mods}|${chord.code ?? chord.key.toLowerCase()}`;
}

export function chordsEqual(a: Chord, b: Chord): boolean {
  return chordSignature(a) === chordSignature(b);
}

/**
 * Read a chord off a keydown, or null while only modifiers are down.
 *
 * Both `key` and `code` are kept: `code` is what the dispatcher matches on, so
 * a shortcut recorded on one keyboard layout stays on the same physical key —
 * and `key` is what the panel prints, so it still reads as the character that
 * was actually typed. Letters are the exception: they are recorded by `key`
 * alone, matching how the built-in keymap authors them, so ⌘T is the T you see
 * on the keycap whatever layout produced it.
 */
export function chordFromEvent(e: KeyboardEvent): Chord | null {
  const key = e.key.toLowerCase();
  if (MODIFIER_KEYS.has(key)) return null;
  const isLetter = key.length === 1 && key >= "a" && key <= "z";
  return {
    key,
    code: isLetter || !e.code ? undefined : e.code,
    ctrl: e.ctrlKey || undefined,
    shift: e.shiftKey || undefined,
    meta: e.metaKey || undefined,
    alt: e.altKey || undefined,
  };
}

/** True when `e` is this chord being pressed. The dispatcher's match rule. */
export function chordMatchesEvent(chord: Chord, e: KeyboardEvent): boolean {
  if (!!chord.ctrl !== e.ctrlKey) return false;
  if (!!chord.shift !== e.shiftKey) return false;
  if (!!chord.meta !== e.metaKey) return false;
  if (!!chord.alt !== e.altKey) return false;
  if (chord.code) return e.code === chord.code;
  // Enter arrives as "Enter", not lowercase — and the keymap authors it lowercase.
  return e.key.toLowerCase() === chord.key.toLowerCase();
}

/** A chord with nothing but modifiers is not a shortcut anyone can press. */
export function isBareModifierChord(chord: Chord): boolean {
  return MODIFIER_KEYS.has(chord.key.toLowerCase());
}

/**
 * Whether a chord is safe to hand to the app rather than the shell. A bare key
 * or a lone Ctrl+<key> is a control code the terminal owns — Ctrl+C is SIGINT,
 * Ctrl+D is EOF — so binding one would take it away from every program running
 * in a pane. Function keys are exempt: they carry no control code, and the
 * built-in keymap already puts rename on F2.
 */
export function chordStealsFromTerminal(chord: Chord): boolean {
  const key = chord.key.toLowerCase();
  if (/^f\d{1,2}$/.test(key)) return false;
  if (chord.meta || chord.alt) return false;
  if (chord.ctrl && chord.shift) return false;
  return true; // bare key, or Ctrl+<key> on its own
}
