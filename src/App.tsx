import { Show, onMount } from "solid-js";
import { useTabStore } from "./stores/tabs";
import { initKeybindings, registerBinding } from "./stores/keybindings";
import { getTerminalInstance } from "./lib/terminal-registry";
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

  onMount(() => {
    // Kitty-style shortcuts (all Ctrl+Shift+key)

    // Tabs
    registerBinding("t", () => store.createTab(), { ctrl: true, shift: true });
    registerBinding("q", () => {
      const tab = store.activeTab;
      if (tab) store.closeTab(tab.id);
    }, { ctrl: true, shift: true });
    registerBinding("arrowright", () => {
      const tabs = store.state.tabs;
      const idx = tabs.findIndex((t) => t.id === store.state.activeTabId);
      if (tabs.length > 1) {
        store.setActiveTab(tabs[(idx + 1) % tabs.length].id);
      }
    }, { ctrl: true, shift: true });
    registerBinding("arrowleft", () => {
      const tabs = store.state.tabs;
      const idx = tabs.findIndex((t) => t.id === store.state.activeTabId);
      if (tabs.length > 1) {
        store.setActiveTab(tabs[(idx - 1 + tabs.length) % tabs.length].id);
      }
    }, { ctrl: true, shift: true });

    // Windows/panes
    registerBinding("enter", () => {
      store.splitActivePane("h", { kind: "terminal", ptyId: null, cwd: "" });
    }, { ctrl: true, shift: true });
    registerBinding("\\", () => {
      store.splitActivePane("v", { kind: "terminal", ptyId: null, cwd: "" });
    }, { ctrl: true, shift: true });
    registerBinding("w", () => {
      const tab = store.activeTab;
      if (tab) store.closePane(tab.activePaneId);
    }, { ctrl: true, shift: true });

    // Clipboard
    registerBinding("c", () => {
      const tab = store.activeTab;
      if (!tab) return;
      const inst = getTerminalInstance(tab.activePaneId);
      if (inst && inst.term.hasSelection()) {
        navigator.clipboard.writeText(inst.term.getSelection());
      }
    }, { ctrl: true, shift: true });
    registerBinding("v", async () => {
      const tab = store.activeTab;
      if (!tab) return;
      const inst = getTerminalInstance(tab.activePaneId);
      if (inst && inst.ptyId !== null) {
        const text = await navigator.clipboard.readText();
        if (text) writePty(inst.ptyId, text);
      }
    }, { ctrl: true, shift: true });

    // Sidebar
    registerBinding("b", () => store.toggleSidebar(), { ctrl: true, shift: true });

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
