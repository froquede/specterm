// Session history: what was closed, and what was open when the app quit.
//
// Two separate things live here, both fed by snapshots (lib/session-snapshot.ts)
// and both persisted to localStorage:
//
//   - The **closed stack** — an undo stack for closing things, modelled on the
//     browser's reopen-closed-tab. Tabs and panes share one stack in close
//     order, so repeated presses walk back through what you actually did rather
//     than through two parallel lists that interleave unpredictably.
//   - The **last session** — the whole tab strip as it stood, rewritten as you
//     work, so "continue where I left off" has something to read on boot.
//
// This module is deliberately passive: it stores and returns snapshots but never
// touches the tab store. Reopening is a tab-store operation (it mints ids, kills
// nothing, and has to reseat focus), so stores/tabs.ts pops from here and does
// the work — keeping the dependency one-way and the two testable apart.

import { createSignal } from "solid-js";
import type { SnapshotNode, TabSnapshot } from "../types";
import { isSnapshotNode, isTabSnapshot } from "../lib/session-snapshot";

// A closed tab, with where it sat so reopening puts it back in place rather
// than at the end of the strip.
export interface ClosedTabEntry {
  kind: "tab";
  closedAt: number;
  index: number;
  snapshot: TabSnapshot;
}

// A closed pane. `tabId` is the tab it came out of: still open, and the pane
// goes back in beside the active one; gone, and it comes back as its own tab,
// so the entry is never a dead end.
export interface ClosedPaneEntry {
  kind: "pane";
  closedAt: number;
  tabId: string;
  title: string;
  snapshot: SnapshotNode;
}

export type ClosedEntry = ClosedTabEntry | ClosedPaneEntry;

// How far back reopening reaches. Chrome keeps 25; the same number here is far
// more than anyone walks back through, and the whole stack is a handful of
// kilobytes of plain data.
const CLOSED_LIMIT = 25;

const CLOSED_KEY = "specterm.history.closed";
const SESSION_KEY = "specterm.session";

// Bumped when a stored shape stops being readable by this code. Blobs at any
// other version are dropped rather than migrated: the cost of guessing wrong is
// a broken boot, and the thing being lost is one session's tab layout.
const SCHEMA_VERSION = 1;

interface StoredClosed {
  version: number;
  entries: ClosedEntry[];
}

export interface SessionSnapshot {
  version: number;
  savedAt: number;
  tabs: TabSnapshot[];
  activeTabIndex: number;
}

// --- Closed stack ----------------------------------------------------------

function isClosedEntry(v: unknown): v is ClosedEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  if (typeof e.closedAt !== "number") return false;
  if (e.kind === "tab") {
    return typeof e.index === "number" && isTabSnapshot(e.snapshot);
  }
  if (e.kind === "pane") {
    return (
      typeof e.tabId === "string" &&
      typeof e.title === "string" &&
      isSnapshotNode(e.snapshot)
    );
  }
  return false;
}

