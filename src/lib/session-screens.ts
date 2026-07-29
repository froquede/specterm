// The screen half of session restore.
//
// The layout snapshot (stores/history.ts) records what was open — tabs, splits,
// working directories. This records what was *on* it: each terminal's screen and
// scrollback, serialized as the escape sequences that reproduce it. Together
// they're the difference between reopening the same panes and finding the
// session as it was left, which is the thing a tmux user means by "restore".
//
// It lives in its own storage key, written on its own schedule, for one reason:
// size. A layout snapshot is a couple of kilobytes and is rewritten on every
// store change (a divider drag, a tab switch). A screen is up to a quarter of a
// megabyte per pane. Folding them together would put a megabyte-scale synchronous
// localStorage write on the path of every mousemove during a resize.
//
// So screens are captured at exactly one moment — the window going away (see
// captureSessionNow in stores/tabs.ts) — and the capture is deliberately
// synchronous, because that moment is `beforeunload` and nothing asynchronous is
// guaranteed to finish there. The cost of that choice is that a hard kill loses
// the screens; the layout still survives on its own debounce.

import type { SnapshotPane } from "../types";
import { serializeTerminalSync } from "./terminal-registry";

const STORAGE_KEY = "specterm.session.screens";
const SCHEMA_VERSION = 1;

// Budgets. localStorage gives the whole origin about 5MB, shared with settings,
// themes, the closed-tab stack and markdown drafts — so screens get a fraction of
// it, not all of it. The per-pane ceiling stops one pane that ran a huge build
// log from spending the entire budget before the others are even looked at.
const MAX_PANE_CHARS = 256_000;
const MAX_TOTAL_CHARS = 2_000_000;

// Scrollback depths tried, in order, until one fits under MAX_PANE_CHARS. The
// first is xterm's default scrollback (the whole buffer); the last is 0, which
// still serializes the viewport — the screen you were actually looking at, which
// is the part worth keeping if only part can be.
const SCROLLBACK_STEPS = [1000, 250, 60, 0];

export type ScreenStore = Record<string, string>;

// --- Capture ---------------------------------------------------------------

// Serialize one pane at the deepest scrollback that fits the per-pane budget.
// Returns "" when even the bare viewport is over it (a very wide terminal full of
// per-cell color changes), which just means that pane restores empty.
function serializeCapped(paneId: string): string {
  for (const scrollback of SCROLLBACK_STEPS) {
    const text = serializeTerminalSync(paneId, scrollback);
    if (!text) return "";
    if (text.length <= MAX_PANE_CHARS) return text;
  }
  return "";
}

/**
 * Serialize the screens of `paneIds`, in order, until the total budget runs out.
 *
 * Order is the caller's priority, not the tree's: stores/tabs.ts passes the
 * active tab's panes first, so when the budget is spent it's the panes the user
 * was actually looking at that survive and a background tab that was left with a
 * huge log open that doesn't.
 */
export function captureScreens(paneIds: string[]): ScreenStore {
  const screens: ScreenStore = {};
  let total = 0;
  for (const paneId of paneIds) {
    if (total >= MAX_TOTAL_CHARS) break;
    let text: string;
    try {
      text = serializeCapped(paneId);
    } catch (_) {
      // A pane torn down mid-capture (the window is closing around us) — skip it
      // rather than lose every screen after it in the list.
      continue;
    }
    if (!text || total + text.length > MAX_TOTAL_CHARS) continue;
    screens[paneId] = text;
    total += text.length;
  }
  return screens;
}

// --- Persistence -----------------------------------------------------------

interface StoredScreens {
  version: number;
  screens: ScreenStore;
}

/**
 * Write the screens out, shedding entries until they fit.
 *
 * The budgets above are an estimate of what localStorage will accept; the quota
 * is the real answer, and it depends on what everything else in the app has
 * already stored. So a rejected write isn't given up on — the last (lowest
 * priority) entry is dropped and it's tried again. Insertion order is the caller's
 * priority order, and `Object.keys` preserves it for string keys, so what gets
 * shed is what mattered least.
 */
export function saveScreens(screens: ScreenStore) {
  const keys = Object.keys(screens);
  let remaining = { ...screens };
  for (let i = keys.length; i >= 0; i--) {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          version: SCHEMA_VERSION,
          screens: remaining,
        } satisfies StoredScreens)
      );
      return;
    } catch (_) {
      // Over quota (or storage unavailable). Drop the least important entry and
      // try again; if that empties the map, the next pass writes `{}` and the one
      // after gives up entirely.
      const last = Object.keys(remaining).pop();
      if (last === undefined) break;
      const { [last]: _dropped, ...rest } = remaining;
      remaining = rest;
    }
  }
  // Even an empty payload wouldn't go in. Clear the key so a boot doesn't replay
  // screens from some older, unrelated session onto this layout.
  clearScreens();
}

/**
 * Read the saved screens back. Everything here is untrusted — it round-tripped
 * through localStorage and may have been written by an older version or edited by
 * hand — and it is about to be written straight into a terminal, so a value that
 * isn't a plain string, or is longer than anything we would ever have written, is
 * dropped rather than replayed.
 */
export function loadScreens(): ScreenStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as StoredScreens | null;
    if (!parsed || parsed.version !== SCHEMA_VERSION) return {};
    const source = parsed.screens;
    if (!source || typeof source !== "object") return {};
    const screens: ScreenStore = {};
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === "string" && value.length <= MAX_PANE_CHARS) {
        screens[key] = value;
      }
    }
    return screens;
  } catch (_) {
    return {};
  }
}

export function clearScreens() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (_) {
    // Storage unavailable — a stale blob is harmless, it's only read on boot and
    // only for keys the restored layout actually names.
  }
}

/** The screen saved for a snapshot pane, or "" when it has none. */
export function screenFor(pane: SnapshotPane, screens: ScreenStore): string {
  if (pane.kind !== "terminal" || !pane.screenKey) return "";
  return screens[pane.screenKey] ?? "";
}
