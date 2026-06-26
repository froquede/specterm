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
