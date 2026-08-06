import { createSignal } from "solid-js";
import { nanoid } from "nanoid";
import type {
  AppState,
  Tab,
  TabId,
  PaneType,
  PaneId,
  SplitNode,
  SidebarView,
} from "../types";
import {
  createLeaf,
  collectLeaves,
  firstLeafId,
  findLeafNode,
  insertBeside,
  closePane,
  moveLeaf,
  moveLeafToRootEdge,
  findParentSplit,
  findPaneInDirection,
  setSplitDirection,
  toggleSplitDirection,
  type DropEdge,
  type FocusDirection,
} from "../lib/split-tree";
import {
  destroyTerminal,
  releaseTerminal,
  getTerminalInstance,
  getTerminalCwd,
} from "../lib/terminal-registry";
import { releasePty } from "../lib/pty";
import type { TransferTab } from "../backends/types";
import {
  rebuildTab,
  serializeLeaf,
  serializeTab,
} from "../lib/transfer";
import {
  hydrateNode,
  hydrateTab,
  snapshotNode,
  snapshotTab,
} from "../lib/session-snapshot";
import { registerPendingRestore } from "../lib/session-restore";
import {
  loadSession,
  popClosed,
  recordClosedPane,
  recordClosedTab,
  saveSession,
} from "./history";
import { restoreLastSession } from "./settings";

function createTerminalTab(cwd = ""): Tab {
  const leaf = createLeaf({ kind: "terminal", ptyId: null, cwd });
  return {
    id: nanoid(8),
    title: "Terminal",
    manualTitle: false,
    root: leaf,
    activePaneId: leaf.id,
    paneHistory: [],
  };
}

// A label for a closed pane in the history: what the shell last called itself,
// or the file a viewer pane was showing. Only ever shown in the UI — nothing
// keys off it — so any of the fallbacks is fine.
function paneEntryTitle(leaf: Extract<SplitNode, { type: "leaf" }>): string {
  if (leaf.pane.kind === "terminal") {
    const instance = getTerminalInstance(leaf.id);
    return (
      instance?.title ||
      getTerminalCwd(leaf.id).split(/[\\/]/).filter(Boolean).pop() ||
      "Terminal"
    );
  }
  return leaf.pane.filePath.split(/[\\/]/).pop() || "File";
}

// --- Focus history (MRU) ---------------------------------------------------
// Both tabs and panes remember where focus came from, so closing the active one
// returns you there instead of to a position-derived neighbour. Without this,
// splitting a pane and closing the new one dumps you on the tree's *first* leaf
// — which, with three or more panes, is nowhere near where you were working.
//
// The lists are plain MRU stacks: most recent first, no duplicates, and they
// never contain the currently active id (it's re-pushed only when focus moves
// away from it). They're bounded because a long session cycling panes would
// otherwise grow them without limit; 32 is far past any reachable pane count
// and keeps the whole thing to one small array per tab.

const FOCUS_HISTORY_LIMIT = 32;

function pushMru<T>(history: T[], id: T | null | undefined): T[] {
  if (id === null || id === undefined) return history;
  return [id, ...history.filter((x) => x !== id)].slice(0, FOCUS_HISTORY_LIMIT);
}

// Focus `paneId` within `tab`, recording where focus is leaving from.
function focusPaneInTab(tab: Tab, paneId: PaneId): Tab {
  if (tab.activePaneId === paneId) return tab;
  return {
    ...tab,
    activePaneId: paneId,
    // Push the outgoing pane and drop the incoming one: the active id is never
    // also in the history, so reseatFocus can take the head without checking.
    paneHistory: pushMru(tab.paneHistory, tab.activePaneId).filter(
      (id) => id !== paneId
    ),
  };
}

// Rebuild a tab around a pruned tree: drop dead ids from the history and, when
// the pane that just went away held focus, hand it to the most recent survivor.
// Falling back to the first leaf keeps the old behavior for the one case it was
// ever right — a pane closed before anything else in the tab was focused.
function reseatFocus(tab: Tab, newRoot: SplitNode, closedId: PaneId): Tab {
  const alive = new Set(collectLeaves(newRoot).map((l) => l.id));
  const history = tab.paneHistory.filter((id) => alive.has(id));
  if (tab.activePaneId !== closedId) {
    return { ...tab, root: newRoot, paneHistory: history };
  }
  const [recent, ...rest] = history;
  return {
    ...tab,
    root: newRoot,
    activePaneId: recent ?? firstLeafId(newRoot),
    paneHistory: recent ? rest : history,
  };
}

// --- Boot state ------------------------------------------------------------
// What goes into a window is decided by initWindow(), below, and by nothing
// else. The rule it exists to keep is that no tab may render before that
// decision: a rendered tab has already mounted its pane and spawned a pty, and
// replacing the state afterwards would leave that shell running with nothing
// pointing at it. The store therefore starts with no tabs at all.

