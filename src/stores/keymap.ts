// The keymap — the single source of truth for keyboard shortcuts.
//
// Each row is authored macOS-first: cmd() expands a ⌘ shortcut into the host
// OS's chord (⌘X -> Ctrl+Shift+X, ⌘⇧X -> Ctrl+Alt+X on Windows/Linux), keeping
// bare Ctrl+<key> free for the terminal. That mac-vs-rest split covers almost
// everything; when a single platform needs to diverge (e.g. Windows ≠ Linux),
// add a `byOS` entry — see the example on `sidebar.toggle` below.
import { cmd } from "../lib/platform";
import type { BindingSpec } from "./keybindings";
import type { useTabStore } from "./tabs";
import {
  getTerminalInstance,
  increaseFontSize,
  decreaseFontSize,
  resetFontSize,
} from "../lib/terminal-registry";
import { writePty } from "../lib/pty";

export interface KeymapContext {
  store: ReturnType<typeof useTabStore>;
  // Pull keyboard focus back into the active pane's terminal.
  focusActivePane: () => void;
}

const newTerminal = () =>
  ({ kind: "terminal", ptyId: null, cwd: "" }) as const;

export function createKeymap({ store, focusActivePane }: KeymapContext): BindingSpec[] {
  return [
    // Tabs
    {
      id: "tab.new",
      key: "t",
      ...cmd(),
      label: "New tab",
      run: () => store.createTab(),
    },
    {
      id: "tab.close",
      key: "w",
      ...cmd({ shift: true }),
      label: "Close tab",
      run: () => {
        const tab = store.activeTab;
        if (tab) store.closeTab(tab.id);
      },
    },
    {
      id: "tab.next",
      key: "]",
      ...cmd({ shift: true, code: "BracketRight" }),
      label: "Next tab",
      run: () => {
        const tabs = store.state.tabs;
        const idx = tabs.findIndex((t) => t.id === store.state.activeTabId);
        if (tabs.length > 1) store.setActiveTab(tabs[(idx + 1) % tabs.length].id);
      },
    },
    {
      id: "tab.prev",
      key: "[",
      ...cmd({ shift: true, code: "BracketLeft" }),
      label: "Previous tab",
      run: () => {
        const tabs = store.state.tabs;
        const idx = tabs.findIndex((t) => t.id === store.state.activeTabId);
        if (tabs.length > 1)
          store.setActiveTab(tabs[(idx - 1 + tabs.length) % tabs.length].id);
      },
    },

    // Splits — ⌘D adds a stacked pane ("v" = column), ⌘⇧D a side-by-side one
    // ("h" = row). (Inverted vs Ghostty, where ⌘D splits to the right.)
    {
      id: "split.stacked",
      key: "d",
      ...cmd(),
      label: "Split — new pane stacked",
      run: () => store.splitActivePane("v", newTerminal()),
    },
    {
      id: "split.sideBySide",
      key: "d",
      ...cmd({ shift: true }),
      label: "Split — new pane side by side",
      run: () => store.splitActivePane("h", newTerminal()),
    },
    {
      id: "pane.close",
      key: "w",
      ...cmd(),
      label: "Close pane",
      run: () => {
        const tab = store.activeTab;
        if (tab) store.closePane(tab.activePaneId);
      },
    },

    // Pane focus — ⌘⌥→ / ⌘⌥← cycle the active pane in layout order, then pull
    // keyboard focus into it.
    {
      id: "pane.focusNext",
      key: "ArrowRight",
      ...cmd({ code: "ArrowRight" }),
      alt: true,
      label: "Focus next pane",
      run: () => {
        store.focusRelativePane(1);
        focusActivePane();
      },
    },
    {
      id: "pane.focusPrev",
      key: "ArrowLeft",
      ...cmd({ code: "ArrowLeft" }),
      alt: true,
      label: "Focus previous pane",
      run: () => {
        store.focusRelativePane(-1);
        focusActivePane();
      },
    },

    // Clipboard
    {
      id: "clipboard.copy",
      key: "c",
      ...cmd(),
      label: "Copy selection",
      run: () => {
        const tab = store.activeTab;
        if (!tab) return;
        const inst = getTerminalInstance(tab.activePaneId);
        if (inst && inst.term.hasSelection()) {
          navigator.clipboard.writeText(inst.term.getSelection());
        }
      },
    },
    {
      id: "clipboard.paste",
      key: "v",
      ...cmd(),
      label: "Paste",
      run: async () => {
        const tab = store.activeTab;
        if (!tab) return;
        const inst = getTerminalInstance(tab.activePaneId);
        if (inst && inst.ptyId !== null) {
          const text = await navigator.clipboard.readText();
          if (text) writePty(inst.ptyId, text);
        }
      },
    },

    // Sidebar / search — single ⌘B: closed → open and focus the filter; open →
    // close it and return focus to the active terminal. Fires from inside the
    // filter input too (allowInInput), so the same key dismisses the search.
    //
    // `byOS` example (currently a no-op — the cmd() default already suits both
    // Windows and Linux): to give one platform its own chord, do e.g.
    //   byOS: { windows: { key: "b", ctrl: true, alt: true } },
    {
      id: "sidebar.toggle",
      key: "b",
      ...cmd(),
      allowInInput: true,
      label: "Toggle sidebar / search",
      run: () => {
        if (store.state.sidebarOpen) {
          store.toggleSidebar();
          focusActivePane();
          return;
        }
        store.openSidebar();
        // The input mounts when the sidebar opens, so retry briefly until it's
        // in the DOM, then focus and select any existing filter text.
        let tries = 0;
        const focusFilter = () => {
          const input = document.querySelector<HTMLInputElement>(
            ".file-tree-search input"
          );
          if (input) {
            input.focus();
            input.select();
          } else if (tries++ < 10) {
            setTimeout(focusFilter, 16);
          }
        };
        focusFilter();
      },
    },

    // Font zoom — ⌘= / ⌘+ grow, ⌘- shrink, ⌘0 reset. Codes keep these stable
    // across keyboard layouts where the glyphs move.
    {
      id: "font.increase",
      key: "=",
      ...cmd({ code: "Equal" }),
      label: "Increase font size",
      run: () => increaseFontSize(),
    },
    {
      id: "font.increase.shift",
      key: "=",
      ...cmd({ shift: true, code: "Equal" }),
      label: "Increase font size",
      run: () => increaseFontSize(),
    },
    {
      id: "font.decrease",
      key: "-",
      ...cmd({ code: "Minus" }),
      label: "Decrease font size",
      run: () => decreaseFontSize(),
    },
    {
      id: "font.reset",
      key: "0",
      ...cmd({ code: "Digit0" }),
      label: "Reset font size",
      run: () => resetFontSize(),
    },
  ];
}
