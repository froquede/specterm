// Moving a tab (or a single pane) from one window to another.
//
// A terminal is a renderer object and can't cross a window boundary, but the two
// things that actually matter can: the PTY, which lives in the host process and
// only needs a new owner, and the screen, which serializes to escape sequences.
// So a move ships a shape-preserving description of the split tree with each
// terminal reduced to `{ptyId, scrollback}`, and the destination window rebuilds
// real panes around it.
//
// Pane ids deliberately do NOT travel: the destination mints its own, so a tab
// dropped into a window that happens to hold the same id can't collide.
import { nanoid } from "nanoid";
import type { SplitNode, Tab } from "../types";
import type { TransferNode, TransferTab } from "../backends/types";
import { createLeaf, firstLeafId } from "./split-tree";
import {
  getTerminalInstance,
  registerAdoption,
  serializeTerminal,
} from "./terminal-registry";

// Returns null when a node has nothing transferable left — a terminal pane whose
// PTY never spawned or already died. A split with one surviving side collapses
// into that side, mirroring how closePane prunes the tree.
async function serializeNode(node: SplitNode): Promise<TransferNode | null> {
  if (node.type === "leaf") {
    const pane = node.pane;
    if (pane.kind === "markdown") {
      return { type: "leaf", pane: { kind: "markdown", filePath: pane.filePath } };
    }
    if (pane.kind === "text") {
      return { type: "leaf", pane: { kind: "text", filePath: pane.filePath } };
    }
    const instance = getTerminalInstance(node.id);
    if (!instance || instance.disposed || instance.ptyId === null) return null;
    return {
      type: "leaf",
      pane: {
        kind: "terminal",
        ptyId: instance.ptyId,
        scrollback: await serializeTerminal(node.id),
        title: instance.title,
      },
    };
  }

  // Sequential, not Promise.all: each flush waits on its own terminal's write
  // queue, and there are at most a handful of panes in a tab.
  const first = await serializeNode(node.first);
  const second = await serializeNode(node.second);
  if (first && second) {
    return {
      type: "split",
      direction: node.direction,
      ratio: node.ratio,
      first,
      second,
    };
  }
  return first ?? second;
}

/** Snapshot a whole tab for transfer. Null when none of its panes can travel. */
export async function serializeTab(tab: Tab): Promise<TransferTab | null> {
  const root = await serializeNode(tab.root);
  if (!root) return null;
  return { title: tab.title, manualTitle: tab.manualTitle, root };
}

/**
 * Snapshot a single pane as a one-leaf tab. A torn-off pane becomes a tab in
 * whatever window it lands in — there is no smaller unit a window can hold.
 */
export async function serializeLeaf(
  leaf: SplitNode,
  title: string
): Promise<TransferTab | null> {
  const root = await serializeNode(leaf);
  if (!root) return null;
  return { title, manualTitle: false, root };
}

// Rebuild real panes, registering each terminal's adoption so that the moment
// its pane mounts, attachTerminal claims the running PTY instead of spawning a
// shell (see terminal-registry).
function rebuildNode(node: TransferNode): SplitNode {
  if (node.type === "leaf") {
    const pane = node.pane;
    if (pane.kind === "markdown") {
      return createLeaf({ kind: "markdown", filePath: pane.filePath });
    }
    if (pane.kind === "text") {
      return createLeaf({ kind: "text", filePath: pane.filePath });
    }
    const leaf = createLeaf({
      kind: "terminal",
      ptyId: pane.ptyId,
      cwd: "",
    });
    registerAdoption(leaf.id, {
      ptyId: pane.ptyId,
      scrollback: pane.scrollback,
      title: pane.title,
    });
    return leaf;
  }

  return {
    type: "split",
    id: nanoid(8),
    direction: node.direction,
    ratio: node.ratio,
    first: rebuildNode(node.first),
    second: rebuildNode(node.second),
  };
}

/** Turn a received transfer back into a live tab for this window. */
export function rebuildTab(transfer: TransferTab): Tab {
  const root = rebuildNode(transfer.root);
  return {
    id: nanoid(8),
    title: transfer.title,
    manualTitle: transfer.manualTitle,
    root,
    activePaneId: firstLeafId(root),
    // The focus history doesn't travel: its entries are the source window's pane
    // ids, and this tab's panes were just minted with new ones. Empty is the
    // honest state — closing a pane here falls back to the first leaf until the
    // user has actually moved focus around in this window.
    paneHistory: [],
  };
}
