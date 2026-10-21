import { createSignal } from "solid-js";
import type { PaneId, SplitNode, TabId } from "../types";
import { collectLeaves } from "../lib/split-tree";

// How a pane is shown, separate from what it holds. Three independent states:
//
//   zoomed    — one pane per tab fills the whole workspace; the others stay
//               mounted (their processes keep running) but are not laid out.
//   collapsed — the pane shrinks to its title-bar along its parent split and
//               the sibling takes the space. Click the bar to bring it back.
//   hidden    — the pane keeps its place, but its content is replaced by a
//               cover, for when someone is looking over your shoulder.
//
// All three take content out of layout with display:none rather than painting
// over it or squeezing it to nothing. A cover alone would not hide a browser
// pane: its page sits in a layer above the panes (lib/browser-registry.ts) and
// hides itself only when its placeholder has no size. A squeezed terminal would
// be refit to its tiny box, and a program that redraws itself (Claude Code,
// vim) would repaint at that width. A terminal out of layout is not refit at
// all (safeFit in lib/terminal-registry.ts), so the shell keeps its size until
// the pane comes back.
//
// Per window and not persisted: a pane moved to another window, or restored
// on the next launch, comes back open.

const [zoomed, setZoomed] = createSignal<Record<TabId, PaneId>>({});
const [collapsed, setCollapsed] = createSignal<ReadonlySet<PaneId>>(new Set());
const [hidden, setHidden] = createSignal<ReadonlySet<PaneId>>(new Set());

function toggled(set: ReadonlySet<PaneId>, id: PaneId): Set<PaneId> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function zoomedPane(tabId: TabId): PaneId | undefined {
  return zoomed()[tabId];
}

export function toggleZoom(tabId: TabId, paneId: PaneId) {
  setZoomed((prev) => {
    const next = { ...prev };
    if (next[tabId] === paneId) delete next[tabId];
    else next[tabId] = paneId;
    return next;
  });
  // Zooming into a collapsed pane would show a bar stretched over the window.
  if (zoomed()[tabId] === paneId && collapsed().has(paneId)) {
    setCollapsed((prev) => toggled(prev, paneId));
  }
}

export function isCollapsed(paneId: PaneId): boolean {
  return collapsed().has(paneId);
}

export function toggleCollapsed(paneId: PaneId) {
  setCollapsed((prev) => toggled(prev, paneId));
}

export function isHidden(paneId: PaneId): boolean {
  return hidden().has(paneId);
}

export function toggleHidden(paneId: PaneId) {
  setHidden((prev) => toggled(prev, paneId));
}

/** Drop what is kept for a pane that has ended or left this window. */
export function forgetPane(paneId: PaneId) {
  if (collapsed().has(paneId)) setCollapsed((prev) => toggled(prev, paneId));
  if (hidden().has(paneId)) setHidden((prev) => toggled(prev, paneId));
  const z = zoomed();
  const tabId = Object.keys(z).find((t) => z[t] === paneId);
  if (tabId) toggleZoom(tabId, paneId);
}

/** True when every pane under `node` is collapsed. */
export function subtreeCollapsed(node: SplitNode): boolean {
  const set = collapsed();
  return collectLeaves(node).every((leaf) => set.has(leaf.id));
}

/** True when `node` holds the pane with this id. */
export function subtreeHas(node: SplitNode, paneId: PaneId): boolean {
  return collectLeaves(node).some((leaf) => leaf.id === paneId);
}
