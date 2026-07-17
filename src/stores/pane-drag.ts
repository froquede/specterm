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

// The id of the tab-chip the cursor is hovering during a pane drag. When set,
// releasing detaches the dragged pane into that tab (a cross-tab move) instead
// of splitting a pane in the current tab. Cleared when the cursor leaves the
// tab bar or the drag ends.
export const [dropTabId, setDropTabId] = createSignal<string | null>(null);

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

// True when a drop should span the whole workspace side (a full column/row)
// instead of splitting just the pane under the cursor. The trigger is a thin
// band along the workspace's *outer* boundary: dropping in that strip, on an
// edge that is flush with the root, makes a full-height column (left/right) or
// full-width row (top/bottom). Dropping further inward returns false and falls
// through to a local pane split. This keeps both gestures reachable from any
// layout — e.g. in a side-by-side row you can still stack one pane above a
// single neighbour (inner drop) yet also drop a full-width row across the top
// (outer strip) — which a pure flush-with-edge test could not distinguish.
export function isRootEdgeDrop(
  paneEl: HTMLElement,
  edge: Exclude<DropEdge, "center">,
  x: number,
  y: number
): boolean {
  const rootEl = paneEl.closest<HTMLElement>("[data-split-root]");
  if (!rootEl) return false;
  const r = paneEl.getBoundingClientRect();
  const root = rootEl.getBoundingClientRect();
  const TOL = 2; // px slack so sub-pixel layout still counts as flush
  // Outer-strip thickness, scaled to the workspace so it stays a comfortable
  // target at any window size, clamped to a sane px floor/ceiling.
  const band = (extent: number) => Math.min(Math.max(extent * 0.12, 32), 140);
  switch (edge) {
    case "left":
      return Math.abs(r.left - root.left) <= TOL && x - root.left <= band(root.width);
    case "right":
      return Math.abs(r.right - root.right) <= TOL && root.right - x <= band(root.width);
    case "top":
      return Math.abs(r.top - root.top) <= TOL && y - root.top <= band(root.height);
    case "bottom":
      return Math.abs(r.bottom - root.bottom) <= TOL && root.bottom - y <= band(root.height);
  }
}
