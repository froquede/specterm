// Panes asking to be looked at.
//
// One pane in one tab has stopped and is waiting on the person at the keyboard
// — Claude Code finished its turn, or is asking permission to run something.
// The pane may not even be on screen: it's in another tab, or in a split that's
// dimmed, or the window is behind a browser. This store is the single place
// that fact lives, and everything that draws it (the tab chip, the pane's
// title-bar, the dock badge) reads from here.
//
// Deliberately generic: nothing in this file knows what Claude Code is. A
// detector (lib/claude-attention.ts) or an explicit signal from the program
// itself (the OSC in lib/osc.ts, a terminal bell) calls `markAttention`, and
// the kind is only ever used to pick a colour and a tooltip.

import { createSignal } from "solid-js";
import type { PaneId } from "../types";

// Why a pane is asking for attention:
//   permission — it is blocked on a yes/no (Claude's tool-permission prompt)
//   idle       — it finished and is waiting for the next instruction
//   bell       — the program rang the terminal bell (any program, not just
//                Claude: a long `make` that ends with \a lands here too)
// `permission` is drawn more insistently than the other two because it is the
// one where nothing at all progresses until you answer.
export type AttentionKind = "permission" | "idle" | "bell";

// paneId -> why. Replaced wholesale on every write rather than mutated: the
// map holds one entry per *waiting* pane, which is almost always zero or one,
// so copying it is cheaper than the bookkeeping a fine-grained store would add.
const [attention, setAttention] = createSignal<Record<PaneId, AttentionKind>>(
  {}
);

// The pane the user is actually looking at, kept current by App. Attention for
// it would be noise — you can see the prompt — so marking it is a no-op, and
// focusing it clears whatever was already there.
const [focusedPane, setFocusedPaneSignal] = createSignal<PaneId | null>(null);

/**
 * Is the user in front of the window right now?
 *
 * `document.hasFocus()` and not `!document.hidden`: a window that is visible
 * but behind another one is exactly the case where an indicator is worth
 * something, and `hidden` is false for it.
 */
function windowHasFocus(): boolean {
  return typeof document !== "undefined" && document.hasFocus();
}

/** Why this pane is waiting, or undefined when it isn't. */
export function paneAttention(paneId: PaneId): AttentionKind | undefined {
  return attention()[paneId];
}

/** Every pane currently waiting — what the dock badge counts. */
export function attentionCount(): number {
  return Object.keys(attention()).length;
}

/**
 * Record that a pane is waiting on the user.
 *
 * Ignored for the pane the user is already looking at, and a `permission` never
 * gets downgraded to an `idle`/`bell` by a later signal: while a prompt is up,
 * that is the more urgent thing to say about the pane.
 */
export function markAttention(paneId: PaneId, kind: AttentionKind) {
  if (paneId === focusedPane() && windowHasFocus()) return;
  const current = attention()[paneId];
  if (current === kind) return;
  if (current === "permission" && kind !== "permission") return;
  setAttention((prev) => ({ ...prev, [paneId]: kind }));
}

/** The pane is no longer waiting — it was focused, typed into, or closed. */
export function clearAttention(paneId: PaneId) {
  if (!(paneId in attention())) return;
  setAttention((prev) => {
    const next = { ...prev };
    delete next[paneId];
    return next;
  });
}

/** Put every flag out at once — the feature was switched off. */
export function clearAllAttention() {
  if (attentionCount() === 0) return;
  setAttention({});
}

/**
 * Tell the store where the user is, clearing that pane on the way.
 *
 * Unconditional, unlike the check in `markAttention`: a pane only becomes the
 * active one because someone made it so — clicked its tab, moved with a
 * shortcut, brought the window back — so arriving at it is the acknowledgement,
 * whatever `document.hasFocus()` happens to say at that instant. At startup
 * nothing is flagged yet, so the same call costs nothing.
 */
export function setFocusedPane(paneId: PaneId | null) {
  setFocusedPaneSignal(paneId);
  if (paneId) clearAttention(paneId);
}
