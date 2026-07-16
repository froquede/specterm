import { nanoid } from "nanoid";
import type { SplitNode, PaneId, PaneType } from "../types";

export function createLeaf(pane: PaneType): SplitNode {
  return { type: "leaf", id: nanoid(8), pane };
}

export function splitPane(
  root: SplitNode,
  paneId: PaneId,
  direction: "h" | "v",
  newPane: PaneType
): SplitNode {
  if (root.type === "leaf") {
    if (root.id === paneId) {
      return {
        type: "split",
        id: nanoid(8),
        direction,
        first: root,
        second: createLeaf(newPane),
        ratio: 0.5,
      };
    }
    return root;
  }

  return {
    ...root,
    first: splitPane(root.first, paneId, direction, newPane),
    second: splitPane(root.second, paneId, direction, newPane),
  };
}

export function closePane(root: SplitNode, paneId: PaneId): SplitNode | null {
  if (root.type === "leaf") {
    return root.id === paneId ? null : root;
  }

  // Check if the target is a direct child
  if (root.first.type === "leaf" && root.first.id === paneId) {
    return root.second;
  }
  if (root.second.type === "leaf" && root.second.id === paneId) {
    return root.first;
  }

  // Recurse into children
  const newFirst = closePane(root.first, paneId);
  if (newFirst !== root.first) {
    return newFirst === null ? root.second : { ...root, first: newFirst };
  }

  const newSecond = closePane(root.second, paneId);
  if (newSecond !== root.second) {
    return newSecond === null ? root.first : { ...root, second: newSecond };
  }

  return root;
}

export function resizeSplit(
  root: SplitNode,
  splitId: string,
  ratio: number
): SplitNode {
  if (root.type === "leaf") return root;

  if (root.id === splitId) {
    return { ...root, ratio: Math.max(0.1, Math.min(0.9, ratio)) };
  }

  return {
    ...root,
    first: resizeSplit(root.first, splitId, ratio),
    second: resizeSplit(root.second, splitId, ratio),
  };
}

export function findPane(
  root: SplitNode,
  paneId: PaneId
): PaneType | undefined {
  if (root.type === "leaf") {
    return root.id === paneId ? root.pane : undefined;
  }
  return findPane(root.first, paneId) ?? findPane(root.second, paneId);
}

export function collectLeaves(
  root: SplitNode
): Array<{ id: PaneId; pane: PaneType }> {
  if (root.type === "leaf") {
    return [{ id: root.id, pane: root.pane }];
  }
  return [...collectLeaves(root.first), ...collectLeaves(root.second)];
}

export function firstLeafId(root: SplitNode): PaneId {
  if (root.type === "leaf") return root.id;
  return firstLeafId(root.first);
}

// A pane's position within the layout, in normalized [0,1] coordinates where
// (0,0) is the top-left of the split root and (1,1) the bottom-right. Used for
// spatial (directional) pane navigation — the visual geometry, not tree order.
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Compute every leaf's rectangle by walking the tree with each split's ratio.
// "h" splits stack first|second left→right (row); "v" splits stack them
// top→bottom (column) — matching SplitContainer's flex-direction.
export function paneRects(root: SplitNode): Map<PaneId, Rect> {
  const out = new Map<PaneId, Rect>();
  const walk = (node: SplitNode, r: Rect) => {
    if (node.type === "leaf") {
      out.set(node.id, r);
      return;
    }
    if (node.direction === "h") {
      const fw = r.w * node.ratio;
      walk(node.first, { x: r.x, y: r.y, w: fw, h: r.h });
      walk(node.second, { x: r.x + fw, y: r.y, w: r.w - fw, h: r.h });
    } else {
      const fh = r.h * node.ratio;
      walk(node.first, { x: r.x, y: r.y, w: r.w, h: fh });
      walk(node.second, { x: r.x, y: r.y + fh, w: r.w, h: r.h - fh });
    }
  };
  walk(root, { x: 0, y: 0, w: 1, h: 1 });
  return out;
}

export type FocusDirection = "left" | "right" | "up" | "down";

// Length of the overlap between two 1-D intervals [a0, a0+aLen] and
// [b0, b0+bLen]; negative when they don't overlap at all.
function overlap(a0: number, aLen: number, b0: number, bLen: number): number {
  return Math.min(a0 + aLen, b0 + bLen) - Math.max(a0, b0);
}

// The pane nearest to `activeId` in the given visual direction, or null when
// there's no neighbour that way (e.g. the active pane already hugs that edge).
// A candidate must sit on the requested side and share some extent on the
// perpendicular axis; ties on distance break toward the largest shared extent,
// so travelling right from a tall pane lands on the neighbour it overlaps most.
export function findPaneInDirection(
  root: SplitNode,
  activeId: PaneId,
  dir: FocusDirection
): PaneId | null {
  const rects = paneRects(root);
  const from = rects.get(activeId);
  if (!from) return null;

  const EPS = 1e-4;
  let best: { id: PaneId; gap: number; shared: number } | null = null;

  for (const [id, r] of rects) {
    if (id === activeId) continue;

    // Is `r` on the requested side of `from`? (near edge past the far edge)
    const onSide =
      dir === "left"
        ? r.x + r.w <= from.x + EPS
        : dir === "right"
          ? r.x >= from.x + from.w - EPS
          : dir === "up"
            ? r.y + r.h <= from.y + EPS
            : r.y >= from.y + from.h - EPS;
    if (!onSide) continue;

    // Require overlap on the other axis, so we pick a true side-neighbour and
    // not a pane sitting diagonally in the corner.
    const shared =
      dir === "left" || dir === "right"
        ? overlap(from.y, from.h, r.y, r.h)
        : overlap(from.x, from.w, r.x, r.w);
    if (shared <= EPS) continue;

    // Gap along the travel axis to the candidate's near edge (≈0 when adjacent).
    const gap =
      dir === "left"
        ? from.x - (r.x + r.w)
        : dir === "right"
          ? r.x - (from.x + from.w)
          : dir === "up"
            ? from.y - (r.y + r.h)
            : r.y - (from.y + from.h);

    if (
      !best ||
      gap < best.gap - EPS ||
      (Math.abs(gap - best.gap) <= EPS && shared > best.shared)
    ) {
      best = { id, gap, shared };
    }
  }
  return best?.id ?? null;
}

