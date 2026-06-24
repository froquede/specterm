type KeyHandler = () => void;

interface Keybinding {
  key?: string;
  code?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  alt?: boolean;
  handler: KeyHandler;
}

const directBindings: Keybinding[] = [];

export function registerBinding(
  key: string,
  handler: KeyHandler,
  opts?: { ctrl?: boolean; shift?: boolean; meta?: boolean; alt?: boolean; code?: string }
) {
  directBindings.push({
    key: opts?.code ? undefined : key.toLowerCase(),
    code: opts?.code,
    ctrl: opts?.ctrl,
    shift: opts?.shift,
    meta: opts?.meta,
    alt: opts?.alt,
    handler,
  });
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
      if (isEditableTarget(e.target)) return;

      for (const binding of directBindings) {
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

        if (keyMatch && ctrlMatch && shiftMatch && metaMatch && altMatch) {
          e.preventDefault();
          e.stopPropagation();
          binding.handler();
          return;
        }
      }
    },
    true // capture phase — before xterm.js
  );
}
