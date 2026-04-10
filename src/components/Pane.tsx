import { Show } from "solid-js";
import type { PaneType, PaneId } from "../types";
import TerminalPane from "./TerminalPane";
import MarkdownPane from "./MarkdownPane";

interface PaneProps {
  id: PaneId;
  pane: PaneType;
  isActive: boolean;
  onFocus: () => void;
  onTitle?: (title: string) => void;
  onClose?: () => void;
  onOpenMarkdown?: (path: string, mode: "split" | "tab") => void;
}

export default function Pane(props: PaneProps) {
  return (
    <div
      class={`pane ${props.isActive ? "pane-active" : ""}`}
      onMouseDown={props.onFocus}
      style={{ width: "100%", height: "100%", position: "relative" }}
    >
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
    </div>
  );
}
