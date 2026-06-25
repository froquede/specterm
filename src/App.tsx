import { Show, onMount, createEffect } from "solid-js";
import { useTabStore } from "./stores/tabs";
import { initKeybindings, registerBinding } from "./stores/keybindings";
import { cmd, isMac } from "./lib/platform";
import {
  getTerminalInstance,
  increaseFontSize,
  decreaseFontSize,
  resetFontSize,
} from "./lib/terminal-registry";
import { writePty } from "./lib/pty";
import { collectLeaves } from "./lib/split-tree";
import TabBar from "./components/TabBar";
import SplitContainer from "./components/SplitContainer";
import FileTree from "./components/FileTree";

export default function App() {
  const store = useTabStore();

  // Keep keyboard focus on the active pane's terminal. The active pane is the
  // one drawn at full opacity (others are dimmed), so typing must always land
  // there — even after splits, drag-reorders or tab switches remount panes.
  function focusActiveTerminal() {
    const tab = store.activeTab;
    if (!tab) return;
    // Don't steal focus from a real text field (e.g. the sidebar search opened
    // by ⌘B); only xterm's hidden textarea should yield to the terminal.
    const ae = document.activeElement;
    if (
      ae instanceof HTMLElement &&
      (ae.tagName === "INPUT" ||
        (ae.tagName === "TEXTAREA" &&
          !ae.classList.contains("xterm-helper-textarea")))
    ) {
      return;
    }
    getTerminalInstance(tab.activePaneId)?.term.focus();
  }

  createEffect(() => {
    const tab = store.activeTab;
    if (!tab) return;
    // Track the active pane id so the effect re-runs when focus moves.
    void tab.activePaneId;
    // Wait a frame so a just-remounted terminal is in the DOM before focusing.
    requestAnimationFrame(focusActiveTerminal);
  });

  function handleOpenMarkdown(path: string, mode: "split" | "tab") {
    const mdPane = { kind: "markdown" as const, filePath: path };

    if (mode === "tab") {
      store.createMarkdownTab(path);
    } else {
      store.splitActivePane("h", mdPane);
    }
  }

  onMount(() => {
    // Shortcuts are authored macOS / Ghostty-style (⌘ = primary command key).
    // cmd() translates them per-OS: ⌘X -> Ctrl+Shift+X and ⌘⇧X -> Ctrl+Alt+X
    // on Windows/Linux, keeping bare Ctrl+<key> free for the terminal.

    // Tabs
    registerBinding("t", () => store.createTab(), cmd());
    registerBinding("w", () => {
      // ⌘⇧W — close tab
      const tab = store.activeTab;
      if (tab) store.closeTab(tab.id);
    }, cmd({ shift: true }));
    registerBinding("]", () => {
      const tabs = store.state.tabs;
      const idx = tabs.findIndex((t) => t.id === store.state.activeTabId);
      if (tabs.length > 1) {
        store.setActiveTab(tabs[(idx + 1) % tabs.length].id);
      }
    }, cmd({ shift: true, code: "BracketRight" }));
    registerBinding("[", () => {
      const tabs = store.state.tabs;
      const idx = tabs.findIndex((t) => t.id === store.state.activeTabId);
      if (tabs.length > 1) {
        store.setActiveTab(tabs[(idx - 1 + tabs.length) % tabs.length].id);
      }
    }, cmd({ shift: true, code: "BracketLeft" }));

    // Splits — ⌘D side-by-side, ⌘⇧D stacked (matches Ghostty)
    registerBinding("d", () => {
      store.splitActivePane("v", { kind: "terminal", ptyId: null, cwd: "" });
    }, cmd());
    registerBinding("d", () => {
      store.splitActivePane("h", { kind: "terminal", ptyId: null, cwd: "" });
    }, cmd({ shift: true }));
    registerBinding("w", () => {
      // ⌘W — close pane
      const tab = store.activeTab;
      if (tab) store.closePane(tab.activePaneId);
    }, cmd());

    // New split — literal Ctrl+Shift+S / Ctrl+Shift+Enter on Win/Linux
    // (⌘⇧S / ⌘⇧Enter on macOS): S stacks the pane (vertical), Enter places it
    // side-by-side (horizontal).
    const splitMods = isMac
      ? { meta: true, shift: true }
      : { ctrl: true, shift: true };
    registerBinding("s", () => {
      store.splitActivePane("v", { kind: "terminal", ptyId: null, cwd: "" });
    }, splitMods);
    registerBinding("enter", () => {
      store.splitActivePane("h", { kind: "terminal", ptyId: null, cwd: "" });
    }, splitMods);

    // Split orientation — ⌘⇧← / → make the active pane's split horizontal
    // (side-by-side), ⌘⇧↑ / ↓ make it vertical (stacked). The user asked for
    // Ctrl+Shift+Arrow on Win/Linux and ⌘⇧Arrow on macOS, so bind those
    // directly rather than through cmd() (whose shift variant maps to Alt).
    const arrowMods = (code: string) =>
      isMac
        ? { meta: true, shift: true, code }
        : { ctrl: true, shift: true, code };
    const setDir = (dir: "h" | "v") => () => {
      const tab = store.activeTab;
      if (tab) store.setSplitDirectionForPane(tab.activePaneId, dir);
    };
    registerBinding("", setDir("h"), arrowMods("ArrowLeft"));
    registerBinding("", setDir("h"), arrowMods("ArrowRight"));
    registerBinding("", setDir("v"), arrowMods("ArrowUp"));
    registerBinding("", setDir("v"), arrowMods("ArrowDown"));

    // Clipboard
    registerBinding("c", () => {
      const tab = store.activeTab;
      if (!tab) return;
      const inst = getTerminalInstance(tab.activePaneId);
      if (inst && inst.term.hasSelection()) {
        navigator.clipboard.writeText(inst.term.getSelection());
      }
    }, cmd());
    registerBinding("v", async () => {
      const tab = store.activeTab;
      if (!tab) return;
      const inst = getTerminalInstance(tab.activePaneId);
      if (inst && inst.ptyId !== null) {
        const text = await navigator.clipboard.readText();
        if (text) writePty(inst.ptyId, text);
      }
    }, cmd());

    // Sidebar / search — ⌘B (Ctrl+Shift+B on Win/Linux): when the sidebar is
    // closed, open it and focus the folder-filter field; when already open,
    // close it. One key both opens-with-focus and dismisses the search.
    registerBinding("b", () => {
      if (store.state.sidebarOpen) {
        store.toggleSidebar();
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
    }, { ...cmd(), allowInInput: true });

    // Font zoom — ⌘= / ⌘+ to grow, ⌘- to shrink, ⌘0 to reset
    registerBinding("=", () => increaseFontSize(), cmd({ code: "Equal" }));
    registerBinding("=", () => increaseFontSize(), cmd({ shift: true, code: "Equal" }));
    registerBinding("-", () => decreaseFontSize(), cmd({ code: "Minus" }));
    registerBinding("0", () => resetFontSize(), cmd({ code: "Digit0" }));

    // Tab / Shift+Tab cycle panes within the active tab (forward / backward,
    // wrapping). collectLeaves yields panes left-to-right.
    const cyclePane = (dir: 1 | -1) => {
      const tab = store.activeTab;
      if (!tab) return;
      const ids = collectLeaves(tab.root).map((l) => l.id);
      if (ids.length < 2) return;
      const i = ids.indexOf(tab.activePaneId);
      store.setActivePaneId(ids[(i + dir + ids.length) % ids.length]);
    };
    registerBinding("", () => cyclePane(1), { code: "Tab" });
    registerBinding("", () => cyclePane(-1), { shift: true, code: "Tab" });

    initKeybindings();

    // When the OS window regains focus, return the cursor to the active pane.
    window.addEventListener("focus", focusActiveTerminal);
  });

  return (
    <div class="app">
      <TabBar
        tabs={store.state.tabs}
        activeTabId={store.state.activeTabId}
        sidebarOpen={store.state.sidebarOpen}
        onSelect={(id) => store.setActiveTab(id)}
        onClose={(id) => store.closeTab(id)}
        onCreate={() => store.createTab()}
        onToggleSidebar={() => store.toggleSidebar()}
      />
      <div class="app-body">
        <FileTree
          open={store.state.sidebarOpen}
          width={store.state.sidebarWidth}
          onOpenFile={handleOpenMarkdown}
        />
        <div class="app-content">
          <Show when={store.activeTab}>
            {(tab) => (
              <SplitContainer
                node={tab().root}
                activePaneId={tab().activePaneId}
                tabId={tab().id}
                onFocusPane={(id) => store.setActivePaneId(id)}
                onResizeSplit={(splitId, ratio) =>
                  store.resizeSplit(splitId, ratio)
                }
                onToggleDirection={(splitId) =>
                  store.toggleSplitDirection(splitId)
                }
                onDropPane={(sourceId, targetId, edge) =>
                  store.movePane(sourceId, targetId, edge)
                }
                onTitle={(title) => store.updateTabTitle(tab().id, title)}
                onClosePane={(id) => store.closePane(id)}
                onOpenMarkdown={handleOpenMarkdown}
              />
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}
