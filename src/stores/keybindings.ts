type KeyHandler = () => void;

interface Keybinding {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  handler: KeyHandler;
}

const directBindings: Keybinding[] = [];

export function registerBinding(
  key: string,
  handler: KeyHandler,
  opts?: { ctrl?: boolean; shift?: boolean }
) {
  directBindings.push({
    key: key.toLowerCase(),
    ctrl: opts?.ctrl,
    shift: opts?.shift,
    handler,
  });
}

export function initKeybindings() {
  window.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      for (const binding of directBindings) {
        const ctrlMatch = binding.ctrl ? e.ctrlKey : !e.ctrlKey;
        const shiftMatch = binding.shift ? e.shiftKey : !e.shiftKey;

        // Special handling for Enter key (e.key is "Enter" not lowercase)
        const keyMatch =
          binding.key === "enter"
            ? e.key === "Enter"
            : e.key.toLowerCase() === binding.key;

        if (keyMatch && ctrlMatch && shiftMatch) {
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
