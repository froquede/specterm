import { Show, onMount, createEffect, onCleanup, createSignal } from "solid-js";
import { useTabStore } from "./stores/tabs";
import { initKeybindings, registerBindings } from "./stores/keybindings";
import { createKeymap } from "./stores/keymap";
import { initSettings } from "./stores/settings";
import { initTheme, importBase16Theme } from "./stores/theme";
import { getTerminalInstance } from "./lib/terminal-registry";
import { writePty } from "./lib/pty";
import TabBar from "./components/TabBar";
import SplitContainer from "./components/SplitContainer";
import FileTree from "./components/FileTree";
import SettingsPanel from "./components/SettingsPanel";

export default function App() {
  const store = useTabStore();
  const [settingsOpen, setSettingsOpen] = createSignal(false);

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
    // Cancel a still-pending frame if the active pane changes again first, so
    // rapid tab/pane switches don't queue up stale focus calls.
    const raf = requestAnimationFrame(focusActiveTerminal);
    onCleanup(() => cancelAnimationFrame(raf));
  });

  // Send `cd <path>` to the active pane's shell. Used by the file tree's
  // favorites (click or the "fav-N" search token).
  function cdActivePane(path: string) {
    const tab = store.activeTab;
    if (!tab) return;
    const inst = getTerminalInstance(tab.activePaneId);
    if (inst && inst.ptyId !== null) {
      const quoted = "'" + path.replace(/'/g, "'\\''") + "'";
      writePty(inst.ptyId, `cd ${quoted}\n`);
      inst.term.focus();
    }
  }

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
    // All shortcuts live in the keymap (src/stores/keymap.ts) — a single
    // declarative table, authored macOS-first and resolved per-OS (with
    // optional per-platform overrides). Handlers that need component scope
    // (the store, focusActivePane) are threaded in here.
    registerBindings(
      createKeymap({
        store,
        focusActivePane,
        toggleSettings: () => setSettingsOpen((v) => !v),
      })
    );

    initKeybindings();

    // Apply persisted appearance settings (e.g. unfocused-pane opacity) to the
    // DOM before the first paint settles.
    initSettings();

    // Apply the persisted color theme (CSS variables + terminal palette).
    initTheme();

    // When the OS window regains focus, return the cursor to the active pane.
    window.addEventListener("focus", focusActiveTerminal);

    // Drag a base16 theme file (.yaml/.json) onto the window to import it. Only
    // OS file drops are intercepted — internal pane drags don't carry a "Files"
    // type, so they fall through to the pane drag-and-drop logic untouched. The
    // preventDefault on dragover is required, or the drop navigates the window
    // to the file instead of firing our handler.
    const isFileDrag = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onDragOver = (e: DragEvent) => {
      if (isFileDrag(e)) e.preventDefault();
    };
    const onDrop = async (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      if (!importBase16Theme(await file.text())) {
        console.warn(`[theme] "${file.name}" is not a valid base16 scheme`);
      }
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    onCleanup(() => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    });
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
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <div class="app-body">
        <FileTree
          open={store.state.sidebarOpen}
          width={store.state.sidebarWidth}
          onOpenFile={handleOpenMarkdown}
          onCdPath={cdActivePane}
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
      <SettingsPanel open={settingsOpen()} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
