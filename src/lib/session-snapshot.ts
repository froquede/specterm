// Turning live tabs into plain data and back.
//
// A `Tab` is nearly serializable already — the split tree is plain data — but
// two things in it are bound to a running process and must not survive into a
// snapshot:
//
//   - `ptyId` names a pty in the main process. After a restart (or after the
//     pane was closed and its pty killed) that number belongs to nothing, or
//     worse, to somebody else's terminal. Snapshots drop it; a rehydrated pane
//     spawns its own pty when it mounts, which is how a fresh pane works too
//     (see createTerminalInstance — the spawn is deferred until attach).
//   - pane and tab ids are live keys into the terminal registry. Reusing them
//     would point a restored pane at a registry slot that was just destroyed,
//     so hydration mints new ones and rebuilds `activePaneId` from a positional
//     index instead.
//
// What a snapshot *adds* over the live shape is the pane's true working
// directory: the leaf's `cwd` is where the terminal was told to spawn, which
// stops being true the moment the user cd's. The registry tracks the live
// value, so we read it here, at capture time, while the terminal still exists.

import { nanoid } from "nanoid";
import type {
  PaneId,
  PaneType,
  SessionMeta,
  SnapshotNode,
  SnapshotPane,
  SplitNode,
  Tab,
  TabSnapshot,
} from "../types";
import { collectLeaves } from "./split-tree";
import { getTerminalCwd, getTerminalInstance } from "./terminal-registry";

// --- Capture ---------------------------------------------------------------

function snapshotPane(paneId: string, pane: PaneType): SnapshotPane {
  if (pane.kind === "terminal") {
    const instance = getTerminalInstance(paneId);
    return {
      kind: "terminal",
      // Live directory first, spawn directory as the fallback: a pane that
      // never got a cwd report (Windows, or a shell that stayed quiet) still
      // reopens somewhere sensible rather than at the startup path.
      cwd: getTerminalCwd(paneId) || pane.cwd || "",
      title: instance?.title,
      // Filled in by the session providers (see stores/session-meta.ts). Absent
      // means "nothing resumable was running here", which is the common case.
      session: instance?.sessionMeta,
    };
  }
  return pane.kind === "markdown"
    ? { kind: "markdown", filePath: pane.filePath }
    : { kind: "text", filePath: pane.filePath };
}

export function snapshotNode(node: SplitNode): SnapshotNode {
  if (node.type === "leaf") {
    return { type: "leaf", pane: snapshotPane(node.id, node.pane) };
  }
  return {
    type: "split",
    direction: node.direction,
    ratio: node.ratio,
    first: snapshotNode(node.first),
    second: snapshotNode(node.second),
  };
}

export function snapshotTab(tab: Tab): TabSnapshot {
  const leaves = collectLeaves(tab.root);
  const activeIndex = leaves.findIndex((l) => l.id === tab.activePaneId);
  return {
    title: tab.title,
    manualTitle: tab.manualTitle,
    root: snapshotNode(tab.root),
    // Position, not id: ids are minted fresh on hydrate. -1 can't happen for a
    // consistent tab, but a 0 fallback keeps a corrupt one openable.
    activePaneIndex: activeIndex === -1 ? 0 : activeIndex,
  };
}

// --- Hydrate ---------------------------------------------------------------

function hydratePane(pane: SnapshotPane): PaneType {
  if (pane.kind === "terminal") {
    // ptyId null = "not spawned yet", exactly like a freshly created pane.
    return { kind: "terminal", ptyId: null, cwd: pane.cwd };
  }
  return pane.kind === "markdown"
    ? { kind: "markdown", filePath: pane.filePath }
    : { kind: "text", filePath: pane.filePath };
}

// Hydration mints the pane ids, so it's also the only place that can say which
// *new* pane inherits a snapshot's resumable session. Rather than reach into the
// restore registry from here — which would make a pure transform depend on the
// pty layer — it reports each one and lets the caller decide. Callers that don't
// care (a preview, a test) simply pass nothing.
export function hydrateNode(
  node: SnapshotNode,
  onSession?: (paneId: PaneId, session: SessionMeta) => void
): SplitNode {
  if (node.type === "leaf") {
    const id = nanoid(8);
    if (node.pane.kind === "terminal" && node.pane.session) {
      onSession?.(id, node.pane.session);
    }
    return { type: "leaf", id, pane: hydratePane(node.pane) };
  }
  return {
    type: "split",
    id: nanoid(8),
    direction: node.direction,
    ratio: node.ratio,
    first: hydrateNode(node.first, onSession),
    second: hydrateNode(node.second, onSession),
  };
}

export function hydrateTab(
  snapshot: TabSnapshot,
  onSession?: (paneId: PaneId, session: SessionMeta) => void
): Tab {
  const root = hydrateNode(snapshot.root, onSession);
  const leaves = collectLeaves(root);
  return {
    id: nanoid(8),
    title: snapshot.title,
    manualTitle: snapshot.manualTitle,
    root,
    activePaneId:
      leaves[snapshot.activePaneIndex]?.id ?? leaves[0]?.id ?? root.id,
    // Focus history is about panes that no longer exist — a restored tab starts
    // with a clean one rather than a list of dead ids to prune on first close.
    paneHistory: [],
  };
}

// --- Validation ------------------------------------------------------------
//
// Snapshots round-trip through localStorage, so anything read back is untrusted:
// a blob written by an older version, a hand-edit, a truncated write. Every
// field is checked before it reaches the store, because a malformed tree would
// throw inside the render, and a boot that can't render is a boot that can't be
// fixed from the UI.

function isSnapshotPane(v: unknown): v is SnapshotPane {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  if (p.kind === "terminal") {
    return typeof p.cwd === "string";
  }
  if (p.kind === "markdown" || p.kind === "text") {
    return typeof p.filePath === "string";
  }
  return false;
}

// Depth is bounded so a cyclic or absurdly deep blob can't blow the stack here
// (and, having passed, can't blow it in the renderer either). No real layout
// comes close: 32 nested splits is 33 panes in one tab.
const MAX_SNAPSHOT_DEPTH = 32;

export function isSnapshotNode(v: unknown, depth = 0): v is SnapshotNode {
  if (!v || typeof v !== "object" || depth > MAX_SNAPSHOT_DEPTH) return false;
  const n = v as Record<string, unknown>;
  if (n.type === "leaf") return isSnapshotPane(n.pane);
  if (n.type !== "split") return false;
  return (
    (n.direction === "h" || n.direction === "v") &&
    typeof n.ratio === "number" &&
    Number.isFinite(n.ratio) &&
    isSnapshotNode(n.first, depth + 1) &&
    isSnapshotNode(n.second, depth + 1)
  );
}

export function isTabSnapshot(v: unknown): v is TabSnapshot {
  if (!v || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.title === "string" &&
    typeof t.manualTitle === "boolean" &&
    typeof t.activePaneIndex === "number" &&
    isSnapshotNode(t.root)
  );
}
