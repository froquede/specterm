import { createSignal, For, Show, onMount, onCleanup } from "solid-js";
import { getBackend, type UnlistenFn } from "../backends";
import { shortcutLabel } from "../lib/platform";
import { clockEnabled, tabBarSide } from "../stores/settings";
import Clock from "./Clock";
import {
  draggingTabId,
  setDraggingTabId,
  tabDropTarget,
  setTabDropTarget,
} from "../stores/tab-drag";
import { draggingPaneId, dropTabId, dropNewTab } from "../stores/pane-drag";
import { tearingOff, trackTearOff, endTearOff } from "../stores/tear-off";
import { paneAttention, type AttentionKind } from "../stores/attention";
import { collectLeaves } from "../lib/split-tree";
import type { Tab } from "../types";

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string;
  sidebarOpen: boolean;
  renamingTabId: string | null;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onCreate: () => void;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
  onStartRename: (tabId: string) => void;
  onCommitRename: (tabId: string, title: string) => void;
  onCancelRename: () => void;
  onReorder: (sourceId: string, targetId: string, before: boolean) => void;
  // Released outside the window: hand this tab off to another window (or a new
  // one). See src/stores/tear-off.ts.
  onTearOff: (tabId: string) => void;
  settingsOpen: boolean;
}

// Minimum pointer travel (px) before a tab press counts as a drag rather than
// a click. Tabs have no dedicated drag handle (unlike panes' title-bar), so a
// plain click must not trigger a reorder.
const DRAG_THRESHOLD = 4;

// Is anything in this tab waiting on the user, and if so what's the most urgent
// of it? A tab is only ever a summary of its panes: the dot says "there is
// something in here", the pane title-bars inside say which pane. A permission
// prompt outranks a finished turn — one blocks until answered, the other waits
// patiently — so with both open the chip shows the prompt.
function tabAttention(tab: Tab): AttentionKind | undefined {
  let found: AttentionKind | undefined;
  for (const leaf of collectLeaves(tab.root)) {
    const kind = paneAttention(leaf.id);
    if (kind === "permission") return kind;
    found ??= kind;
  }
  return found;
}

const ATTENTION_TITLE: Record<AttentionKind, string> = {
  permission: "Waiting for your answer",
  idle: "Finished — waiting for you",
  bell: "Rang the terminal bell",
};

// Gear glyph as a single evenodd path (Material "settings"): the center circle
// is a cut-out, so it reads as an outline when stroked (fill none) and as a
// solid gear when filled — which is how we show the settings sidebar's state.
const GEAR_PATH =
  "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z";

// The inline tab-rename editor. A fresh instance mounts each time a tab
// enters rename mode (its parent <Show> disposes/recreates it), so `settled`
// — guarding against a Escape/Enter *and* the blur it triggers both firing a
// commit/cancel — starts false on every edit session without extra plumbing.
function TabTitleInput(props: {
  title: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  let settled = false;
  return (
    <input
      class="tab-title-input"
      ref={(el) => {
        el.value = props.title;
        // Focus needs a frame: the input isn't laid out yet on this same tick.
        requestAnimationFrame(() => {
          el.focus();
          el.select();
        });
      }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          settled = true;
          props.onCommit((e.currentTarget as HTMLInputElement).value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          settled = true;
          props.onCancel();
        }
      }}
      onBlur={(e) => {
        if (settled) return;
        settled = true;
        props.onCommit((e.currentTarget as HTMLInputElement).value);
      }}
    />
  );
}

