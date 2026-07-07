import { Show } from "solid-js";
import type { SplitNode, PaneId } from "../types";
import type { DropEdge } from "../lib/split-tree";
import Pane from "./Pane";
import SplitHandle, { type ResizeEntry } from "./SplitHandle";

interface SplitContainerProps {
  node: SplitNode;
  activePaneId: PaneId;
  tabId: string;
  onFocusPane: (id: PaneId) => void;
  onResizeSplit: (entries: ResizeEntry[]) => void;
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
        // Key the leaf by its id (not the node object) so Solid recreates the
        // Pane when this slot's leaf changes, instead of reusing the same Pane
        // with a stale captured id. The reuse was what bound a pane to the wrong
        // terminal after a drag — surfacing as focus landing on another pane and
        // a drop-highlight rendered twice (the same id matching two slots).
        <Show
          when={
            props.node.type === "leaf"
              ? (props.node as SplitNode & { type: "leaf" }).id
              : null
          }
          keyed
        >
          {(leafId) => {
            // While this child is alive the slot holds this exact leaf; the
            // keyed Show above disposes/recreates it otherwise. The inner Show
            // guards the teardown frame so `l().pane` never derefs a node that
            // has already stopped being this leaf.
            const leaf = () => {
              const n = props.node;
              return n.type === "leaf" && n.id === leafId ? n : null;
            };
            return (
              <Show when={leaf()}>
                {(l) => (
                  <Pane
                    id={leafId}
                    pane={l().pane}
                    isActive={leafId === props.activePaneId}
                    onFocus={() => props.onFocusPane(leafId)}
                    onTitle={props.onTitle}
                    onClose={() => props.onClosePane?.(leafId)}
                    onOpenMarkdown={props.onOpenMarkdown}
                    onDrop={props.onDropPane}
                  />
                )}
              </Show>
            );
          }}
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
              splitId={split().id}
              onResize={props.onResizeSplit}
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
