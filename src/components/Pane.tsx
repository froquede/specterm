import { Show, createSignal, onCleanup } from "solid-js";
import type { PaneType, PaneId } from "../types";
import type { DropEdge } from "../lib/split-tree";
import TerminalPane from "./TerminalPane";
import MarkdownPane from "./MarkdownPane";
import TextPane from "./TextPane";
import TerminalSearch from "./TerminalSearch";
import { searchPaneId } from "../stores/terminal-search";
import { paneAttention } from "../stores/attention";
import {
  draggingPaneId,
  setDraggingPaneId,
  dropTarget,
  setDropTarget,
  dropTabId,
  setDropTabId,
  computeDropEdge,
  isRootEdgeDrop,
} from "../stores/pane-drag";
import { tearingOff, setTearingOff, isOutsideWindow } from "../stores/tear-off";

interface PaneProps {
  id: PaneId;
  pane: PaneType;
  isActive: boolean;
  onFocus: () => void;
  onTitle?: (title: string) => void;
  onClose?: () => void;
  onOpenMarkdown?: (path: string, mode: "split" | "tab") => void;
  onDrop?: (
    sourceId: PaneId,
    targetId: PaneId,
    edge: DropEdge,
    atRoot?: boolean
  ) => void;
  onDropToTab?: (sourceId: PaneId, tabId: string) => void;
  // Released outside the window: hand this pane off to another window (or a new
  // one), where it lands as a tab of its own.
  onTearOff?: (sourceId: PaneId) => void;
}

