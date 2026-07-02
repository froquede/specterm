import { createSignal } from "solid-js";
import type { DropEdge } from "../lib/split-tree";

// Shared state for pointer-driven pane drag-and-drop. The dragged pane sets
// `draggingPaneId`; every other pane reads `dropTarget` to highlight the zone
// the cursor is currently over.

export const [draggingPaneId, setDraggingPaneId] = createSignal<string | null>(
  null
);
export const [dropTarget, setDropTarget] = createSignal<{
  paneId: string;
  edge: DropEdge;
  // True when `edge` is flush against the workspace boundary, so the drop
  // should span the whole layout side (a full column/row) instead of
  // splitting only the pane under the cursor.
  root?: boolean;
} | null>(null);

// Edge thresholds: the central 40% box is "center" (swap); otherwise the
// nearest border decides the split side.
export function computeDropEdge(
  x: number,
  y: number,
  rect: DOMRect
): DropEdge {
  const fx = (x - rect.left) / rect.width;
  const fy = (y - rect.top) / rect.height;
  if (fx > 0.3 && fx < 0.7 && fy > 0.3 && fy < 0.7) return "center";
  const dist: Record<Exclude<DropEdge, "center">, number> = {
    left: fx,
    right: 1 - fx,
    top: fy,
    bottom: 1 - fy,
  };
  return (Object.keys(dist) as Array<Exclude<DropEdge, "center">>).reduce(
    (best, edge) => (dist[edge] < dist[best] ? edge : best),
    "left" as Exclude<DropEdge, "center">
  );
}

// True when a drop on the pane's `edge` should span the whole workspace side (a
// full column/row) instead of splitting just this pane. That requires two
// things: the pane is flush against the root on that edge, AND it already spans
// the full extent *perpendicular* to the resulting split. Without the second
// check, a side-by-side (all-horizontal) layout — where every pane is flush top
// AND bottom — would treat every top/bottom drop as a root-span, making it
// impossible to stack one pane above a single neighbour (the whole tree gets
// wrapped and unrelated panes are displaced).
export function isFlushWithRoot(
  paneEl: HTMLElement,
  edge: Exclude<DropEdge, "center">
): boolean {
  const rootEl = paneEl.closest<HTMLElement>("[data-split-root]");
  if (!rootEl) return false;
  const r = paneEl.getBoundingClientRect();
  const root = rootEl.getBoundingClientRect();
  const TOL = 2; // px slack so sub-pixel layout still counts as flush
  const flushLeft = Math.abs(r.left - root.left) <= TOL;
  const flushRight = Math.abs(r.right - root.right) <= TOL;
  const flushTop = Math.abs(r.top - root.top) <= TOL;
  const flushBottom = Math.abs(r.bottom - root.bottom) <= TOL;
  const spansWidth = flushLeft && flushRight;
  const spansHeight = flushTop && flushBottom;
  switch (edge) {
    // A left/right root drop makes a full-height column, so only span the root
    // when the pane already fills the full height. Transposed for top/bottom.
    case "left":
      return flushLeft && spansHeight;
    case "right":
      return flushRight && spansHeight;
    case "top":
      return flushTop && spansWidth;
    case "bottom":
      return flushBottom && spansWidth;
  }
}
