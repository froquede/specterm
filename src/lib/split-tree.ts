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
