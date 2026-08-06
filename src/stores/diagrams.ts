// Diagrams found in terminal output, and which one is on screen.
//
// The finding is done by lib/terminal-diagrams.ts; this is only the part the UI
// reads. Split the same way stores/attention.ts is split from the detectors
// that feed it, and for the same reason: the detector deals in xterm buffers
// and markers, the components deal in a list and an index, and neither needs to
// know how the other works.

import { createSignal } from "solid-js";
import type { PaneId } from "../types";

export interface PaneDiagram {
  id: string;
  /** The diagram's first line — "flowchart TD", "sequenceDiagram". */
  title: string;
  /** Mermaid source, as good a copy as the detector could get. */
  source: string;
  /** True when the source is known-complete (a fenced block, or one recovered
   *  from a Claude transcript) rather than guessed off the screen. Only used to
   *  decide how hard the renderer should try to trim a trailing line. */
  exact: boolean;
}

// paneId -> diagrams found there, oldest first. Replaced wholesale on write:
// a pane holds a handful of entries at most, and copying that is cheaper than
// the machinery a finer-grained store would need.
const [diagrams, setDiagrams] = createSignal<Record<PaneId, PaneDiagram[]>>({});

const [open, setOpen] = createSignal<{ paneId: PaneId; id: string } | null>(
  null
);

/** Diagrams found in a pane, oldest first. */
export function paneDiagrams(paneId: PaneId): PaneDiagram[] {
  return diagrams()[paneId] ?? [];
}

export function addDiagram(paneId: PaneId, diagram: PaneDiagram) {
  setDiagrams((all) => ({
    ...all,
    [paneId]: [...(all[paneId] ?? []), diagram],
  }));
}

/**
 * Replace a diagram's source in place.
 *
 * Two things land after the chip is already up, and both are this:
 *
 *   - The transcript lookup that produces the exact source is a file read, so
 *     an overlay can be open on the scraped copy when the better one arrives.
 *   - A block printed by a program that streams — an agent writing its answer
 *     out as it goes — is *incomplete* when the first scan finds it, and grows
 *     on later ones.
 *
 * Keeping the id is what makes both invisible: the chip stays where it is, and
 * an overlay showing the diagram simply re-renders.
 */
export function replaceDiagramSource(
  paneId: PaneId,
  id: string,
  source: string,
  exact: boolean
) {
  setDiagrams((all) => {
    const list = all[paneId];
    if (!list) return all;
    const next = list.map((d) => (d.id === id ? { ...d, source, exact } : d));
    return { ...all, [paneId]: next };
  });
}

export function clearPaneDiagrams(paneId: PaneId) {
  if (open()?.paneId === paneId) setOpen(null);
  setDiagrams((all) => {
    if (!(paneId in all)) return all;
    const next = { ...all };
    delete next[paneId];
    return next;
  });
}

/** Which diagram the overlay is showing, if any. */
export const openDiagramTarget = open;

export function openDiagram(paneId: PaneId, id: string) {
  setOpen({ paneId, id });
}

export function closeDiagram() {
  setOpen(null);
}

/** Step to the previous/next diagram in the same pane, wrapping at the ends. */
export function stepDiagram(delta: 1 | -1) {
  const target = open();
  if (!target) return;
  const list = paneDiagrams(target.paneId);
  if (list.length < 2) return;
  const index = list.findIndex((d) => d.id === target.id);
  if (index === -1) return;
  const next = (index + delta + list.length) % list.length;
  setOpen({ paneId: target.paneId, id: list[next].id });
}
