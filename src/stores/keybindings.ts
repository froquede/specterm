import { os, type OS } from "../lib/platform";

type KeyHandler = () => void;

interface Keybinding {
  key?: string;
  code?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  alt?: boolean;
  allowInInput?: boolean;
  // Consulted at press time. Returning false makes the binding step aside for
  // this keystroke — the event is neither consumed nor preventDefault'd, so it
  // carries on to xterm.js and into the shell. See the dispatcher below.
  enabled?: () => boolean;
  handler: KeyHandler;
}

const directBindings: Keybinding[] = [];

export function registerBinding(
  key: string,
  handler: KeyHandler,
  opts?: {
    ctrl?: boolean;
    shift?: boolean;
    meta?: boolean;
    alt?: boolean;
    code?: string;
    // Fire even when focus is in a real text field. Use sparingly, for
    // modifier shortcuts that must work from inside an input (e.g. the
    // sidebar-search toggle, which itself focuses an input).
    allowInInput?: boolean;
    // Decline the keystroke conditionally; see Keybinding.enabled.
    enabled?: () => boolean;
  }
) {
  directBindings.push({
    key: opts?.code ? undefined : key.toLowerCase(),
    code: opts?.code,
    ctrl: opts?.ctrl,
    shift: opts?.shift,
    meta: opts?.meta,
    alt: opts?.alt,
    allowInInput: opts?.allowInInput,
    enabled: opts?.enabled,
    handler,
  });
}

// The platform-specific half of a chord: a key plus its modifiers. A keymap
// row carries one as its default (authored Mac-first via cmd()) and may
// override it per-OS.
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

// One row of the keymap: a stable id, a default Mac-first chord, what it runs,
// and optional per-OS replacements for cases cmd() can't express on its own
// (e.g. Windows needing a different chord than Linux). When `byOS` has an entry
// for the host OS, it replaces the default chord wholesale.
export interface BindingSpec extends Chord {
  id: string;
  run: KeyHandler;
  label?: string;
  allowInInput?: boolean;
  enabled?: () => boolean;
  byOS?: Partial<Record<OS, Chord>>;
}

/** Register a declarative keymap, resolving each row's chord for the host OS. */
export function registerBindings(specs: BindingSpec[]) {
  for (const spec of specs) {
    const chord: Chord = spec.byOS?.[os] ?? spec;
    registerBinding(chord.key, spec.run, {
      ctrl: chord.ctrl,
      shift: chord.shift,
      meta: chord.meta,
      alt: chord.alt,
      code: chord.code,
      allowInInput: spec.allowInInput,
      enabled: spec.enabled,
    });
  }
}

// True when focus is in a real text field (filter, search) — but NOT the
// hidden textarea xterm.js uses for terminal input. We let native editing
// (typing, ⌘C/⌘V) work in those real inputs instead of hijacking the keys.
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === "INPUT") return true;
  if (target.tagName === "TEXTAREA") {
    return !target.classList.contains("xterm-helper-textarea");
  }
  return false;
}

export function initKeybindings() {
  window.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      const inEditable = isEditableTarget(e.target);

      for (const binding of directBindings) {
        // In a real text field we let native editing win, EXCEPT for bindings
        // explicitly flagged to work everywhere (e.g. ⌘B to close the sidebar
        // and jump back to the terminal).
        if (inEditable && !binding.allowInInput) continue;

        const ctrlMatch = binding.ctrl ? e.ctrlKey : !e.ctrlKey;
        const shiftMatch = binding.shift ? e.shiftKey : !e.shiftKey;
        const metaMatch = binding.meta ? e.metaKey : !e.metaKey;
        const altMatch = binding.alt ? e.altKey : !e.altKey;

        let keyMatch: boolean;
        if (binding.code) {
          keyMatch = e.code === binding.code;
        } else if (binding.key === "enter") {
          // Special handling for Enter key (e.key is "Enter" not lowercase)
          keyMatch = e.key === "Enter";
        } else {
          keyMatch = e.key.toLowerCase() === binding.key;
        }

        if (!keyMatch || !ctrlMatch || !shiftMatch || !metaMatch || !altMatch) {
          continue;
        }
        // A binding may decline a keystroke it would otherwise own. `continue`
        // rather than `return`, so the key keeps looking for another binding and,
        // failing that, reaches the terminal untouched — which is the point: a
        // bare key like F2 belongs to whatever full-screen program is running.
        if (binding.enabled && !binding.enabled()) continue;

        e.preventDefault();
        e.stopPropagation();
        binding.handler();
        return;
      }
    },
    true // capture phase — before xterm.js
  );
}
