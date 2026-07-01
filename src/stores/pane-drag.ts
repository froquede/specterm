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

// True when the pane element's `edge` side sits flush against the workspace
// root boundary (the [data-split-root] ancestor). A drop there spans the whole
// layout edge instead of splitting just this pane.
export function isFlushWithRoot(
  paneEl: HTMLElement,
  edge: Exclude<DropEdge, "center">
): boolean {
  const rootEl = paneEl.closest<HTMLElement>("[data-split-root]");
  if (!rootEl) return false;
  const r = paneEl.getBoundingClientRect();
  const root = rootEl.getBoundingClientRect();
  const TOL = 2; // px slack so sub-pixel layout still counts as flush
  switch (edge) {
    case "left":
      return Math.abs(r.left - root.left) <= TOL;
    case "right":
      return Math.abs(r.right - root.right) <= TOL;
    case "top":
      return Math.abs(r.top - root.top) <= TOL;
    case "bottom":
      return Math.abs(r.bottom - root.bottom) <= TOL;
  }
}
