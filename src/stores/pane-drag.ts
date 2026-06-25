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