export default function Pane(props: PaneProps) {
  // A pane's id is stable for its whole lifetime, so capture it once. Reading
  // `props.id` re-invokes a reactive getter that dereferences the backing leaf
  // node — and during teardown (a split replaces this leaf with a split
  // subtree, or the pane closes) that node is already null. Reading it then
  // threw "Cannot read properties of null (reading 'id')" from inside onCleanup,
  // which propagated through Solid's disposal and poisoned the whole reactive
  // render — freezing new tabs, splits, the sidebar toggle and resize refits.
  const paneId = props.id;
  const [termTitle, setTermTitle] = createSignal("Terminal");

  // Label shown in the title-bar: the shell-reported title for terminals, the
  // file name for markdown and text panes.
  const label = () => {
    if (props.pane.kind === "markdown" || props.pane.kind === "text") {
      const filePath = (props.pane as PaneType & { kind: "markdown" | "text" }).filePath;
      return filePath.split(/[\\/]/).pop() || (props.pane.kind === "markdown" ? "Markdown" : "Text");
    }
    return termTitle();
  };

  // Pointer-driven drag from the title-bar. We don't preventDefault so the
  // compatibility mousedown still bubbles to the pane root and focuses it;
  // the bar is user-select:none in CSS so no text selection starts.
  function onBarPointerDown(e: PointerEvent) {
    const bar = e.currentTarget as HTMLElement;
    bar.setPointerCapture(e.pointerId);
    setDraggingPaneId(paneId);

    function onMove(ev: PointerEvent) {
      // Dragged clear of the window: nothing in here can be a drop target any
      // more, and releasing means "move this pane out".
      setTearingOff(isOutsideWindow(ev));
      if (tearingOff()) {
        setDropTarget(null);
        setDropTabId(null);
        return;
      }
      // Overlays are pointer-events:none, so this resolves to the pane under
      // the cursor, whose ancestor carries data-pane-id.
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      // Over a tab-chip? The drop detaches this pane into that tab. This wins
      // over pane-edge targeting, so clear the pane drop indicator too.
      const tabEl = el?.closest<HTMLElement>("[data-tab-id]");
      const overTabId = tabEl?.getAttribute("data-tab-id");
      if (overTabId) {
        setDropTarget(null);
        setDropTabId(overTabId);
        return;
      }
      setDropTabId(null);
      const paneEl = el?.closest<HTMLElement>("[data-pane-id]");
      const targetId = paneEl?.getAttribute("data-pane-id");
      if (!paneEl || !targetId || targetId === paneId) {
        setDropTarget(null);
        return;
      }
      const edge = computeDropEdge(
        ev.clientX,
        ev.clientY,
        paneEl.getBoundingClientRect()
      );
      // A drop in the thin outer strip of the workspace becomes a full
      // column/row at the layout root rather than a split of just this pane.
      const atRoot =
        edge !== "center" && isRootEdgeDrop(paneEl, edge, ev.clientX, ev.clientY);
      setDropTarget({ paneId: targetId, edge, root: atRoot });
    }

    function onUp() {
      bar.removeEventListener("pointermove", onMove);
      bar.removeEventListener("pointerup", onUp);
      bar.removeEventListener("pointercancel", onUp);
      const dt = dropTarget();
      const tabId = dropTabId();
      const tearOff = tearingOff();
      setDraggingPaneId(null);
      setDropTarget(null);
      setDropTabId(null);
      setTearingOff(false);
      if (tearOff) props.onTearOff?.(paneId);
      else if (tabId) props.onDropToTab?.(paneId, tabId);
      else if (dt) props.onDrop?.(paneId, dt.paneId, dt.edge, dt.root);
    }

    bar.addEventListener("pointermove", onMove);
    bar.addEventListener("pointerup", onUp);
    bar.addEventListener("pointercancel", onUp);
  }

  // If this pane unmounts mid-drag (e.g. its PTY exits and closePane removes
  // it), the captured title-bar element is gone so pointerup/onUp never fire.
  // Clear the shared drag state here so the remaining panes don't stay stuck in
  // the dimmed drag/drop-overlay state.
  onCleanup(() => {
    if (draggingPaneId() === paneId) {
      setDraggingPaneId(null);
      setDropTarget(null);
      setDropTabId(null);
      setTearingOff(false);
    }
  });

  const isDropHere = () =>
    draggingPaneId() !== null &&
    draggingPaneId() !== paneId &&
    dropTarget()?.paneId === paneId &&
    !dropTarget()?.root;

  return (
    <div
      // Folded into `class` rather than a separate `classList`: the two write the
      // same attribute, and this template is reactive, so a re-render for any
      // other reason would wipe a classList-applied token until its own effect
      // caught up.
      class={`pane ${props.isActive ? "pane-active" : ""} ${props.pane.kind === "markdown" ? "pane-markdown" : ""} ${props.pane.kind === "text" ? "pane-text" : ""} ${draggingPaneId() === paneId && tearingOff() ? "tearing-off" : ""}`}
      data-pane-id={paneId}
      onMouseDown={props.onFocus}
      style={{ width: "100%", height: "100%", position: "relative" }}
    >
      <div
        class="pane-titlebar"
        title="Drag to move / swap pane"
        onPointerDown={onBarPointerDown}
      >
        <span class="pane-grip">⠿</span>
        {/* Which pane in a split is the one waiting. The tab chip only says
            that something in the tab is; this says where. */}
        <Show when={paneAttention(paneId)} keyed>
          {(kind) => (
            <span
              class="pane-attention"
              data-kind={kind}
              title={
                kind === "permission"
                  ? "Waiting for your answer"
                  : kind === "bell"
                    ? "Rang the terminal bell"
                    : "Finished — waiting for you"
              }
            />
          )}
        </Show>
        <span class="pane-title">{label()}</span>
        <button
          class="pane-close-btn"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            props.onClose?.();
          }}
          title="Close pane"
        >
          ×
        </button>
      </div>
      <div class="pane-content">
        <Show when={props.pane.kind === "terminal"}>
          <TerminalPane
            paneId={paneId}
            cwd={
              props.pane.kind === "terminal"
                ? (props.pane as PaneType & { kind: "terminal" }).cwd
                : undefined
            }
            onTitle={(t) => {
              setTermTitle(t);
              props.onTitle?.(t);
            }}
            onExit={props.onClose}
            onOpenMarkdown={props.onOpenMarkdown}
          />
        </Show>
        <Show when={props.pane.kind === "markdown" ? (props.pane as PaneType & { kind: "markdown" }).filePath : null} keyed>
          {(filePath) => <MarkdownPane filePath={filePath} isActive={props.isActive} onOpenMarkdown={props.onOpenMarkdown} />}
        </Show>
        <Show when={props.pane.kind === "text" ? (props.pane as PaneType & { kind: "text" }).filePath : null} keyed>
          {(filePath) => <TextPane filePath={filePath} isActive={props.isActive} />}
        </Show>
        <Show when={props.pane.kind === "terminal" && searchPaneId() === paneId}>
          <TerminalSearch paneId={paneId} />
        </Show>
      </div>
      <Show when={isDropHere()}>
        <div class={`drop-indicator drop-indicator-${dropTarget()!.edge}`} />
      </Show>
    </div>
  );
}
