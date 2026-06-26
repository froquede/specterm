// Host-OS awareness for keyboard shortcuts.
//
// Shortcuts are authored macOS-first (⌘ = the primary command key), matching
// Ghostty. On Windows/Linux there is no ⌘, and mapping it straight to Ctrl
// would clobber terminal control codes (Ctrl+C = SIGINT, Ctrl+D = EOF,
// Ctrl+W = delete-word, …). So we translate:
//
//   Mac  ⌘X   ->  Win/Linux  Ctrl+Shift+X
//   Mac  ⌘⇧X  ->  Win/Linux  Ctrl+Alt+X
//
// This keeps every bare Ctrl+<key> free for the terminal.

export type OS = "mac" | "windows" | "linux";

function detectOS(): OS {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = (
    nav.userAgentData?.platform ||
    nav.platform ||
    nav.userAgent ||
    ""
  ).toLowerCase();
  if (/mac/.test(platform)) return "mac";
  if (/win/.test(platform)) return "windows";
  return "linux";
}

/** Host OS, resolved once. Drives per-platform keymap overrides. */
export const os: OS = detectOS();

/** The common mac-vs-rest split used by cmd() translation and labels. */
export const isMac = os === "mac";

export interface ModifierSpec {
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  alt?: boolean;
  code?: string;
}

/**
 * Modifier set for a primary command shortcut, resolved for the host OS.
 * Author Mac-first: `cmd()` is ⌘X, `cmd({ shift: true })` is ⌘⇧X.
 */
export function cmd(opts: { shift?: boolean; code?: string } = {}): ModifierSpec {
  if (isMac) {
    return { meta: true, shift: opts.shift, code: opts.code };
  }
  return opts.shift
    ? { ctrl: true, alt: true, code: opts.code }
    : { ctrl: true, shift: true, code: opts.code };
}

/** True when `e` is the host-OS equivalent of the given Mac-first ⌘ shortcut. */
export function matchesCmd(
  e: KeyboardEvent,
  opts: { shift?: boolean } = {}
): boolean {
  if (isMac) {
    return (
      e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      (opts.shift ? e.shiftKey : !e.shiftKey)
    );
  }
  if (!e.ctrlKey || e.metaKey) return false;
  return opts.shift
    ? e.altKey && !e.shiftKey
    : e.shiftKey && !e.altKey;
}

/**
 * True when a click carries the OS-native "open in new" modifier:
 * ⌘ on macOS (where Ctrl+click is the system secondary/right click),
 * Ctrl elsewhere.
 */
export function isAccelClick(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

/** On-screen label for a Mac-first ⌘ shortcut, native to the host OS. */
export function shortcutLabel(key: string, opts: { shift?: boolean } = {}): string {
  if (isMac) {
    return `${opts.shift ? "⇧" : ""}⌘${key}`;
  }
  return opts.shift ? `Ctrl+Alt+${key}` : `Ctrl+Shift+${key}`;
}
