import { Show, createMemo } from "solid-js";
import type { SplitNode, PaneId, PaneType } from "../types";
import { gripPosition, type DropEdge } from "../lib/split-tree";
import Pane from "./Pane";
import SplitHandle, { type ResizeEntry } from "./SplitHandle";
import { zoomedPane, subtreeCollapsed, subtreeHas } from "../stores/pane-view";

// A collapsed pane's strip: its 26px title-bar, the bar's 1px rule and the
// card's 1px border on each side.
const COLLAPSED_SIZE = "29px";

interface SplitContainerProps {
  node: SplitNode;
  activePaneId: PaneId;
  tabId: string;
  onFocusPane: (id: PaneId) => void;
  onResizeSplit: (entries: ResizeEntry[]) => void;
  onEqualizeSplits?: (splitIds: string[]) => void;
  onToggleDirection?: (splitId: string) => void;
  onDropPane?: (
    sourceId: PaneId,
    targetId: PaneId,
    edge: DropEdge,
    atRoot?: boolean
  ) => void;
  onDropPaneToTab?: (sourceId: PaneId, tabId: string) => void;
  onDropPaneToNewTab?: (sourceId: PaneId) => void;
  onTearOffPane?: (sourceId: PaneId) => void;
  onTitle?: (paneId: PaneId, title: string) => void;
  onClosePane?: (id: PaneId) => void;
  // The pane's process exited, as opposed to the user closing it.
  onPaneExit?: (id: PaneId) => void;
  onOpenFile?: (path: string, mode: "split" | "tab") => void;
  onPaneContent?: (paneId: PaneId, pane: PaneType) => void;
  // The direction of the split this node sits in; absent at the layout root.
  // A collapsed pane folds along it, and a lone pane has nothing to fold into.
  parentDirection?: "h" | "v";
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
                    tabId={props.tabId}
                    axis={props.parentDirection}
                    onFocus={() => props.onFocusPane(leafId)}
                    onTitle={props.onTitle}
                    onClose={() => props.onClosePane?.(leafId)}
                    onExit={() => props.onPaneExit?.(leafId)}
                    onOpenFile={props.onOpenFile}
                    onPaneContent={props.onPaneContent}
                    onDrop={props.onDropPane}
                    onDropToTab={props.onDropPaneToTab}
                    onDropToNewTab={props.onDropPaneToNewTab}
                    onTearOff={props.onTearOffPane}
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
        // Which side holds this tab's zoomed pane, if either does. The other
        // side drops out of layout entirely (see stores/pane-view.ts).
        // Memos: the styles below read these several times, and a divider
        // drag replaces the tree on every move.
        const zoomSide = createMemo(() => {
          const z = zoomedPane(props.tabId);
          if (!z) return null;
          if (subtreeHas(split().first, z)) return "first";
          if (subtreeHas(split().second, z)) return "second";
          return null;
        });
        // A side folds only when the other one still has something to show.
        const sidesFolded = createMemo(() => ({
          first: subtreeCollapsed(split().first),
          second: subtreeCollapsed(split().second),
        }));
        const folded = createMemo(() => {
          const { first, second } = sidesFolded();
          if (first && !second) return "first";
          if (second && !first) return "second";
          return null;
        });
        const firstFlex = () => {
          if (zoomSide() === "first") return "1 1 100%";
          if (folded() === "first") return `0 0 ${COLLAPSED_SIZE}`;
          if (folded() === "second") return "1 1 0";
          return `0 0 ${split().ratio * 100}%`;
        };
        // When both sides are folded this split is one strip in its parent, and
        // its panes fold along the parent's direction, not their own.
        const childAxis = () =>
          sidesFolded().first && sidesFolded().second
            ? props.parentDirection ?? split().direction
            : split().direction;
        const secondFlex = () =>
          folded() === "second" ? `0 0 ${COLLAPSED_SIZE}` : "1";
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
                flex: firstFlex(),
                display: zoomSide() === "second" ? "none" : undefined,
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
                onEqualizeSplits={props.onEqualizeSplits}
                onToggleDirection={props.onToggleDirection}
                onDropPane={props.onDropPane}
                onDropPaneToTab={props.onDropPaneToTab}
                onDropPaneToNewTab={props.onDropPaneToNewTab}
                onTearOffPane={props.onTearOffPane}
                onTitle={props.onTitle}
                onClosePane={props.onClosePane}
                onPaneExit={props.onPaneExit}
                onOpenFile={props.onOpenFile}
                onPaneContent={props.onPaneContent}
                parentDirection={childAxis()}
              />
            </div>
            {/* Zoomed: no divider at all. Folded: the gap stays, but there is
                nothing to drag — the folded side has a fixed size. */}
            <Show when={!zoomSide()}>
              <Show
                when={!folded()}
                fallback={<div class={`split-handle split-handle-${split().direction} split-handle-inert`} />}
              >
                <SplitHandle
                  direction={split().direction}
                  splitId={split().id}
                  onResize={props.onResizeSplit}
                  onEqualize={props.onEqualizeSplits}
                  onToggleDirection={() => props.onToggleDirection?.(split().id)}
                  gripAt={gripPosition(split().direction, [split().first, split().second])}
                />
              </Show>
            </Show>
            <div
              style={{
                flex: secondFlex(),
                display: zoomSide() === "first" ? "none" : undefined,
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
                onEqualizeSplits={props.onEqualizeSplits}
                onToggleDirection={props.onToggleDirection}
                onDropPane={props.onDropPane}
                onDropPaneToTab={props.onDropPaneToTab}
                onDropPaneToNewTab={props.onDropPaneToNewTab}
                onTearOffPane={props.onTearOffPane}
                onTitle={props.onTitle}
                onClosePane={props.onClosePane}
                onPaneExit={props.onPaneExit}
                onOpenFile={props.onOpenFile}
                onPaneContent={props.onPaneContent}
                parentDirection={childAxis()}
              />
            </div>
          </div>
        );
      }}
    </Show>
  );
}
