import { createSignal, For, onMount, onCleanup } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Tab } from "../types";

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string;
  sidebarOpen: boolean;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onCreate: () => void;
  onToggleSidebar: () => void;
}

export default function TabBar(props: TabBarProps) {
  const [isFullscreen, setIsFullscreen] = createSignal(false);

  async function toggleFullscreen() {
    const win = getCurrentWindow();
    const current = await win.isFullscreen();
    await win.setFullscreen(!current);
    setIsFullscreen(!current);
  }

  onMount(async () => {
    const win = getCurrentWindow();
    const unlisten = await win.onResized(async () => {
      setIsFullscreen(await win.isFullscreen());
    });
    onCleanup(() => unlisten());
  });

  return (
    <div class="tab-bar">
      <div class="tab-list">
        <For each={props.tabs}>
          {(tab) => (
            <div
              class={`tab ${tab.id === props.activeTabId ? "active" : ""}`}
              onClick={() => props.onSelect(tab.id)}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  props.onClose(tab.id);
                }
              }}
            >
              <span class="tab-title">{tab.title}</span>
              <button
                class="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onClose(tab.id);
                }}
              >
                ×
              </button>
            </div>
          )}
        </For>
      </div>
      <button
        class="tab-sidebar-toggle"
        onClick={props.onToggleSidebar}
        title={props.sidebarOpen ? "Hide sidebar (Ctrl+Shift+B)" : "Show sidebar (Ctrl+Shift+B)"}
      >
        {props.sidebarOpen ? "◧" : "▯"}
      </button>
      <button class="tab-new" onClick={props.onCreate}>
        +
      </button>
      <button
        class="tab-fullscreen"
        onClick={toggleFullscreen}
        title={isFullscreen() ? "Exit fullscreen" : "Fullscreen"}
      >
        {isFullscreen() ? "⊡" : "⊞"}
      </button>
    </div>
  );
}
