import { For, Show } from "solid-js";
import { shortcutLabel } from "../lib/platform";
import { clockEnabled, tabBarSide, tabBarEdge } from "../stores/settings";
import {
  ownControls,
  isFullscreen,
  toggleFullscreen,
} from "../stores/window-chrome";
import {
  IconSidebarOpen,
  IconSidebarClose,
  IconPlus,
  IconFullscreen,
  IconFullscreenExit,
  IconSettings,
  IconX,
  ICON_SIZE,
  ICON_STROKE,
} from "../lib/icons";
import Clock from "./Clock";
import WindowControls from "./WindowControls";
import {
  draggingTabId,
  setDraggingTabId,
  tabDropTarget,
  setTabDropTarget,
} from "../stores/tab-drag";
import { draggingPaneId, dropTabId, dropNewTab } from "../stores/pane-drag";
import { tearingOff, trackTearOff, endTearOff } from "../stores/tear-off";
import {
  paneAttention,
  paneAttentionMessage,
  attentionTitle,
  type AttentionKind,
} from "../stores/attention";
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

// Cooldown between wheel-driven tab switches. A trackpad swipe fires dozens of
// small wheel events for one gesture — without this, a single swipe over the
// tab strip would flip through half the open tabs instead of moving one at a
// time the way a physical mouse wheel's notches do.
const WHEEL_SWITCH_THROTTLE_MS = 220;

// Is anything in this tab waiting on the user, and if so what's the most urgent
// of it? A tab is only ever a summary of its panes: the dot says "there is
// something in here", the pane title-bars inside say which pane. A permission
// prompt outranks a finished turn — one blocks until answered, the other waits
// patiently — so with both open the chip shows the prompt.
interface TabAttention {
  kind: AttentionKind;
  // What the program said, when it sent a notification sequence rather than
  // just a bell. Carried up with the kind so the chip's tooltip can show it
  // without the tab bar having to know which pane it came from.
  message?: string;
}

function tabAttention(tab: Tab): TabAttention | undefined {
  let found: TabAttention | undefined;
  for (const leaf of collectLeaves(tab.root)) {
    const kind = paneAttention(leaf.id);
    if (!kind) continue;
    const entry: TabAttention = {
      kind,
      message: paneAttentionMessage(leaf.id),
    };
    if (kind === "permission") return entry;
    found ??= entry;
  }
  return found;
}

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

  // Scrolling over the tab strip switches the active tab instead of scrolling
  // it — mirrors ⌘]/⌘[ (see keymap.ts's tab.next/tab.prev), wrapping past
  // either end rather than stopping.
  let lastWheelSwitchAt = 0;
  function onTabListWheel(e: WheelEvent) {
    const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (delta === 0) return;
    e.preventDefault();

    const now = Date.now();
    if (now - lastWheelSwitchAt < WHEEL_SWITCH_THROTTLE_MS) return;

    const tabs = props.tabs;
    if (tabs.length < 2) return;
    const idx = tabs.findIndex((t) => t.id === props.activeTabId);
    if (idx === -1) return;

    lastWheelSwitchAt = now;
    const next = delta > 0 ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length;
    props.onSelect(tabs[next].id);
  }

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
        {/* The sidebar toggle shows what the click will do, not what is: the
            panel-with-an-arrow pair reads as "open this" / "close this", where
            the old ◧/▯ pair only said which state you were in. */}
        <button
          class="tab-icon-btn"
          onClick={props.onToggleSidebar}
          aria-pressed={props.sidebarOpen}
          title={`${props.sidebarOpen ? "Hide" : "Show"} sidebar (${sidebarKey()})`}
        >
          <Show
            when={props.sidebarOpen}
            fallback={<IconSidebarOpen size={ICON_SIZE} stroke-width={ICON_STROKE} />}
          >
            <IconSidebarClose size={ICON_SIZE} stroke-width={ICON_STROKE} />
          </Show>
        </button>
        {/* Arrows out of the corners going in or out — the direction of the
            change, which is what the ⊞/⊡ boxes never managed to say. */}
        <button
          class="tab-icon-btn"
          onClick={() => void toggleFullscreen()}
          title={isFullscreen() ? "Exit fullscreen" : "Fullscreen"}
        >
          <Show
            when={isFullscreen()}
            fallback={<IconFullscreen size={ICON_SIZE} stroke-width={ICON_STROKE} />}
          >
            <IconFullscreenExit size={ICON_SIZE} stroke-width={ICON_STROKE} />
          </Show>
        </button>
        <button
          class="tab-icon-btn tab-settings"
          classList={{ active: props.settingsOpen }}
          onClick={props.onOpenSettings}
          aria-pressed={props.settingsOpen}
          title={`${props.settingsOpen ? "Hide" : "Open"} settings (${settingsKey()})`}
        >
          <IconSettings size={ICON_SIZE} stroke-width={ICON_STROKE} />
        </button>
      </div>
      <div class="tab-list" onWheel={onTabListWheel}>
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
                {(att) => (
                  <span
                    class="tab-attention"
                    data-kind={att.kind}
                    title={attentionTitle(att.kind, att.message)}
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
                title="Close tab"
                aria-label="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onClose(tab.id);
                }}
              >
                <IconX size={12} stroke-width={2} />
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
      {/* Immediately after the last tab, on whichever side the tabs grow —
          which is the only place it can be if it is going to mean "one more
          of these". Parked in the icon cluster it was just another button in a
          row of unrelated ones, and on the right-hand layout it sat past the
          window controls, at the opposite end of the bar from the tabs it
          adds to. It sits outside .tab-list on purpose: inside, it would
          scroll away with the tabs the moment they overflow. */}
      <button
        class="tab-icon-btn tab-new"
        onClick={props.onCreate}
        title="New tab"
        aria-label="New tab"
      >
        <IconPlus size={ICON_SIZE} stroke-width={ICON_STROKE} />
      </button>
      {/* Flexible draggable strip: fills the empty space so the window can be
          moved by dragging the tab bar (the tabs/buttons stay no-drag). */}
      <div class="tab-drag-region" />
      {/* Window controls, for the platforms where the tab bar *is* the title bar
          and there is no frame left to click — so only while it is actually up
          at the top. Moved to the bottom edge it stops being the title bar, and
          they stay behind in a strip of their own (see TitleStrip); dragging the
          close button down to the bottom-left corner of the screen was never the
          point of moving the tabs there. Hidden in fullscreen too: there is no
          window to minimise or restore up there, and the OS has taken the chrome
          away anyway. macOS never shows these; it keeps its own traffic lights,
          which the tab bar leaves room for. */}
      <Show when={ownControls() && !isFullscreen() && tabBarEdge() === "top"}>
        <WindowControls />
      </Show>
      {/* Optional clock, at the far end from the tabs. Mounted only when it's
          switched on, so when it's off there is no timer running at all. */}
      <Show when={clockEnabled()}>
        <Clock />
      </Show>
    </div>
  );
}
