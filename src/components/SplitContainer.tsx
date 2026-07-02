import { Show } from "solid-js";
import type { SplitNode, PaneId } from "../types";
import type { DropEdge } from "../lib/split-tree";
import Pane from "./Pane";
import SplitHandle from "./SplitHandle";

interface SplitContainerProps {
  node: SplitNode;
  activePaneId: PaneId;
  tabId: string;
  onFocusPane: (id: PaneId) => void;
  onResizeSplit: (splitId: string, ratio: number) => void;
  onToggleDirection?: (splitId: string) => void;
  onDropPane?: (
    sourceId: PaneId,
    targetId: PaneId,
    edge: DropEdge,
    atRoot?: boolean
  ) => void;
  onTitle?: (title: string) => void;
  onClosePane?: (id: PaneId) => void;
  onOpenMarkdown?: (path: string, mode: "split" | "tab") => void;
}

export default function SplitContainer(props: SplitContainerProps) {
  return (
    <Show
      when={props.node.type === "split" ? props.node : null}
      fallback={
        <Show when={props.node.type === "leaf" ? props.node : null}>
          {(leaf) => (
            <Pane
              id={(leaf() as SplitNode & { type: "leaf" }).id}
              pane={(leaf() as SplitNode & { type: "leaf" }).pane}
              isActive={(leaf() as SplitNode & { type: "leaf" }).id === props.activePaneId}
              onFocus={() => props.onFocusPane((leaf() as SplitNode & { type: "leaf" }).id)}
              onTitle={props.onTitle}
              onClose={() => props.onClosePane?.((leaf() as SplitNode & { type: "leaf" }).id)}
              onOpenMarkdown={props.onOpenMarkdown}
              onDrop={props.onDropPane}
            />
          )}
        </Show>
      }
    >
      {(splitNode) => {
        const split = () => splitNode() as SplitNode & { type: "split" };
        return (
          <div
            class="split-container"
            style={{
              display: "flex",
              "flex-direction": split().direction === "h" ? "row" : "column",
              width: "100%",
              height: "100%",
            }}
          >
            <div
              style={{
                flex: `0 0 ${split().ratio * 100}%`,
                overflow: "hidden",
                position: "relative",
              }}
            >
              <SplitContainer
                node={split().first}
                activePaneId={props.activePaneId}
                tabId={props.tabId}
                onFocusPane={props.onFocusPane}
                onResizeSplit={props.onResizeSplit}
                onToggleDirection={props.onToggleDirection}
                onDropPane={props.onDropPane}
                onTitle={props.onTitle}
                onClosePane={props.onClosePane}
                onOpenMarkdown={props.onOpenMarkdown}
              />
            </div>
            <SplitHandle
              direction={split().direction}
              onDrag={(pos, total) => {
                props.onResizeSplit(split().id, pos / total);
              }}
              onToggleDirection={() => props.onToggleDirection?.(split().id)}
            />
            <div
              style={{
                flex: "1",
                overflow: "hidden",
                position: "relative",
              }}
            >
              <SplitContainer
                node={split().second}
                activePaneId={props.activePaneId}
                tabId={props.tabId}
                onFocusPane={props.onFocusPane}
                onResizeSplit={props.onResizeSplit}
                onToggleDirection={props.onToggleDirection}
                onDropPane={props.onDropPane}
                onTitle={props.onTitle}
                onClosePane={props.onClosePane}
                onOpenMarkdown={props.onOpenMarkdown}
              />
            </div>
          </div>
        );
      }}
    </Show>
  );
}
