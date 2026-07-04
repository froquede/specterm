import { Show, createSignal, onCleanup } from "solid-js";
import type { PaneType, PaneId } from "../types";
import type { DropEdge } from "../lib/split-tree";
import TerminalPane from "./TerminalPane";
import MarkdownPane from "./MarkdownPane";
import TerminalSearch from "./TerminalSearch";
import { searchPaneId } from "../stores/terminal-search";
import {
  draggingPaneId,
  setDraggingPaneId,
  dropTarget,
  setDropTarget,
  computeDropEdge,
  isRootEdgeDrop,
} from "../stores/pane-drag";

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
  // file name for markdown panes.
  const label = () =>
    props.pane.kind === "markdown"
      ? (props.pane as PaneType & { kind: "markdown" }).filePath
          .split(/[\\/]/)
          .pop() || "Markdown"
      : termTitle();

  // Pointer-driven drag from the title-bar. We don't preventDefault so the
  // compatibility mousedown still bubbles to the pane root and focuses it;
  // the bar is user-select:none in CSS so no text selection starts.
  function onBarPointerDown(e: PointerEvent) {
    const bar = e.currentTarget as HTMLElement;
    bar.setPointerCapture(e.pointerId);
    setDraggingPaneId(paneId);

    function onMove(ev: PointerEvent) {
      // Overlays are pointer-events:none, so this resolves to the pane under
      // the cursor, whose ancestor carries data-pane-id.
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
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
      setDraggingPaneId(null);
      setDropTarget(null);
      if (dt) props.onDrop?.(paneId, dt.paneId, dt.edge, dt.root);
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
    }
  });

  const isDropHere = () =>
    draggingPaneId() !== null &&
    draggingPaneId() !== paneId &&
    dropTarget()?.paneId === paneId &&
    !dropTarget()?.root;

  return (
    <div
      class={`pane ${props.isActive ? "pane-active" : ""} ${props.pane.kind === "markdown" ? "pane-markdown" : ""}`}
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
