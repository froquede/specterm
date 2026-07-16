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
import {
  writePty,
  clipboardHasImage,
  clipboardReadText,
  clipboardWriteText,
} from "../lib/pty";
import { searchPaneId, openSearch, closeSearch } from "./terminal-search";

// Keystroke that makes Claude Code read an image straight from the OS clipboard
// and drop it inline: Alt+V (ESC v) on Windows/Linux, Ctrl+V (0x16) on macOS —
// its `chat:imagePaste` trigger per platform. We forward the byte; the app
// fetches the bitmap itself, so nothing touches the PTY or disk.
const IMAGE_PASTE_SEQ = isMac ? "\x16" : "\x1bv";

// Smart paste into a PTY. Text wins whenever the clipboard carries any: many
// sources (spreadsheets, browsers) put BOTH a bitmap and text on the clipboard,
// and this chord is the everyday paste on Linux/Windows (Ctrl+Shift+V), so a
// data table must paste as text rather than injecting a stray escape sequence
// into whatever program is in the foreground. Only a text-less clipboard falls
// through to Claude Code's inline image paste; explicit image-inline paste also
// has its own dedicated shortcut (Alt+V, or Ctrl+V on macOS). We only ever ask
// whether an image exists (a boolean) — the image bytes never enter the renderer.
async function pasteClipboard(ptyId: number) {
  try {
    const text = await clipboardReadText();
    if (text) {
      writePty(ptyId, text);
      return;
    }
  } catch (err) {
    // Clipboard text read failed — fall through to the image path so the
    // shortcut never silently dies.
    console.warn("[paste] clipboard text read failed:", err);
  }
  try {
    if (await clipboardHasImage()) {
      writePty(ptyId, IMAGE_PASTE_SEQ);
    }
  } catch (err) {
    console.warn("[paste] clipboard image check failed:", err);
  }
}

export interface KeymapContext {
  store: ReturnType<typeof useTabStore>;
  // Pull keyboard focus back into the active pane's terminal.
  focusActivePane: () => void;
  // Open/close the settings sidebar.
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
    // Settings — ⌘, on macOS (the platform convention for Preferences);
    // Ctrl+Shift+, elsewhere. Toggles the settings sidebar, which shares its
    // slot with the file/search sidebar (⌘B): showing one evicts the other.
    {
      id: "settings.toggle",
      key: ",",
      ...cmd({ code: "Comma" }),
      allowInInput: true,
      label: "Toggle settings",
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

    // Pane focus — ⌥+arrow moves focus to the pane visually adjacent in that
    // direction (spatial, not tree order), then pulls keyboard focus into it.
    // The same chord on every OS: bare Ctrl+arrow / Ctrl+Shift+arrow are spoken
    // for (terminal / tab-switch), and Ctrl+Alt+arrow is grabbed by most Linux
    // desktops' workspace switcher — Alt+arrow reliably reaches the app.
    ...(
      [
        { id: "pane.focusLeft", code: "ArrowLeft", dir: "left" },
        { id: "pane.focusRight", code: "ArrowRight", dir: "right" },
        { id: "pane.focusUp", code: "ArrowUp", dir: "up" },
        { id: "pane.focusDown", code: "ArrowDown", dir: "down" },
      ] as const
    ).map(({ id, code, dir }) => ({
      id,
      key: code,
      code,
      alt: true,
      label: `Focus pane ${dir}`,
      run: () => {
        store.focusDirectionalPane(dir);
        focusActivePane();
      },
    })),

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
          clipboardWriteText(inst.term.getSelection());
          return;
        }
        // No terminal selection: copy the current DOM selection (e.g. text
        // picked in a markdown pane). This app ships no Edit menu — on purpose,
        // so ⌘C reaches the renderer for terminal copy — which on macOS means
        // Electron's native ⌘C never fires. So we write the selection here.
        const domSel = window.getSelection()?.toString();
        if (domSel) clipboardWriteText(domSel);
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
      // allowInInput so a second ⌘F from inside the find box still closes it —
      // but bail if focus is in some *other* real text field (e.g. the sidebar
      // filter), so the shortcut doesn't yank focus out of unrelated editing.
      allowInInput: true,
      label: "Find in terminal",
      run: () => {
        const active = document.activeElement;
        if (
          active instanceof HTMLElement &&
          (active.tagName === "INPUT" || active.tagName === "TEXTAREA") &&
          !active.classList.contains("xterm-helper-textarea") &&
          !active.classList.contains("term-search-input")
        ) {
          return;
        }
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
    // (not the cmd() ⌘⇧→Ctrl+Alt mapping) so both platforms use Shift+V. When
    // the clipboard holds only an image it triggers Claude Code's inline image
    // paste, otherwise it pastes text. On Windows/Linux bare Ctrl+V still flows
    // to xterm's native text paste; macOS has no native path, so bare ⌘V is
    // bound explicitly below.
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
    // macOS-only bare ⌘V — plain text paste. The app ships no Edit menu with a
    // paste role and xterm registers no paste handler, so without this ⌘V would
    // do nothing on macOS. Mirrors the native Ctrl+V text paste on Win/Linux
    // (image-inline stays on ⌘⇧V / Claude Code's Ctrl+V, not here).
    ...(isMac
      ? [
          {
            id: "clipboard.pasteText",
            key: "v",
            meta: true,
            label: "Paste text",
            run: async () => {
              const tab = store.activeTab;
              if (!tab) return;
              const inst = getTerminalInstance(tab.activePaneId);
              if (!inst || inst.ptyId === null) return;
              try {
                const text = await clipboardReadText();
                if (text) writePty(inst.ptyId, text);
              } catch (err) {
                console.warn("[paste] clipboard text read failed:", err);
              }
            },
          } satisfies BindingSpec,
        ]
      : []),
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
        if (store.state.sidebarView === "files") {
          store.closeSidebar();
          focusActivePane();
          return;
        }
        // Showing the file tree evicts settings — the store owns that invariant.
        store.showSidebar("files");
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
