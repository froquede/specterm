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
//   notify     — the program sent a desktop-notification sequence (OSC 9/777/99,
//                see lib/osc.ts), which unlike the others carries a message
// `permission` is drawn more insistently than the rest because it is the one
// where nothing at all progresses until you answer.
export type AttentionKind = "permission" | "idle" | "bell" | "notify";

// The generic line for each kind, used when the program didn't say anything of
// its own. Lives here rather than in a component because both the tab chip and
// the pane title-bar draw it, and it belongs next to the union it describes.
const ATTENTION_TITLE: Record<AttentionKind, string> = {
  permission: "Waiting for your answer",
  idle: "Finished — waiting for you",
  bell: "Rang the terminal bell",
  notify: "Waiting for you",
};

/** What the program said if it said anything, else the generic line. */
export function attentionTitle(kind: AttentionKind, message?: string): string {
  return message || ATTENTION_TITLE[kind];
}

// paneId -> why. Replaced wholesale on every write rather than mutated: the
// map holds one entry per *waiting* pane, which is almost always zero or one,
// so copying it is cheaper than the bookkeeping a fine-grained store would add.
const [attention, setAttention] = createSignal<Record<PaneId, AttentionKind>>(
  {}
);

// paneId -> what the program said, for the kinds that say anything. Kept beside
// the map above rather than widening it: every existing reader wants the kind
// and nothing else, and a second sparse signal leaves all of them untouched.
const [messages, setMessages] = createSignal<Record<PaneId, string>>({});

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

/** What the program in this pane said, when it said anything. */
export function paneAttentionMessage(paneId: PaneId): string | undefined {
  return messages()[paneId];
}

/** Every pane currently waiting — what the dock badge counts. */
export function attentionCount(): number {
  return Object.keys(attention()).length;
}

/**
 * The waiting panes, oldest first.
 *
 * Insertion order is meaningful here: the map is rebuilt by spreading the
 * previous one, so keys stay in the order their panes started waiting — which
 * is the order "jump to the next one" should walk them in.
 */
export function waitingPanes(): PaneId[] {
  return Object.keys(attention());
}

/**
 * Record that a pane is waiting on the user.
 *
 * Ignored for the pane the user is already looking at, and a `permission` never
 * gets downgraded to any other kind by a later signal: while a prompt is up,
 * that is the more urgent thing to say about the pane.
 *
 * `message` is what the program said, for the kinds that carry one. Passing
 * none clears any previous text, so the dot and its tooltip can never disagree
 * — a pane that notified "build finished" and then merely rang the bell should
 * not still be claiming the build.
 */
export function markAttention(
  paneId: PaneId,
  kind: AttentionKind,
  message?: string
) {
  if (paneId === focusedPane() && windowHasFocus()) return;
  const current = attention()[paneId];
  if (current === "permission" && kind !== "permission") return;

  // Kept ahead of the kind check below: a second notification with new text but
  // the same kind must still update what the tooltip says.
  if (message) {
    if (messages()[paneId] !== message) {
      setMessages((prev) => ({ ...prev, [paneId]: message }));
    }
  } else if (paneId in messages()) {
    setMessages((prev) => {
      const next = { ...prev };
      delete next[paneId];
      return next;
    });
  }

  if (current === kind) return;
  setAttention((prev) => ({ ...prev, [paneId]: kind }));
}

/** The pane is no longer waiting — it was focused, typed into, or closed. */
export function clearAttention(paneId: PaneId) {
  if (paneId in messages()) {
    setMessages((prev) => {
      const next = { ...prev };
      delete next[paneId];
      return next;
    });
  }
  if (!(paneId in attention())) return;
  setAttention((prev) => {
    const next = { ...prev };
    delete next[paneId];
    return next;
  });
}

/** Put every flag out at once — the feature was switched off. */
export function clearAllAttention() {
  if (Object.keys(messages()).length > 0) setMessages({});
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
