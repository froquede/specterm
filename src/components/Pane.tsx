import { Show, createSignal } from "solid-js";
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
    setDraggingPaneId(props.id);

    function onMove(ev: PointerEvent) {
      // Overlays are pointer-events:none, so this resolves to the pane under
      // the cursor, whose ancestor carries data-pane-id.
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
      bar.removeEventListener("pointermove", onMove);
      bar.removeEventListener("pointerup", onUp);
      bar.removeEventListener("pointercancel", onUp);
      const dt = dropTarget();
      setDraggingPaneId(null);
      setDropTarget(null);
      if (dt) props.onDrop?.(props.id, dt.paneId, dt.edge);
    }

    bar.addEventListener("pointermove", onMove);
    bar.addEventListener("pointerup", onUp);
    bar.addEventListener("pointercancel", onUp);
  }

  const isDropHere = () =>
    draggingPaneId() !== null &&
    draggingPaneId() !== props.id &&
    dropTarget()?.paneId === props.id;

  return (
    <div
      class={`pane ${props.isActive ? "pane-active" : ""} ${props.pane.kind === "markdown" ? "pane-markdown" : ""}`}
      data-pane-id={props.id}
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
        <Show when={props.pane.kind === "terminal" ? props.id : null} keyed>
          {(paneId) => (
            <TerminalPane
              paneId={paneId}
              onTitle={(t) => {
                setTermTitle(t);
                props.onTitle?.(t);
              }}
              onExit={props.onClose}
              onOpenMarkdown={props.onOpenMarkdown}
            />
          )}
        </Show>
        <Show when={props.pane.kind === "markdown" ? (props.pane as PaneType & { kind: "markdown" }).filePath : null} keyed>
          {(filePath) => <MarkdownPane filePath={filePath} onOpenMarkdown={props.onOpenMarkdown} />}
        </Show>
      </div>
      <Show when={isDropHere()}>
        <div class={`drop-indicator drop-indicator-${dropTarget()!.edge}`} />
      </Show>
    </div>
  );
}