function loadClosed(): ClosedEntry[] {
  try {
    const raw = localStorage.getItem(CLOSED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredClosed | null;
    if (!parsed || parsed.version !== SCHEMA_VERSION) return [];
    if (!Array.isArray(parsed.entries)) return [];
    // Filter rather than reject: one bad entry shouldn't cost the other 24.
    return parsed.entries.filter(isClosedEntry).slice(0, CLOSED_LIMIT);
  } catch (_) {
    // Corrupt or unavailable storage — start with an empty stack.
    return [];
  }
}

// Reactive so the UI can tell whether there's anything to reopen (a disabled
// menu entry, a hint in settings) without polling.
const [closedEntries, setClosedEntries] = createSignal<ClosedEntry[]>(
  loadClosed()
);

export { closedEntries };

function persistClosed() {
  try {
    localStorage.setItem(
      CLOSED_KEY,
      JSON.stringify({
        version: SCHEMA_VERSION,
        entries: closedEntries(),
      } satisfies StoredClosed)
    );
  } catch (_) {
    // Storage full or unavailable — the stack still works for this session.
  }
}

function push(entry: ClosedEntry) {
  setClosedEntries((prev) => [entry, ...prev].slice(0, CLOSED_LIMIT));
  persistClosed();
}

export function recordClosedTab(snapshot: TabSnapshot, index: number) {
  push({ kind: "tab", closedAt: Date.now(), index, snapshot });
}

export function recordClosedPane(
  snapshot: SnapshotNode,
  tabId: string,
  title: string
) {
  push({ kind: "pane", closedAt: Date.now(), tabId, title, snapshot });
}

/** Take the most recently closed thing off the stack. Null when it's empty. */
export function popClosed(): ClosedEntry | null {
  const [head, ...rest] = closedEntries();
  if (!head) return null;
  setClosedEntries(rest);
  persistClosed();
  return head;
}

export function clearClosed() {
  setClosedEntries([]);
  persistClosed();
}

// --- Last session ----------------------------------------------------------
//
// Saved on a debounce because the tab store is one signal: opening the sidebar
// or dragging a divider writes it just as a new tab does, and none of those are
// worth a synchronous JSON.stringify of every tab. The debounce is short enough
// that a crash loses at most the last edit, and `flushSession` covers the one
// moment that must not be missed — the window going away.
//
// What's deferred is the *snapshot*, not just the write: callers hand over a
// thunk, evaluated once when the timer fires. A divider drag writes the store on
// every mousemove, and walking every tab's tree on each of those — to throw all
// but the last away — is the one version of this that would be felt.

const SAVE_DEBOUNCE_MS = 1000;

interface SessionSource {
  tabs: TabSnapshot[];
  activeTabIndex: number;
}

let saveTimer: number | null = null;
let pending: (() => SessionSource) | null = null;

// The last payload actually written, minus its timestamp. localStorage.setItem
// is synchronous on the renderer's main thread — the same thread drawing the
// terminal — so a write that changes nothing is pure jank. Most of what wakes
// this up (a divider drag settling, the sidebar opening) leaves the tab layout
// identical, and those now cost a string compare instead of a serialize-and-
// write. The timestamp is excluded from the comparison precisely so it can't
// make every payload look new.
let lastWritten = "";

function writeSession(source: () => SessionSource) {
  try {
    const { tabs, activeTabIndex } = source();
    const body = JSON.stringify({
      version: SCHEMA_VERSION,
      tabs,
      activeTabIndex,
    });
    if (body === lastWritten) return;

    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        version: SCHEMA_VERSION,
        savedAt: Date.now(),
        tabs,
        activeTabIndex,
      } satisfies SessionSnapshot)
    );
    lastWritten = body;
  } catch (_) {
    // Storage full/unavailable, or the snapshot threw on a half-torn-down pane.
    // Either way this session just won't be restorable — never worth breaking
    // the action that triggered the save.
  }
}

export function saveSession(source: () => SessionSource) {
  pending = source;
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    if (pending) writeSession(pending);
    pending = null;
  }, SAVE_DEBOUNCE_MS);
}

/** Write any debounced snapshot out now — called as the window closes. */
export function flushSession() {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (pending) {
    writeSession(pending);
    pending = null;
  }
}

export function loadSession(): SessionSnapshot | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SessionSnapshot | null;
    if (!parsed || parsed.version !== SCHEMA_VERSION) return null;
    if (!Array.isArray(parsed.tabs)) return null;
    const tabs = parsed.tabs.filter(isTabSnapshot);
    if (tabs.length === 0) return null;
    return {
      version: parsed.version,
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
      tabs,
      activeTabIndex:
        typeof parsed.activeTabIndex === "number" &&
        parsed.activeTabIndex >= 0 &&
        parsed.activeTabIndex < tabs.length
          ? parsed.activeTabIndex
          : 0,
    };
  } catch (_) {
    return null;
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch (_) {
    // Nothing to do — a stale snapshot is harmless, it's only read on boot.
  }
}
