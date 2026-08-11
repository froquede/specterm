import { createSignal } from "solid-js";
import { os, type OS } from "../lib/platform";
import {
  chordMatchesEvent,
  isBareModifierChord,
  type Chord,
} from "../lib/chord";
import {
  initKeybindingOverrides,
  overrides,
  type OverrideMap,
} from "./keybinding-overrides";

export type { Chord };

type KeyHandler = () => void;

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

// The registered keymap. Held as specs rather than flattened into resolved
// chords at registration time, because the chord a row answers to is no longer
// fixed: an override written in the settings panel (or in another window) has
// to take effect on the next keystroke, without the app re-running its onMount.
// Resolution happens whenever this list or the override map changes (see
// resolvedBindings) rather than on every keypress, and the dispatcher walks the
// result in registration order, first match wins.
const [keymapSpecs, setKeymapSpecs] = createSignal<readonly BindingSpec[]>([]);

export { keymapSpecs };

/** Register a declarative keymap. Rows are resolved per-OS at press time. */
export function registerBindings(specs: BindingSpec[]) {
  setKeymapSpecs((prev) => [...prev, ...specs]);
}

/** The chord a row ships with on this OS, before any user override. */
export function defaultChord(spec: BindingSpec): Chord {
  const fromOS = spec.byOS?.[os];
  if (fromOS) return fromOS;
  return {
    key: spec.key,
    code: spec.code,
    ctrl: spec.ctrl,
    shift: spec.shift,
    meta: spec.meta,
    alt: spec.alt,
  };
}

/**
 * The chord a row actually answers to right now, or null when the user has
 * switched it off. Reactive — reads the override signal.
 */
export function activeChord(spec: BindingSpec): Chord | null {
  const override = overrides()[spec.id];
  if (override === null) return null;
  if (override) return override;
  return defaultChord(spec);
}

// The resolved keymap the dispatcher actually walks: every row paired with the
// chord it currently answers to, rows that are switched off (or whose override
// names no real key) already dropped.
//
// This exists because the dispatcher runs on *every keystroke typed into a
// terminal*, and resolving rows there meant a fresh Chord object per row per
// key — two dozen short-lived allocations to decide that a keypress was just a
// letter. Resolution depends on exactly two things, both of which are signals
// that change only when a shortcut is rebound or the keymap is registered, so
// the work is done once per change and reused for every keystroke in between.
//
// The cache is keyed on the *identity* of those two values rather than on a
// reactive computation, so it needs no owner and can't outlive one: the
// dispatcher is a bare window listener, not a component.
interface ResolvedBinding {
  spec: BindingSpec;
  chord: Chord;
}

let cachedSpecs: readonly BindingSpec[] | null = null;
let cachedOverrides: OverrideMap | null = null;
let cachedBindings: ResolvedBinding[] = [];

function resolvedBindings(): ResolvedBinding[] {
  const specs = keymapSpecs();
  const ov = overrides();
  if (specs === cachedSpecs && ov === cachedOverrides) return cachedBindings;
  const next: ResolvedBinding[] = [];
  for (const spec of specs) {
    const chord = activeChord(spec);
    // Switched off by the user, or an override so malformed it names no key.
    if (!chord || isBareModifierChord(chord)) continue;
    next.push({ spec, chord });
  }
  cachedSpecs = specs;
  cachedOverrides = ov;
  cachedBindings = next;
  return next;
}

// While the settings panel is recording a new chord, every keystroke belongs to
// the recorder — including the ones that are currently bound to something. The
// dispatcher stands down entirely rather than trying to guess which, so the
// event reaches the recorder's own handler unconsumed.
const [capturing, setCapturing] = createSignal(false);

export { capturing };

export function setKeybindingCapture(on: boolean) {
  setCapturing(on);
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
  initKeybindingOverrides();

  window.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      // The recorder owns the keyboard while it is open. Nothing is consumed
      // here, so the key it is waiting for arrives intact.
      if (capturing()) return;

      const inEditable = isEditableTarget(e.target);

      for (const { spec, chord } of resolvedBindings()) {
        if (!chordMatchesEvent(chord, e)) continue;

        // In a real text field we let native editing win, EXCEPT for bindings
        // explicitly flagged to work everywhere (e.g. ⌘B to close the sidebar
        // and jump back to the terminal).
        if (inEditable && !spec.allowInInput) continue;
        // A binding may decline a keystroke it would otherwise own. `continue`
        // rather than `return`, so the key keeps looking for another binding
        // and, failing that, reaches the terminal untouched — which is the
        // point: a bare key like F2 belongs to whatever full-screen program is
        // running.
        if (spec.enabled && !spec.enabled()) continue;

        e.preventDefault();
        e.stopPropagation();
        spec.run();
        return;
      }
    },
    true // capture phase — before xterm.js
  );
}