export type DropEdge = "left" | "right" | "top" | "bottom" | "center";

/** The leaf node carrying `id`, or null if absent. */
export function findLeafNode(
  root: SplitNode,
  id: PaneId
): (SplitNode & { type: "leaf" }) | null {
  if (root.type === "leaf") return root.id === id ? root : null;
  return findLeafNode(root.first, id) ?? findLeafNode(root.second, id);
}

function containsLeaf(root: SplitNode, id: PaneId): boolean {
  if (root.type === "leaf") return root.id === id;
  return containsLeaf(root.first, id) || containsLeaf(root.second, id);
}

/** Nearest split ancestor of a pane (deepest split on its path), or null. */
export function findParentSplit(
  root: SplitNode,
  paneId: PaneId
): (SplitNode & { type: "split" }) | null {
  if (root.type === "leaf") return null;
  if (containsLeaf(root.first, paneId)) {
    return findParentSplit(root.first, paneId) ?? root;
  }
  if (containsLeaf(root.second, paneId)) {
    return findParentSplit(root.second, paneId) ?? root;
  }
  return null;
}

/** Force a split's orientation. */
export function setSplitDirection(
  root: SplitNode,
  splitId: string,
  direction: "h" | "v"
): SplitNode {
  if (root.type === "leaf") return root;
  if (root.id === splitId) {
    return root.direction === direction ? root : { ...root, direction };
  }
  return {
    ...root,
    first: setSplitDirection(root.first, splitId, direction),
    second: setSplitDirection(root.second, splitId, direction),
  };
}

/** Flip a split between horizontal and vertical. */
export function toggleSplitDirection(
  root: SplitNode,
  splitId: string
): SplitNode {
  if (root.type === "leaf") return root;
  if (root.id === splitId) {
    return { ...root, direction: root.direction === "h" ? "v" : "h" };
  }
  return {
    ...root,
    first: toggleSplitDirection(root.first, splitId),
    second: toggleSplitDirection(root.second, splitId),
  };
}

/** Exchange the positions of two leaves, keeping each pane's identity. */
export function swapLeaves(
  root: SplitNode,
  idA: PaneId,
  idB: PaneId
): SplitNode {
  if (idA === idB) return root;
  const a = findLeafNode(root, idA);
  const b = findLeafNode(root, idB);
  if (!a || !b) return root;
  const rec = (n: SplitNode): SplitNode => {
    if (n.type === "leaf") {
      if (n.id === idA) return b;
      if (n.id === idB) return a;
      return n;
    }
    return { ...n, first: rec(n.first), second: rec(n.second) };
  };
  return rec(root);
}

/** Split the target leaf, placing `leaf` on the side named by `edge`. */
function insertBeside(
  root: SplitNode,
  targetId: PaneId,
  leaf: SplitNode,
  edge: Exclude<DropEdge, "center">
): SplitNode {
  const direction: "h" | "v" = edge === "left" || edge === "right" ? "h" : "v";
  const before = edge === "left" || edge === "top";
  const rec = (n: SplitNode): SplitNode => {
    if (n.type === "leaf") {
      if (n.id !== targetId) return n;
      return {
        type: "split",
        id: nanoid(8),
        direction,
        first: before ? leaf : n,
        second: before ? n : leaf,
        ratio: 0.5,
      };
    }
    return { ...n, first: rec(n.first), second: rec(n.second) };
  };
  return rec(root);
}

/**
 * Drag-and-drop relocation onto the *outer* layout edge: prune the source and
 * wrap the whole remaining tree in a new split, so the source spans the full
 * width/height of that side (a full column or row) rather than splitting just
 * one neighbour. Used when the drop lands on a pane edge that sits flush
 * against the workspace boundary.
 */
export function moveLeafToRootEdge(
  root: SplitNode,
  sourceId: PaneId,
  edge: Exclude<DropEdge, "center">
): SplitNode {
  const source = findLeafNode(root, sourceId);
  if (!source) return root;
  const pruned = closePane(root, sourceId);
  if (pruned === null) return root; // source was the only pane
  const direction: "h" | "v" = edge === "left" || edge === "right" ? "h" : "v";
  const before = edge === "left" || edge === "top";
  return {
    type: "split",
    id: nanoid(8),
    direction,
    first: before ? source : pruned,
    second: before ? pruned : source,
    ratio: 0.5,
  };
}

/**
 * Drag-and-drop relocation. `center` swaps source and target; an edge prunes
 * the source from the tree and re-splits the target with the source attached
 * to that side.
 */
export function moveLeaf(
  root: SplitNode,
  sourceId: PaneId,
  targetId: PaneId,
  edge: DropEdge
): SplitNode {
  if (sourceId === targetId) return root;
  if (edge === "center") return swapLeaves(root, sourceId, targetId);
  const source = findLeafNode(root, sourceId);
  if (!source) return root;
  const pruned = closePane(root, sourceId);
  if (pruned === null) return root; // source was the only pane
  return insertBeside(pruned, targetId, source, edge);
}
