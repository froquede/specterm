import { Show, onMount } from "solid-js";
import { useTabStore } from "./stores/tabs";
import { initKeybindings, registerBinding } from "./stores/keybindings";
import { cmd } from "./lib/platform";
import {
  getTerminalInstance,
  increaseFontSize,
  decreaseFontSize,
  resetFontSize,
} from "./lib/terminal-registry";
import { writePty } from "./lib/pty";
import TabBar from "./components/TabBar";
import SplitContainer from "./components/SplitContainer";
import FileTree from "./components/FileTree";

export default function App() {
  const store = useTabStore();

  function handleOpenMarkdown(path: string, mode: "split" | "tab") {
    const mdPane = { kind: "markdown" as const, filePath: path };

    if (mode === "tab") {
      store.createMarkdownTab(path);
    } else {
      store.splitActivePane("h", mdPane);
    }
  }

  // Move keyboard focus back into the active tab's terminal (or, if that pane
  // isn't a terminal, just drop focus from wherever it is — e.g. the filter).
  function focusActivePane() {
    const paneId = store.activeTab?.activePaneId;
    const term = paneId ? getTerminalInstance(paneId) : undefined;
    if (term) {
      term.term.focus();
    } else if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
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

    // Pane focus — ⌘⌥→ next grid, ⌘⌥← previous grid, in layout order.
    // After moving the active pane, pull keyboard focus into it.
    registerBinding("ArrowRight", () => {
      store.focusRelativePane(1);
      focusActivePane();
    }, { ...cmd({ code: "ArrowRight" }), alt: true });
    registerBinding("ArrowLeft", () => {
      store.focusRelativePane(-1);
      focusActivePane();
    }, { ...cmd({ code: "ArrowLeft" }), alt: true });

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

    // Sidebar
    // ⌘B toggles the sidebar. When it closes (including when the folder filter
    // currently has focus), pull focus back to the active terminal pane so you
    // land straight back on the grid you were working in.
    registerBinding(
      "b",
      () => {
        store.toggleSidebar();
        if (!store.state.sidebarOpen) focusActivePane();
      },
      { ...cmd(), allowInInput: true }
    );
    // ⌘⇧B — open the sidebar (if closed) and focus its folder filter field.
    registerBinding("b", () => {
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
    }, cmd({ shift: true }));

    // Font zoom — ⌘= / ⌘+ to grow, ⌘- to shrink, ⌘0 to reset
    registerBinding("=", () => increaseFontSize(), cmd({ code: "Equal" }));
    registerBinding("=", () => increaseFontSize(), cmd({ shift: true, code: "Equal" }));
    registerBinding("-", () => decreaseFontSize(), cmd({ code: "Minus" }));
    registerBinding("0", () => resetFontSize(), cmd({ code: "Digit0" }));

    initKeybindings();
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
          onDismiss={focusActivePane}
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
