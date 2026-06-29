import { createSignal, For, onMount, onCleanup } from "solid-js";
import { getBackend, type UnlistenFn } from "../backends";
import type { Tab } from "../types";

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string;
  sidebarOpen: boolean;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onCreate: () => void;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
}

export default function TabBar(props: TabBarProps) {
  const [isFullscreen, setIsFullscreen] = createSignal(false);

  async function toggleFullscreen() {
    const backend = await getBackend();
    const next = !(await backend.isFullscreen());
    await backend.setFullscreen(next);
    setIsFullscreen(next);
  }

  onMount(async () => {
    const backend = await getBackend();
    setIsFullscreen(await backend.isFullscreen());
    let unlisten: UnlistenFn | undefined;
    try {
      unlisten = await backend.onFullscreenChange(setIsFullscreen);
    } catch (_) {
      // Backend without a fullscreen-change signal — the icon still flips on
      // our own toggle, just not on OS-driven changes.
    }
    onCleanup(() => unlisten?.());
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
      {/* Flexible draggable strip: fills the empty space so the window can be
          moved by dragging the tab bar (the tabs/buttons stay no-drag). */}
      <div class="tab-drag-region" />
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
      <button
        class="tab-settings"
        onClick={props.onOpenSettings}
        title="Settings"
      >
        ⚙
      </button>
    </div>
  );
}
