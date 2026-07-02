// The keymap — the single source of truth for keyboard shortcuts.
//
// Each row is authored macOS-first: cmd() expands a ⌘ shortcut into the host
// OS's chord (⌘X -> Ctrl+Shift+X, ⌘⇧X -> Ctrl+Alt+X on Windows/Linux), keeping
// bare Ctrl+<key> free for the terminal. That mac-vs-rest split covers almost
// everything. Where a platform must diverge, a row adds a `byOS` override —
// here, Linux/Windows keep the original Kitty "Ctrl+Shift+<key>" chords (see
// `kitty()` below) while macOS uses the ⌘ scheme.
import { cmd, isMac } from "../lib/platform";
import type { BindingSpec, Chord } from "./keybindings";
import type { useTabStore } from "./tabs";
import {
  getTerminalInstance,
  increaseFontSize,
  decreaseFontSize,
  resetFontSize,
} from "../lib/terminal-registry";
import { writePty, clipboardHasImage } from "../lib/pty";
import { searchPaneId, openSearch, closeSearch } from "./terminal-search";

// Keystroke that makes Claude Code read an image straight from the OS clipboard
// and drop it inline: Alt+V (ESC v) on Windows/Linux, Ctrl+V (0x16) on macOS —
// its `chat:imagePaste` trigger per platform. We forward the byte; the app
// fetches the bitmap itself, so nothing touches the PTY or disk.
const IMAGE_PASTE_SEQ = isMac ? "\x16" : "\x1bv";

// Smart paste into a PTY. When the clipboard holds an image, forward Claude
// Code's inline image-paste keystroke so it ingests the bitmap directly. Plain
// text falls back to a normal text paste. We only ask whether an image exists
// (a boolean) — the image bytes never enter the renderer.
async function pasteClipboard(ptyId: number) {
  try {
    if (await clipboardHasImage()) {
      writePty(ptyId, IMAGE_PASTE_SEQ);
      return;
    }
  } catch (err) {
    // Backend/preload not ready — log and fall through to a text paste so the
    // shortcut never silently dies.
    console.warn("[paste] clipboard image check failed, using text:", err);
  }
  try {
    const text = await navigator.clipboard.readText();
    if (text) writePty(ptyId, text);
  } catch (err) {
    console.warn("[paste] clipboard text read failed:", err);
  }
}

export interface KeymapContext {
  store: ReturnType<typeof useTabStore>;
  // Pull keyboard focus back into the active pane's terminal.
  focusActivePane: () => void;
  // Open/close the settings panel.
  toggleSettings: () => void;
}

const newTerminal = () =>
  ({ kind: "terminal", ptyId: null, cwd: "" }) as const;

// Linux/Windows keep the original Kitty-style "Ctrl+Shift+<key>" defaults; only
// macOS adopted the ⌘ scheme. `kitty(key)` pins that original chord on non-mac
// so those platforms behave exactly as they did before the macOS keymap landed.
// (macOS still uses the row's cmd()-authored default.)
const kitty = (key: string): { windows: Chord; linux: Chord } => {
  const chord: Chord = { key, ctrl: true, shift: true };
  return { windows: chord, linux: chord };
};

export function createKeymap({
  store,
  focusActivePane,
  toggleSettings,
}: KeymapContext): BindingSpec[] {
  return [
    // Settings — ⌘, on macOS (the platform convention); Ctrl+Shift+, elsewhere.
    {
      id: "settings.toggle",
      key: ",",
      ...cmd({ code: "Comma" }),
      allowInInput: true,
      label: "Open settings",
      run: () => toggleSettings(),
    },
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
      byOS: kitty("q"),
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
      byOS: kitty("ArrowRight"),
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
      byOS: kitty("ArrowLeft"),
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
      byOS: kitty("s"),
      label: "Split — new pane stacked",
      run: () => store.splitActivePane("v", newTerminal()),
    },
    {
      id: "split.sideBySide",
      key: "d",
      ...cmd({ shift: true }),
      byOS: kitty("enter"),
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
        const inst = tab && getTerminalInstance(tab.activePaneId);
        if (inst && inst.term.hasSelection()) {
          navigator.clipboard.writeText(inst.term.getSelection());
          return;
        }
        // No terminal selection: copy the current DOM selection (e.g. text
        // picked in a markdown pane). This app ships no Edit menu — on purpose,
        // so ⌘C reaches the renderer for terminal copy — which on macOS means
        // Electron's native ⌘C never fires. So we write the selection here.
        const domSel = window.getSelection()?.toString();
        if (domSel) navigator.clipboard.writeText(domSel);
      },
    },
    // Find in the active terminal — ⌘F (Ctrl+Shift+F on Win/Linux). Toggles a
    // find bar over the active pane (like ⌘B for the sidebar): open with focus,
    // or close and return to the terminal. No-op when the pane isn't a terminal
    // (a markdown pane has its own ⌘F). allowInInput so a second ⌘F from inside
    // the find box still closes it.
    {
      id: "terminal.search",
      key: "f",
      ...cmd(),
      allowInInput: true,
      label: "Find in terminal",
      run: () => {
        const paneId = store.activeTab?.activePaneId;
        const inst = paneId ? getTerminalInstance(paneId) : undefined;
        if (!paneId || !inst) return;
        if (searchPaneId() === paneId) {
          closeSearch();
          inst.term.focus();
          return;
        }
        openSearch(paneId);
        const input = document.querySelector<HTMLInputElement>(
          ".term-search-input"
        );
        if (input) {
          input.focus();
          input.select();
        }
      },
    },
    // Paste — ⌘⇧V on macOS, Ctrl+Shift+V on Windows/Linux. A literal chord
    // (not the cmd() ⌘⇧→Ctrl+Alt mapping) so both platforms use Shift+V, and
    // bare ⌘V / Ctrl+V still flow to the terminal's native text paste. When the
    // clipboard holds an image it triggers Claude Code's inline image paste,
    // otherwise it pastes text.
    {
      id: "clipboard.paste",
      key: "v",
      meta: true,
      shift: true,
      byOS: kitty("v"),
      label: "Paste (image inline, else text)",
      run: async () => {
        const tab = store.activeTab;
        if (!tab) return;
        const inst = getTerminalInstance(tab.activePaneId);
        if (inst && inst.ptyId !== null) {
          await pasteClipboard(inst.ptyId);
        }
      },
    },
    // Inline image paste — forward Alt+V to the PTY as ESC+v so Claude Code's
    // `chat:imagePaste` fires and reads the bitmap straight from the clipboard
    // (its native Windows/Linux shortcut). We bind it ourselves so Electron's
    // Alt menu-mnemonic doesn't swallow the key before xterm sees it. macOS is
    // excluded: there ⌥V types a glyph and Claude Code uses Ctrl+V instead,
    // which already passes through untouched.
    ...(isMac
      ? []
      : [
          {
            id: "clipboard.pasteImageInline",
            key: "v",
            alt: true,
            label: "Paste image inline (Claude Code Alt+V)",
            run: () => {
              const tab = store.activeTab;
              if (!tab) return;
              const inst = getTerminalInstance(tab.activePaneId);
              if (inst && inst.ptyId !== null) writePty(inst.ptyId, "\x1bv");
            },
          } satisfies BindingSpec,
        ]),

    // Sidebar / search — single ⌘B: closed → open and focus the filter; open →
    // close it and return focus to the active terminal. Fires from inside the
    // filter input too (allowInInput), so the same key dismisses the search.
    // (Ctrl+Shift+B on Linux/Windows via cmd() — already the original chord.)
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
