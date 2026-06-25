import { Show } from "solid-js";
import type { PaneType, PaneId } from "../types";
import type { DropEdge } from "../lib/split-tree";
import TerminalPane from "./TerminalPane";
import MarkdownPane from "./MarkdownPane";
import {
  draggingPaneId,
  setDraggingPaneId,
  dropTarget,
  setDropTarget,
  computeDropEdge,
} from "../stores/pane-drag";

interface PaneProps {
  id: PaneId;
  pane: PaneType;
  isActive: boolean;
  onFocus: () => void;
  onTitle?: (title: string) => void;
  onClose?: () => void;
  onOpenMarkdown?: (path: string, mode: "split" | "tab") => void;
  onDrop?: (sourceId: PaneId, targetId: PaneId, edge: DropEdge) => void;
}

export default function Pane(props: PaneProps) {
  function onGripPointerDown(e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const grip = e.currentTarget as HTMLElement;
    grip.setPointerCapture(e.pointerId);
    setDraggingPaneId(props.id);

    function onMove(ev: PointerEvent) {
      // Overlays are pointer-events:none, so this resolves to the pane under
      // the cursor (its canvas), whose ancestor carries data-pane-id.
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const paneEl = el?.closest<HTMLElement>("[data-pane-id]");
      const targetId = paneEl?.getAttribute("data-pane-id");
      if (!paneEl || !targetId || targetId === props.id) {
        setDropTarget(null);
        return;
      }
      const edge = computeDropEdge(
        ev.clientX,
        ev.clientY,
        paneEl.getBoundingClientRect()
      );
      setDropTarget({ paneId: targetId, edge });
    }

    function onUp() {
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onUp);
      const dt = dropTarget();
      setDraggingPaneId(null);
      setDropTarget(null);
      if (dt) props.onDrop?.(props.id, dt.paneId, dt.edge);
    }

    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onUp);
  }

  const isDropHere = () =>
    draggingPaneId() !== null &&
    draggingPaneId() !== props.id &&
    dropTarget()?.paneId === props.id;

  return (
    <div
      class={`pane ${props.isActive ? "pane-active" : ""}`}
      data-pane-id={props.id}
      onMouseDown={props.onFocus}
      style={{ width: "100%", height: "100%", position: "relative" }}
    >
      <button
        class="pane-grip"
        title="Drag to move / swap pane"
        onPointerDown={onGripPointerDown}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        ⠿
      </button>
      <button
        class="pane-close-btn"
        onClick={(e) => {
          e.stopPropagation();
          props.onClose?.();
        }}
        title="Close pane"
      >
        ×
      </button>
      <Show when={props.pane.kind === "terminal" ? props.id : null} keyed>
        {(paneId) => (
          <TerminalPane
            paneId={paneId}
            onTitle={props.onTitle}
            onExit={props.onClose}
            onOpenMarkdown={props.onOpenMarkdown}
          />
        )}
      </Show>
      <Show when={props.pane.kind === "markdown" ? (props.pane as PaneType & { kind: "markdown" }).filePath : null} keyed>
        {(filePath) => <MarkdownPane filePath={filePath} onOpenMarkdown={props.onOpenMarkdown} />}
      </Show>
      <Show when={isDropHere()}>
        <div class={`drop-indicator drop-indicator-${dropTarget()!.edge}`} />
      </Show>
    </div>
  );
}