export default function TabBar(props: TabBarProps) {
  const [isFullscreen, setIsFullscreen] = createSignal(false);
  // Set right before a completed drag's reorder call, so the click event that
  // follows pointerup doesn't also re-select a tab out from under the drag.
  let suppressClick = false;

  // Pointer-driven drag-to-reorder, modeled on Pane.tsx's title-bar drag
  // (src/components/Pane.tsx:56-96) but adapted for a target that is ALSO the
  // click-to-select surface and hosts a close button + rename hit-area.
  //
  // We deliberately do NOT use setPointerCapture here. Capturing on pointerdown
  // makes Chromium retarget the follow-up compatibility mouse events — `click`
  // AND `dblclick` — to the capturing element (the tab), so the close button's
  // onClick and the title's onDblClick would never fire (the × just re-selected
  // the tab; double-click never entered rename). Instead we track movement on
  // window listeners, which follow the pointer outside the tab's bounds just as
  // capture would, and gate the reorder behind a small movement threshold so a
  // plain click/double-click is left completely untouched.
  function onTabPointerDown(e: PointerEvent, tabId: string) {
    if (e.button !== 0) return;
    // Clear any stale suppress left by a prior drag whose pointerup landed on a
    // different tab (so no click fired there to consume it). A genuine click in
    // THIS gesture arrives after pointerup, so resetting here is safe.
    suppressClick = false;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;

    function onMove(ev: PointerEvent) {
      if (!dragging) {
        if (
          Math.abs(ev.clientX - startX) < DRAG_THRESHOLD &&
          Math.abs(ev.clientY - startY) < DRAG_THRESHOLD
        ) {
          return;
        }
        dragging = true;
        setDraggingTabId(tabId);
      }
      // Dragged clear of the window: no reorder target can apply any more, and
      // releasing here means "move this tab out". The host is told as we go, so
      // the window under the cursor can show it is about to receive this tab.
      if (trackTearOff(ev)) {
        setTabDropTarget(null);
        return;
      }
      const target = document
        .elementFromPoint(ev.clientX, ev.clientY)
        ?.closest<HTMLElement>("[data-tab-id]");
      const targetId = target?.getAttribute("data-tab-id");
      if (!target || !targetId || targetId === tabId) {
        setTabDropTarget(null);
        return;
      }
      const rect = target.getBoundingClientRect();
      setTabDropTarget({
        tabId: targetId,
        before: ev.clientX < rect.left + rect.width / 2,
      });
    }

    function teardown() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    }

    function onUp() {
      teardown();
      if (dragging) {
        const dt = tabDropTarget();
        const tearOff = tearingOff();
        setDraggingTabId(null);
        setTabDropTarget(null);
        endTearOff();
        if (tearOff) {
          suppressClick = true;
          props.onTearOff(tabId);
        } else if (dt) {
          suppressClick = true;
          props.onReorder(tabId, dt.tabId, dt.before);
        }
      }
    }

    function onCancel() {
      teardown();
      setDraggingTabId(null);
      setTabDropTarget(null);
      endTearOff();
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }

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

  const sidebarKey = () => shortcutLabel("B");
  const settingsKey = () => shortcutLabel(",");

  // The bar's three regions are ordered by CSS (see .tab-bar[data-side]), so
  // anchoring the tabs and icons to the right corner is a reflow, not a
  // different DOM: the tabs keep their left-to-right reading order either way.
  // A pane is being dragged over the bar itself, not over any chip in it:
  // releasing gives it a tab of its own. The whole bar lights up, and a ghost
  // chip shows where that tab will appear.
  //
  // Not for a pane that is already the whole tab, though: it has nothing to
  // detach from, so the drop is a no-op and lighting the bar up would promise
  // something that doesn't happen.
  const activeTab = () => props.tabs.find((t) => t.id === props.activeTabId);
  const newTabDrop = () => {
    if (draggingPaneId() === null || !dropNewTab()) return false;
    const tab = activeTab();
    return !!tab && collectLeaves(tab.root).length > 1;
  };

  return (
    <div
      class="tab-bar"
      classList={{
        "drop-new-tab": newTabDrop(),
        // A pane is in flight anywhere: keep an auto-hidden bar out where it can
        // be aimed at, since it is one of the places the pane can land.
        "pane-dragging": draggingPaneId() !== null,
      }}
      data-side={tabBarSide()}
    >
      <div class="tab-actions">
        <button
          class="tab-sidebar-toggle"
          onClick={props.onToggleSidebar}
          title={`${props.sidebarOpen ? "Hide" : "Show"} sidebar (${sidebarKey()})`}
        >
          {props.sidebarOpen ? "◧" : "▯"}
        </button>
        <button class="tab-new" onClick={props.onCreate} title="New tab">
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
          title={`${props.settingsOpen ? "Hide" : "Open"} settings (${settingsKey()})`}
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
      </div>
      <div class="tab-list">
        <For each={props.tabs}>
          {(tab) => (
            <div
              class="tab"
              classList={{
                active: tab.id === props.activeTabId,
                dragging: draggingTabId() === tab.id,
                // Cursor is outside the window — release moves this tab out.
                "tearing-off": draggingTabId() === tab.id && tearingOff(),
                // Highlighted while a dragged pane hovers this chip — release
                // detaches the pane into this tab. Never the source tab (always
                // the active one), where the drop would be a no-op.
                "drop-tab":
                  draggingPaneId() !== null &&
                  dropTabId() === tab.id &&
                  tab.id !== props.activeTabId,
              }}
              data-tab-id={tab.id}
              onClick={() => {
                if (suppressClick) {
                  suppressClick = false;
                  return;
                }
                props.onSelect(tab.id);
              }}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  props.onClose(tab.id);
                }
              }}
              onPointerDown={(e) => onTabPointerDown(e, tab.id)}
            >
              <Show when={tabAttention(tab)} keyed>
                {(kind) => (
                  <span
                    class="tab-attention"
                    data-kind={kind}
                    title={ATTENTION_TITLE[kind]}
                  />
                )}
              </Show>
              <Show
                when={props.renamingTabId === tab.id}
                fallback={
                  <span
                    class="tab-title"
                    onDblClick={(e) => {
                      e.stopPropagation();
                      props.onStartRename(tab.id);
                    }}
                  >
                    {tab.title}
                  </span>
                }
              >
                <TabTitleInput
                  title={tab.title}
                  onCommit={(title) => props.onCommitRename(tab.id, title)}
                  onCancel={props.onCancelRename}
                />
              </Show>
              <button
                class="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onClose(tab.id);
                }}
              >
                ×
              </button>
              <Show
                when={
                  draggingTabId() !== null &&
                  tabDropTarget()?.tabId === tab.id
                }
              >
                <div
                  class={`tab-drop-indicator ${
                    tabDropTarget()!.before ? "before" : "after"
                  }`}
                />
              </Show>
            </div>
          )}
        </For>
        {/* Where the pane will land if it's released now. */}
        <Show when={newTabDrop()}>
          <div class="tab tab-ghost">
            <span class="tab-title">New tab</span>
          </div>
        </Show>
      </div>
      {/* Flexible draggable strip: fills the empty space so the window can be
          moved by dragging the tab bar (the tabs/buttons stay no-drag). */}
      <div class="tab-drag-region" />
      {/* Optional clock, at the far end from the tabs. Mounted only when it's
          switched on, so when it's off there is no timer running at all. */}
      <Show when={clockEnabled()}>
        <Clock />
      </Show>
    </div>
  );
}
