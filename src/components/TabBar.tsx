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
  settingsOpen: boolean;
}

// Gear glyph as a single evenodd path (Material "settings"): the center circle
// is a cut-out, so it reads as an outline when stroked (fill none) and as a
// solid gear when filled — which is how we show the settings sidebar's state.
const GEAR_PATH =
  "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z";

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
        classList={{ active: props.settingsOpen }}
        onClick={props.onOpenSettings}
        aria-pressed={props.settingsOpen}
        title={
          props.settingsOpen
            ? "Hide settings (Ctrl+Shift+O)"
            : "Settings (Ctrl+Shift+O)"
        }
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill={props.settingsOpen ? "currentColor" : "none"}
          stroke="currentColor"
          stroke-width={props.settingsOpen ? 0 : 1.4}
          stroke-linejoin="round"
        >
          <path d={GEAR_PATH} fill-rule="evenodd" />
        </svg>
      </button>
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
    </div>
  );
}