// A reload is not a restart, and restoring across one would be actively wrong:
// the ptys live in the main process, which a renderer reload doesn't touch. The
// old shells are still running — restoring the layout would spawn a second set
// beside them and leak the first. A real cold start has no ptys to collide with,
// which is the case this feature is for.
function isRendererReload(): boolean {
  try {
    const [nav] = performance.getEntriesByType(
      "navigation"
    ) as PerformanceNavigationTiming[];
    return nav?.type === "reload";
  } catch (_) {
    // No Navigation Timing (or a shape we don't recognize) — treat it as a cold
    // start, which is the common case and the one the user asked for.
    return false;
  }
}

// The saved "what was open" session, hydrated — or null when there is nothing to
// restore, restore is switched off, or this is a renderer reload (the previous
// shells are still alive in that case, and restoring would spawn a second set
// beside them).
function restoredTabs(): { tabs: Tab[]; activeTabId: TabId } | null {
  if (!restoreLastSession() || isRendererReload()) return null;
  const saved = loadSession();
  if (!saved) return null;
  const tabs = saved.tabs.map((t) => hydrateTab(t, registerPendingRestore));
  if (!tabs.length) return null;
  return { tabs, activeTabId: (tabs[saved.activeTabIndex] ?? tabs[0]).id };
}

// A window starts empty and is filled by initWindow() on mount.
//
// It used to be built here, at module load, so that nothing could render — and
// therefore spawn a pty — before the restore had been decided. With more than
// one window that decision is no longer the same for all of them: one is handed
// a tab by a tear-off, one owns the saved session, the rest are plain new
// windows. Starting empty keeps the same guarantee for a different reason —
// there is nothing to render until the window knows what it is — and initWindow
// is the single place that knows.
const [state, setStateRaw] = createSignal<AppState>({
  tabs: [],
  activeTabId: "",
  tabHistory: [],
  sidebarView: "files",
  renamingTabId: null,
});

// Only the window that restored the session writes it back. Every window shares
// one localStorage, so without an owner the last one to touch a tab would
// overwrite the snapshot with its own tabs — and the next launch would restore
// whichever window happened to write last, not the session as a whole.
let ownsSession = false;

function update(fn: (s: AppState) => AppState) {
  setStateRaw(fn(state()));
  // Every mutation funnels through here, so this is the one place the "what was
  // open" snapshot has to be kept current. It's handed over as a thunk and
  // debounced (stores/history.ts): a divider drag writes the store on every
  // mousemove, and snapshotting all tabs on each of those would be the only
  // version of this the user could feel.
  scheduleSessionSave();
}

function scheduleSessionSave() {
  // Nothing reads the snapshot when restore is off, so don't build one. This is
  // the whole feature's cost for anyone who doesn't want it: a boolean check per
  // store write, and no timer, no serialization, no storage write ever. The same
  // applies to a window that doesn't own the session — it never writes one.
  if (!ownsSession || !restoreLastSession()) return;

  // A window with no tabs is a transient state, not a session: it means a
  // tear-off just handed the last tab away and the window is on its way out.
  // Writing that would replace a perfectly good saved session with nothing.
  if (state().tabs.length === 0) return;

  saveSession(() => {
    const s = state();
    const index = s.tabs.findIndex((t) => t.id === s.activeTabId);
    return {
      tabs: s.tabs.map(snapshotTab),
      activeTabIndex: index === -1 ? 0 : index,
    };
  });
}

// The working directory and any running session are read from the terminal
// registry at snapshot time, and neither goes through the store — a `cd`, or a
// provider spotting a Claude session, changes what should be saved without any
// state write to trigger a save. App calls this as the window goes away so the
// last snapshot reflects where the shells actually ended up.
export function captureSessionNow() {
  scheduleSessionSave();
}

function getTabIndex(tabId: string): number {
  return state().tabs.findIndex((t) => t.id === tabId);
}

function activeTabIndex(): number {
  return getTabIndex(state().activeTabId);
}

function killPanesInTree(root: SplitNode) {
  const leaves = collectLeaves(root);
  for (const leaf of leaves) {
    if (leaf.pane.kind === "terminal") {
      destroyTerminal(leaf.id);
    }
  }
}

// The tear-off counterpart of killPanesInTree: drop this window's terminals
// without killing the shells behind them — another window is about to adopt them.
function releasePanesInTree(root: SplitNode) {
  for (const leaf of collectLeaves(root)) {
    if (leaf.pane.kind === "terminal") {
      releaseTerminal(leaf.id);
    }
  }
}

