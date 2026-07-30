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
import { clearScreens } from "../lib/session-screens";
import { publishStoreChange, registerStoreSync } from "../lib/store-sync";
import { getBackend } from "../backends";

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

// Where the saved session used to live. It belongs to the host now — one entry per
// window, assembled and written there (see the session block in electron/main.cjs)
// — because a single localStorage key shared by every window could only ever hold
// one of them. Read once more on the first launch after an upgrade so nobody loses
// the tabs they had, then dropped.
const LEGACY_SESSION_KEY = "specterm.session";

// Bumped when a stored shape stops being readable by this code. Blobs at any
// other version are dropped rather than migrated: the cost of guessing wrong is
// a broken boot, and the thing being lost is one session's tab layout.
const SCHEMA_VERSION = 1;

interface StoredClosed {
  version: number;
  entries: ClosedEntry[];
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

// The closed stack is one stack for the whole app, not one per window: "reopen
// what I closed last" means the last thing closed anywhere. Every window holds
// its own cached copy of it, though, so both ends of that have to be handled.
//
// Writes read storage back first. Two windows each holding a copy from when
// they opened, each writing their own copy out whole, would silently drop the
// other's entries — the one that saved last would win. Storage is the shared
// truth; the signal is a cache in front of it, and it's re-read at the moment
// of every write rather than trusted.
//
// Reads in *other* windows are caught up by the broadcast below, so a window
// that hasn't closed anything itself still knows there is something to reopen.
function commitClosed(next: ClosedEntry[]) {
  setClosedEntries(next.slice(0, CLOSED_LIMIT));
  persistClosed();
  publishStoreChange("closed-history");
}

registerStoreSync("closed-history", () => setClosedEntries(loadClosed()));

function push(entry: ClosedEntry) {
  commitClosed([entry, ...loadClosed()]);
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
  // Popped off storage, not off the cached signal: another window may have
  // closed something since this one last looked, and that is what "last closed"
  // has to mean.
  const [head, ...rest] = loadClosed();
  if (!head) return null;
  commitClosed(rest);
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
    const body = JSON.stringify({ tabs, activeTabIndex });
    // Unchanged layout, so there is nothing to tell anyone. Most of what wakes this
    // up — a divider drag settling, the sidebar opening — leaves the tabs identical,
    // and those now cost a string compare instead of an IPC.
    if (body === lastWritten) return;

    void getBackend()
      .then((backend) => backend.pushLayout({ tabs, activeTabIndex }))
      .catch(() => {
        /* No host-side session storage — this session won't be restorable. */
      });
    lastWritten = body;
  } catch (_) {
    // The snapshot threw on a half-torn-down pane. Never worth breaking the action
    // that triggered the save.
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

/**
 * Validate a window's saved tabs, whatever the source.
 *
 * Everything reaching this is untrusted — it round-tripped through a file, or a
 * localStorage key, and may have been written by an older version or edited by
 * hand. A malformed tree would throw inside the render, and a boot that can't
 * render is a boot that can't be fixed from the UI. Bad tabs are filtered rather
 * than rejected wholesale: one won't cost you the others.
 */
export function validateWindowSnapshot(
  raw: { tabs?: unknown[]; activeTabIndex?: number } | null | undefined
): { tabs: TabSnapshot[]; activeTabIndex: number } | null {
  if (!raw || !Array.isArray(raw.tabs)) return null;
  const tabs = raw.tabs.filter(isTabSnapshot);
  if (tabs.length === 0) return null;
  const index = raw.activeTabIndex;
  return {
    tabs,
    activeTabIndex:
      typeof index === "number" && index >= 0 && index < tabs.length ? index : 0,
  };
}

/**
 * The session left behind by the version that kept it in localStorage.
 *
 * Read once, by the single window the host says may migrate, and cleared as soon
 * as it's read — so an upgrade costs nobody their tabs and nothing looks here
 * again. Its screens went with it and are already on disk under the same keys.
 */
export function takeLegacySession():
  | { tabs: TabSnapshot[]; activeTabIndex: number }
  | null {
  try {
    const raw = localStorage.getItem(LEGACY_SESSION_KEY);
    if (!raw) return null;
    localStorage.removeItem(LEGACY_SESSION_KEY);
    const parsed = JSON.parse(raw) as {
      version?: number;
      tabs?: unknown[];
      activeTabIndex?: number;
    } | null;
    if (!parsed || parsed.version !== SCHEMA_VERSION) return null;
    return validateWindowSnapshot(parsed);
  } catch (_) {
    return null;
  }
}

export function clearSession() {
  void getBackend()
    .then((backend) => backend.pushLayout(null))
    .catch(() => {
      /* nothing to clear */
    });
  try {
    localStorage.removeItem(LEGACY_SESSION_KEY);
  } catch (_) {
    // Nothing reads that key any more.
  }
  // The screens are the other half of the same session (lib/session-screens.ts)
  // and they're the expensive half to leave lying around — dropping the layout
  // without them would strand megabytes nothing can ever read.
  clearScreens();
}