// The PTYs actually running under a subtree, in the order the panes appear.
function livePtyIds(root: SplitNode): number[] {
  const ids: number[] = [];
  for (const leaf of collectLeaves(root)) {
    if (leaf.pane.kind !== "terminal") continue;
    const instance = getTerminalInstance(leaf.id);
    if (instance && !instance.disposed && instance.ptyId !== null) {
      ids.push(instance.ptyId);
    }
  }
  return ids;
}

// What a torn-off pane's tab should be called in the window that receives it.
function paneTitle(leaf: SplitNode): string {
  if (leaf.type !== "leaf") return "Terminal";
  if (leaf.pane.kind === "terminal") {
    return getTerminalInstance(leaf.id)?.title || "Terminal";
  }
  return (
    leaf.pane.filePath.split(/[\\/]/).pop() ||
    (leaf.pane.kind === "markdown" ? "Markdown" : "Text")
  );
}

// Recursive tree operations (return new objects for immutability)
function splitPaneInTree(
  root: SplitNode,
  paneId: PaneId,
  direction: "h" | "v",
  newLeaf: SplitNode
): SplitNode {
  if (root.type === "leaf") {
    if (root.id === paneId) {
      return {
        type: "split",
        id: nanoid(8),
        direction,
        first: root,
        second: newLeaf,
        ratio: 0.5,
      };
    }
    return root;
  }
  return {
    ...root,
    first: splitPaneInTree(root.first, paneId, direction, newLeaf),
    second: splitPaneInTree(root.second, paneId, direction, newLeaf),
  };
}

function closePaneInTree(root: SplitNode, paneId: PaneId): SplitNode | null {
  if (root.type === "leaf") {
    return root.id === paneId ? null : root;
  }
  if (root.first.type === "leaf" && root.first.id === paneId) return root.second;
  if (root.second.type === "leaf" && root.second.id === paneId) return root.first;

  const newFirst = closePaneInTree(root.first, paneId);
  if (newFirst !== root.first) {
    return newFirst === null ? root.second : { ...root, first: newFirst };
  }
  const newSecond = closePaneInTree(root.second, paneId);
  if (newSecond !== root.second) {
    return newSecond === null ? root.first : { ...root, second: newSecond };
  }
  return root;
}

function resizeSplitInTree(
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
    first: resizeSplitInTree(root.first, splitId, ratio),
    second: resizeSplitInTree(root.second, splitId, ratio),
  };
}

// Batch variant: apply a new ratio to every split named in `ratios` in a single
// pass, so a snapped-divider drag moves all aligned splits atomically.
function resizeSplitsInTree(
  root: SplitNode,
  ratios: Map<string, number>
): SplitNode {
  if (root.type === "leaf") return root;
  const target = ratios.get(root.id);
  const ratio =
    target === undefined ? root.ratio : Math.max(0.1, Math.min(0.9, target));
  return {
    ...root,
    ratio,
    first: resizeSplitsInTree(root.first, ratios),
    second: resizeSplitsInTree(root.second, ratios),
  };
}

let titleDebounce: number | null = null;

export function useTabStore() {
  return {
    get state() {
      return state();
    },

    get activeTab(): Tab | undefined {
      return state().tabs.find((t) => t.id === state().activeTabId);
    },

    createTab() {
      // Same inheritance as a split: a new tab opens where the pane you were in
      // is. The active pane may be a markdown/text view with no shell, in which
      // case there's nothing to inherit and the startup path applies.
      const current = state().tabs.find((t) => t.id === state().activeTabId);
      const tab = createTerminalTab(
        current ? getTerminalCwd(current.activePaneId) : ""
      );
      update((s) => ({
        ...s,
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
        tabHistory: pushMru(s.tabHistory, s.activeTabId),
      }));
      return tab;
    },

    // Fill a freshly opened window, in the one place that knows what kind of
    // window it is. Three cases, in the order they win:
    //
    //   - a tear-off handed it a tab, so it rebuilds that and nothing else;
    //   - it owns the saved session (the first window of the launch), so it
    //     restores it — and, from here on, is the only one that writes it back;
    //   - anything else — a ⌘N window, a launch with nothing saved — opens one
    //     plain terminal. A second window restoring the same session would
    //     duplicate every tab and every shell in it.
    //
    // Idempotent: a renderer reload that finds tabs already there leaves them.
    initWindow(transfer: TransferTab | null, sessionOwner = false) {
      if (state().tabs.length > 0) return;

      if (transfer) {
        const tab = rebuildTab(transfer);
        update((s) => ({ ...s, tabs: [tab], activeTabId: tab.id }));
        return tab;
      }

      ownsSession = sessionOwner;
      const restored = sessionOwner ? restoredTabs() : null;
      if (restored) {
        update((s) => ({ ...s, ...restored }));
        return restored.tabs[0];
      }

      const tab = createTerminalTab();
      update((s) => ({ ...s, tabs: [tab], activeTabId: tab.id }));
      return tab;
    },

    // A tab another window tore off and dropped onto this one. It arrives active,
    // and the tab that *was* active goes on the focus history — so the
    // previous-tab shortcut takes you back where you were, exactly as it would
    // after opening a tab here.
    adoptTab(transfer: TransferTab) {
      const tab = rebuildTab(transfer);
      update((s) => ({
        ...s,
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
        // `|| null`: a window emptied by a tear-off has no active tab, and "" is
        // not an id anyone can come back to.
        tabHistory: pushMru(s.tabHistory, s.activeTabId || null),
      }));
      return tab;
    },

    // Hand a whole tab to another window.
    //
    // The PTYs are released *before* the snapshot is taken, and that order is
    // the point: from the release on, the host buffers their output instead of
    // sending it here, so everything printed up to that instant is in the
    // snapshot and everything after is in the buffer — nothing is lost, nothing
    // arrives twice. Then the terminals are dropped without killing the shells.
    //
    // Refuses on the window's only tab — that move would just rebuild this
    // window somewhere else and leave an empty one behind — unless `allowLast`
    // says the tab is going into a window that already exists. Merging a window
    // back into another one is the whole point of being able to do it: without
    // that exception a torn-off window, which holds exactly one tab, could never
    // be dragged home again.
    //
    // When the last tab does leave, this window is left with no tabs at all
    // rather than a replacement terminal: the caller closes the window, and
    // spawning a shell (running the user's rc files) to kill it a tick later is
    // exactly what that would be.
    async takeTab(
      tabId: TabId,
      opts: { allowLast?: boolean } = {}
    ): Promise<TransferTab | null> {
      const s = state();
      if (s.tabs.length <= 1 && !opts.allowLast) return null;
      const tab = s.tabs.find((t) => t.id === tabId);
      if (!tab) return null;

      await releasePty(livePtyIds(tab.root));
      const transfer = await serializeTab(tab);
      if (!transfer) return null;

      releasePanesInTree(tab.root);

      const current = state();
      const idx = current.tabs.findIndex((t) => t.id === tabId);
      if (idx === -1) return transfer; // closed under us mid-handover
      const remaining = current.tabs.filter((t) => t.id !== tabId);
      if (remaining.length === 0) {
        update(() => ({
          ...current,
          tabs: [],
          activeTabId: "",
          tabHistory: [],
        }));
        return transfer;
      }
      // The tab is gone from this window, so it comes out of the focus history
      // too — leaving it there would hand focus to a tab that now lives
      // somewhere else. Same fallback order as closeTab: most recent survivor
      // first, position only when nothing survives.
      //
      // It deliberately does NOT go on the reopen-closed stack: it wasn't
      // closed, it moved, and it is still open in another window. Offering to
      // "reopen" it would build a second copy with new shells.
      const alive = new Set(remaining.map((t) => t.id));
      const history = current.tabHistory.filter((id) => alive.has(id));
      const [recent, ...rest] = history;
      const wasActive = current.activeTabId === tabId;
      update(() => ({
        ...current,
        tabs: remaining,
        activeTabId: wasActive
          ? recent ?? remaining[Math.min(idx, remaining.length - 1)].id
          : current.activeTabId,
        tabHistory: wasActive && recent ? rest : history,
      }));
      return transfer;
    },

    // Hand a single pane to another window, where it lands as a one-pane tab.
    // Same release-then-serialize ordering as takeTab, and the same `allowLast`
    // exception: the window's last pane may leave when it is going into another
    // window, which then leaves this one empty for the caller to close.
    async takePane(
      paneId: PaneId,
      opts: { allowLast?: boolean } = {}
    ): Promise<TransferTab | null> {
      const s = state();
      const tab = s.tabs.find((t) => findLeafNode(t.root, paneId));
      if (!tab) return null;
      const leaf = findLeafNode(tab.root, paneId);
      if (!leaf) return null;
      if (s.tabs.length <= 1 && tab.root.type === "leaf" && !opts.allowLast) {
        return null;
      }

      await releasePty(livePtyIds(leaf));
      const transfer = await serializeLeaf(leaf, paneTitle(leaf));
      if (!transfer) return null;

      releasePanesInTree(leaf);

      const current = state();
      const idx = current.tabs.findIndex((t) => t.id === tab.id);
      if (idx === -1) return transfer; // closed under us mid-handover

      const pruned = closePane(current.tabs[idx].root, paneId);
      if (pruned === null) {
        // That was the tab's only pane — the tab goes with it, and out of the
        // focus history along with it. If it was also the window's only tab
        // (allowLast), the window is left empty for its caller to close.
        const remaining = current.tabs.filter((_, i) => i !== idx);
        const fallback = remaining.length
          ? remaining[Math.min(idx, remaining.length - 1)]
          : null;
        const alive = new Set(remaining.map((t) => t.id));
        update(() => ({
          ...current,
          tabs: remaining,
          activeTabId:
            current.activeTabId === tab.id
              ? (fallback?.id ?? "")
              : current.activeTabId,
          tabHistory: current.tabHistory.filter((id) => alive.has(id)),
        }));
        return transfer;
      }

      // reseatFocus prunes the pane out of this tab's focus history and, if it
      // held focus, hands it to the most recent pane still here — the same path
      // closing a pane takes, because from this window's side that is what
      // happened.
      update(() => ({
        ...current,
        tabs: current.tabs.map((t, i) =>
          i === idx ? reseatFocus(t, pruned, paneId) : t
        ),
      }));
      return transfer;
    },

    createMarkdownTab(filePath: string) {
      const leaf = createLeaf({ kind: "markdown", filePath });
      const tab: Tab = {
        id: nanoid(8),
        title: filePath.split("/").pop() || "Markdown",
        manualTitle: false,
        root: leaf,
        activePaneId: leaf.id,
        paneHistory: [],
      };
      update((s) => ({
        ...s,
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
        tabHistory: pushMru(s.tabHistory, s.activeTabId),
      }));
      return tab;
    },

    createTextTab(filePath: string) {
      const leaf = createLeaf({ kind: "text", filePath });
      const tab: Tab = {
        id: nanoid(8),
        title: filePath.split(/[\\/]/).pop() || "Text",
        manualTitle: false,
        root: leaf,
        activePaneId: leaf.id,
        paneHistory: [],
      };
      update((s) => ({
        ...s,
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
        tabHistory: pushMru(s.tabHistory, s.activeTabId),
      }));
      return tab;
    },

    closeTab(tabId: string) {
      const s = state();
      const idx = s.tabs.findIndex((t) => t.id === tabId);
      if (idx === -1) return;

      // Snapshot before the terminals die: the live working directory, the OSC
      // title and any recognized session all live on the registry instances that
      // killPanesInTree is about to dispose.
      recordClosedTab(snapshotTab(s.tabs[idx]), idx);

      killPanesInTree(s.tabs[idx].root);

      const newTabs = s.tabs.filter((t) => t.id !== tabId);
      if (newTabs.length === 0) {
        const tab = createTerminalTab();
        update(() => ({
          ...s,
          tabs: [tab],
          activeTabId: tab.id,
          tabHistory: [],
        }));
      } else {
        // Drop the closed tab from the history, then — if it was the active one
        // — fall back onto the most recent tab still open. Only when nothing
        // survives there does position decide, as it always used to.
        const alive = new Set(newTabs.map((t) => t.id));
        const history = s.tabHistory.filter((id) => alive.has(id));
        const [recent, ...rest] = history;
        const closingActive = s.activeTabId === tabId;
        update(() => ({
          ...s,
          tabs: newTabs,
          activeTabId: closingActive
            ? recent ?? newTabs[Math.min(idx, newTabs.length - 1)].id
            : s.activeTabId,
          tabHistory: closingActive && recent ? rest : history,
        }));
      }
    },

    // Reopen whatever was closed last — a tab or a single pane, whichever came
    // off more recently. Repeated calls walk back through the close order (the
    // browser's reopen-closed-tab, over one stack instead of two).
    //
    // Nothing here revives a process: the panes come back with the directory,
    // layout and titles they had, and their shells are new. A pane that was
    // running a recognized session comes back with the resume command queued —
    // typed, or run, per the Settings choice.
    reopenLastClosed() {
      const entry = popClosed();
      if (!entry) return;

      if (entry.kind === "tab") {
        const tab = hydrateTab(entry.snapshot, registerPendingRestore);
        update((s) => {
          const tabs = [...s.tabs];
          // Back where it was, unless the strip has since shrunk past that slot.
          tabs.splice(Math.min(entry.index, tabs.length), 0, tab);
          return {
            ...s,
            tabs,
            activeTabId: tab.id,
            tabHistory: pushMru(s.tabHistory, s.activeTabId),
          };
        });
        return tab.id;
      }

      const leaf = hydrateNode(entry.snapshot, registerPendingRestore);
      const s = state();
      const targetIdx = s.tabs.findIndex((t) => t.id === entry.tabId);

      // The tab it came from is gone (closed after the pane was). Rather than
      // drop the entry, the pane comes back as a tab of its own — the pane's
      // content is what the user asked for, and its old container isn't there
      // to hold it.
      if (targetIdx === -1) {
        const leaves = collectLeaves(leaf);
        const tab: Tab = {
          id: nanoid(8),
          title: entry.title,
          manualTitle: false,
          root: leaf,
          activePaneId: leaves[0]?.id ?? leaf.id,
          paneHistory: [],
        };
        update((prev) => ({
          ...prev,
          tabs: [...prev.tabs, tab],
          activeTabId: tab.id,
          tabHistory: pushMru(prev.tabHistory, prev.activeTabId),
        }));
        return tab.id;
      }

      const target = s.tabs[targetIdx];
      const newRoot = insertBeside(target.root, target.activePaneId, leaf, "right");
      const focusId = collectLeaves(leaf)[0]?.id ?? target.activePaneId;
      update((prev) => ({
        ...prev,
        tabs: prev.tabs.map((t, i) =>
          i === targetIdx ? focusPaneInTab({ ...t, root: newRoot }, focusId) : t
        ),
        activeTabId: target.id,
        tabHistory:
          prev.activeTabId === target.id
            ? prev.tabHistory
            : pushMru(prev.tabHistory, prev.activeTabId).filter(
                (id) => id !== target.id
              ),
      }));
      return target.id;
    },

    setActiveTab(tabId: string) {
      update((s) =>
        s.activeTabId === tabId
          ? s
          : {
              ...s,
              activeTabId: tabId,
              tabHistory: pushMru(s.tabHistory, s.activeTabId).filter(
                (id) => id !== tabId
              ),
            }
      );
    },

    splitActivePane(direction: "h" | "v", newPane: PaneType) {
      const s = state();
      const idx = s.tabs.findIndex((t) => t.id === s.activeTabId);
      if (idx === -1) return;

      const tab = s.tabs[idx];
      // Pre-build the new leaf so we know its id and can make it the active
      // pane — the freshly split terminal is where typing should land.
      // A new terminal inherits the directory of the pane being split, so a
      // split lands where you're working instead of back at the startup path.
      // Only when the source has no cwd to give (it's a markdown or text pane)
      // does the new terminal fall back to the configured startup path.
      const newLeaf = createLeaf(
        newPane.kind === "terminal" && !newPane.cwd
          ? { ...newPane, cwd: getTerminalCwd(tab.activePaneId) }
          : newPane
      );
      const newRoot = splitPaneInTree(tab.root, tab.activePaneId, direction, newLeaf);

      update(() => ({
        ...s,
        tabs: s.tabs.map((t, i) =>
          i === idx ? focusPaneInTab({ ...t, root: newRoot }, newLeaf.id) : t
        ),
      }));
      return newLeaf.id;
    },

    closePane(paneId: PaneId) {
      const s = state();
      const idx = s.tabs.findIndex((t) => t.id === s.activeTabId);
      if (idx === -1) return;

      const tab = s.tabs[idx];
      const leaf = findLeafNode(tab.root, paneId);
      const newRoot = closePaneInTree(tab.root, paneId);

      // Closing the last pane in a tab *is* closing the tab, and closeTab
      // records the whole thing. Recording the pane here too would put two
      // entries on the stack for one keystroke, so the tree is pruned before
      // anything is captured or destroyed.
      if (newRoot === null) {
        this.closeTab(tab.id);
        return;
      }

      // Capture before destroying, for the same reason as closeTab.
      if (leaf) {
        recordClosedPane(snapshotNode(leaf), tab.id, paneEntryTitle(leaf));
      }
      if (leaf?.pane.kind === "terminal") {
        destroyTerminal(paneId);
      }

      update(() => ({
        ...s,
        tabs: s.tabs.map((t, i) =>
          i === idx ? reseatFocus(t, newRoot, paneId) : t
        ),
      }));
    },

    setActivePaneId(paneId: PaneId) {
      const s = state();
      const idx = s.tabs.findIndex((t) => t.id === s.activeTabId);
      if (idx === -1) return;

      update(() => ({
        ...s,
        tabs: s.tabs.map((t, i) => (i === idx ? focusPaneInTab(t, paneId) : t)),
      }));
    },

    // Cycle the active pane within the current tab, in left-to-right /
    // Move focus to the pane visually adjacent to the active one in `dir`
    // (left/right/up/down). No-op when there's no neighbour that way, so
    // pressing into an outer edge simply keeps the current pane focused.
    focusDirectionalPane(dir: FocusDirection) {
      const s = state();
      const idx = s.tabs.findIndex((t) => t.id === s.activeTabId);
      if (idx === -1) return;

      const tab = s.tabs[idx];
      const nextId = findPaneInDirection(tab.root, tab.activePaneId, dir);
      if (!nextId || nextId === tab.activePaneId) return;

      update(() => ({
        ...s,
        tabs: s.tabs.map((t, i) => (i === idx ? focusPaneInTab(t, nextId) : t)),
      }));
    },

    resizeSplit(splitId: string, ratio: number) {
      const s = state();
      const idx = s.tabs.findIndex((t) => t.id === s.activeTabId);
      if (idx === -1) return;

      const newRoot = resizeSplitInTree(s.tabs[idx].root, splitId, ratio);

      update(() => ({
        ...s,
        tabs: s.tabs.map((t, i) =>
          i === idx ? { ...t, root: newRoot } : t
        ),
      }));
    },

    // Resize several splits at once — the snapped-divider drag path, where one
    // continuous line maps to multiple aligned splits that must move together.
    resizeSplits(entries: Array<{ splitId: string; ratio: number }>) {
      if (entries.length === 0) return;
      const s = state();
      const idx = s.tabs.findIndex((t) => t.id === s.activeTabId);
      if (idx === -1) return;

      const ratios = new Map(entries.map((e) => [e.splitId, e.ratio]));
      const newRoot = resizeSplitsInTree(s.tabs[idx].root, ratios);

      update(() => ({
        ...s,
        tabs: s.tabs.map((t, i) =>
          i === idx ? { ...t, root: newRoot } : t
        ),
      }));
    },

    movePane(
      sourceId: PaneId,
      targetId: PaneId,
      edge: DropEdge,
      atRoot = false
    ) {
      const s = state();
      const idx = s.tabs.findIndex((t) => t.id === s.activeTabId);
      if (idx === -1) return;

      const root = s.tabs[idx].root;
      const newRoot =
        atRoot && edge !== "center"
          ? moveLeafToRootEdge(root, sourceId, edge)
          : moveLeaf(root, sourceId, targetId, edge);
      if (newRoot === root) return;

      update(() => ({
        ...s,
        tabs: s.tabs.map((t, i) =>
          i === idx ? focusPaneInTab({ ...t, root: newRoot }, sourceId) : t
        ),
      }));
    },

    // Detach a pane from its tab and graft it into another one. The pane's leaf
    // keeps its id, so its live terminal (kept alive in the registry across the
    // remount — TerminalPane only detaches, never destroys, on unmount) rides
    // along intact. It lands split beside the target tab's active pane, becomes
    // that tab's active pane, and the target tab is brought to the front. If the
    // moved pane was the last one in its source tab, that now-empty tab is
    // dropped. No-op when source and target are the same tab.
    movePaneToTab(sourcePaneId: PaneId, targetTabId: TabId) {
      const s = state();
      const srcIdx = s.tabs.findIndex((t) => findLeafNode(t.root, sourcePaneId));
      const tgtIdx = s.tabs.findIndex((t) => t.id === targetTabId);
      if (srcIdx === -1 || tgtIdx === -1 || srcIdx === tgtIdx) return;

      const srcTab = s.tabs[srcIdx];
      const tgtTab = s.tabs[tgtIdx];
      const leaf = findLeafNode(srcTab.root, sourcePaneId);
      if (!leaf) return;

      const prunedSrc = closePane(srcTab.root, sourcePaneId);
      const newTgtRoot = insertBeside(
        tgtTab.root,
        tgtTab.activePaneId,
        leaf,
        "right"
      );

      let newTabs = s.tabs.map((t, i) => {
        if (i === tgtIdx) {
          return focusPaneInTab({ ...t, root: newTgtRoot }, sourcePaneId);
        }
        // The pane left this tab, so as far as the source tab is concerned it
        // was closed — same reseat, so the tab you detached *from* keeps focus
        // where you last were rather than snapping to its first pane.
        if (i === srcIdx && prunedSrc !== null) {
          return reseatFocus(t, prunedSrc, sourcePaneId);
        }
        return t;
      });
      // The source tab emptied out — its only pane just left. Drop it.
      if (prunedSrc === null) {
        newTabs = newTabs.filter((_, i) => i !== srcIdx);
      }

      const alive = new Set(newTabs.map((t) => t.id));
      update(() => ({
        ...s,
        tabs: newTabs,
        activeTabId: targetTabId,
        tabHistory: pushMru(s.tabHistory, s.activeTabId).filter(
          (id) => id !== targetTabId && alive.has(id)
        ),
      }));
    },

    // Pull a pane out of its split and give it a tab of its own — the gesture is
    // dropping it on the tab bar itself rather than on one of the chips in it.
    // Same mechanics as movePaneToTab: the leaf keeps its id, so the live
    // terminal rides along through the remount instead of being rebuilt.
    //
    // No-op for a pane that is already a whole tab: there is nothing to detach
    // it from, and the "move" would be the tab it is already in.
    movePaneToNewTab(sourcePaneId: PaneId) {
      const s = state();
      const srcIdx = s.tabs.findIndex((t) => findLeafNode(t.root, sourcePaneId));
      if (srcIdx === -1) return;

      const srcTab = s.tabs[srcIdx];
      const leaf = findLeafNode(srcTab.root, sourcePaneId);
      if (!leaf) return;

      const prunedSrc = closePane(srcTab.root, sourcePaneId);
      if (prunedSrc === null) return; // the pane *is* the tab

      const tab: Tab = {
        id: nanoid(8),
        title: paneTitle(leaf),
        manualTitle: false,
        root: leaf,
        activePaneId: sourcePaneId,
        paneHistory: [],
      };

      update(() => ({
        ...s,
        tabs: [
          ...s.tabs.map((t, i) =>
            i === srcIdx ? reseatFocus(t, prunedSrc, sourcePaneId) : t
          ),
          tab,
        ],
        activeTabId: tab.id,
        tabHistory: pushMru(s.tabHistory, s.activeTabId || null),
      }));
    },

    // Force the orientation of the split that directly contains `paneId`.
    setSplitDirectionForPane(paneId: PaneId, direction: "h" | "v") {
      const s = state();
      const idx = s.tabs.findIndex((t) => t.id === s.activeTabId);
      if (idx === -1) return;

      const parent = findParentSplit(s.tabs[idx].root, paneId);
      if (!parent || parent.direction === direction) return;

      const newRoot = setSplitDirection(s.tabs[idx].root, parent.id, direction);
      update(() => ({
        ...s,
        tabs: s.tabs.map((t, i) =>
          i === idx ? { ...t, root: newRoot } : t
        ),
      }));
    },

    toggleSplitDirection(splitId: string) {
      const s = state();
      const idx = s.tabs.findIndex((t) => t.id === s.activeTabId);
      if (idx === -1) return;

      const newRoot = toggleSplitDirection(s.tabs[idx].root, splitId);
      update(() => ({
        ...s,
        tabs: s.tabs.map((t, i) =>
          i === idx ? { ...t, root: newRoot } : t
        ),
      }));
    },

    updateTabTitle(tabId: string, title: string) {
      if (titleDebounce) clearTimeout(titleDebounce);
      titleDebounce = window.setTimeout(() => {
        const s = state();
        const tab = s.tabs.find((t) => t.id === tabId);
        // A manually renamed tab is locked against shell-driven OSC titles
        // (tmux rename-window behavior) until the user clears the rename.
        if (!tab || tab.manualTitle) return;
        update(() => ({
          ...s,
          tabs: s.tabs.map((t) =>
            t.id === tabId ? { ...t, title } : t
          ),
        }));
      }, 100);
    },

    // Open the inline rename editor for a tab (defaults to the active tab —
    // e.g. from the ⌘R / Ctrl+Shift+R shortcut).
    startRenameTab(tabId?: string) {
      const id = tabId ?? state().activeTabId;
      if (!id) return;
      update((s) => ({ ...s, renamingTabId: id }));
    },

    // Commit the rename editor's value. An empty (trimmed) value reverts the
    // tab to automatic titling — unlocking it and pulling back whatever OSC
    // title the shell last reported, so the tab bar doesn't go blank.
    commitRenameTab(tabId: string, title: string) {
      const s = state();
      const trimmed = title.trim();
      if (!trimmed) {
        const tab = s.tabs.find((t) => t.id === tabId);
        const autoTitle =
          (tab && getTerminalInstance(tab.activePaneId)?.title) || "Terminal";
        update(() => ({
          ...s,
          renamingTabId: null,
          tabs: s.tabs.map((t) =>
            t.id === tabId ? { ...t, title: autoTitle, manualTitle: false } : t
          ),
        }));
        return;
      }
      update(() => ({
        ...s,
        renamingTabId: null,
        tabs: s.tabs.map((t) =>
          t.id === tabId ? { ...t, title: trimmed, manualTitle: true } : t
        ),
      }));
    },

    cancelRenameTab() {
      update((s) => (s.renamingTabId === null ? s : { ...s, renamingTabId: null }));
    },

    // Reorder tabs by dragging `sourceId` to just before/after `targetId`.
    moveTab(sourceId: TabId, targetId: TabId, before: boolean) {
      if (sourceId === targetId) return;
      const s = state();
      const tabs = [...s.tabs];
      const srcIdx = tabs.findIndex((t) => t.id === sourceId);
      if (srcIdx === -1) return;
      const [moved] = tabs.splice(srcIdx, 1);
      const targetIdx = tabs.findIndex((t) => t.id === targetId);
      if (targetIdx === -1) return;
      tabs.splice(before ? targetIdx : targetIdx + 1, 0, moved);
      update(() => ({ ...s, tabs }));
    },

    // The sidebar slot holds exactly one view at a time. Showing a view evicts
    // whatever was there, so "settings is open" and "the file tree is open" can
    // never both be true — the invariant lives here, not in the callers.
    showSidebar(view: SidebarView) {
      update((s) => (s.sidebarView === view ? s : { ...s, sidebarView: view }));
    },

    closeSidebar() {
      update((s) => (s.sidebarView === null ? s : { ...s, sidebarView: null }));
    },

    // Show `view`, or close the sidebar if it's already the one showing.
    toggleSidebarView(view: SidebarView) {
      update((s) => ({
        ...s,
        sidebarView: s.sidebarView === view ? null : view,
      }));
    },
  };
}
