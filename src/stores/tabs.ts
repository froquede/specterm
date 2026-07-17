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
import { destroyTerminal, getTerminalInstance } from "../lib/terminal-registry";

function createTerminalTab(): Tab {
  const leaf = createLeaf({ kind: "terminal", ptyId: null, cwd: "" });
  return {
    id: nanoid(8),
    title: "Terminal",
    manualTitle: false,
    root: leaf,
    activePaneId: leaf.id,
  };
}

const initialTab = createTerminalTab();

// Use createSignal instead of createStore for full object replacement
const [state, setStateRaw] = createSignal<AppState>({
  tabs: [initialTab],
  activeTabId: initialTab.id,
  sidebarView: "files",
  renamingTabId: null,
});

function update(fn: (s: AppState) => AppState) {
  setStateRaw(fn(state()));
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
      const tab = createTerminalTab();
      update((s) => ({
        ...s,
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
      }));
      return tab;
    },

    createMarkdownTab(filePath: string) {
      const leaf = createLeaf({ kind: "markdown", filePath });
      const tab: Tab = {
        id: nanoid(8),
        title: filePath.split("/").pop() || "Markdown",
        manualTitle: false,
        root: leaf,
        activePaneId: leaf.id,
      };
      update((s) => ({
        ...s,
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
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
      };
      update((s) => ({
        ...s,
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
      }));
      return tab;
    },

    closeTab(tabId: string) {
      const s = state();
      const idx = s.tabs.findIndex((t) => t.id === tabId);
      if (idx === -1) return;

      killPanesInTree(s.tabs[idx].root);

      const newTabs = s.tabs.filter((t) => t.id !== tabId);
      if (newTabs.length === 0) {
        const tab = createTerminalTab();
        update(() => ({
          ...s,
          tabs: [tab],
          activeTabId: tab.id,
        }));
      } else {
        const newActiveId =
          s.activeTabId === tabId
            ? newTabs[Math.min(idx, newTabs.length - 1)].id
            : s.activeTabId;
        update(() => ({
          ...s,
          tabs: newTabs,
          activeTabId: newActiveId,
        }));
      }
    },

    setActiveTab(tabId: string) {
      update((s) => ({ ...s, activeTabId: tabId }));
    },

    splitActivePane(direction: "h" | "v", newPane: PaneType) {
      const s = state();
      const idx = s.tabs.findIndex((t) => t.id === s.activeTabId);
      if (idx === -1) return;

      const tab = s.tabs[idx];
      // Pre-build the new leaf so we know its id and can make it the active
      // pane — the freshly split terminal is where typing should land.
      const newLeaf = createLeaf(newPane);
      const newRoot = splitPaneInTree(tab.root, tab.activePaneId, direction, newLeaf);

      update(() => ({
        ...s,
        tabs: s.tabs.map((t, i) =>
          i === idx ? { ...t, root: newRoot, activePaneId: newLeaf.id } : t
        ),
      }));
      return newLeaf.id;
    },

    closePane(paneId: PaneId) {
      const s = state();
      const idx = s.tabs.findIndex((t) => t.id === s.activeTabId);
      if (idx === -1) return;

      const tab = s.tabs[idx];
      const pane = collectLeaves(tab.root).find((l) => l.id === paneId);
      if (pane?.pane.kind === "terminal") {
        destroyTerminal(paneId);
      }

      const newRoot = closePaneInTree(tab.root, paneId);
      if (newRoot === null) {
        this.closeTab(tab.id);
        return;
      }

      const newActivePaneId =
        tab.activePaneId === paneId ? firstLeafId(newRoot) : tab.activePaneId;

      update(() => ({
        ...s,
        tabs: s.tabs.map((t, i) =>
          i === idx
            ? { ...t, root: newRoot, activePaneId: newActivePaneId }
            : t
        ),
      }));
    },

    setActivePaneId(paneId: PaneId) {
      const s = state();
      const idx = s.tabs.findIndex((t) => t.id === s.activeTabId);
      if (idx === -1) return;

      update(() => ({
        ...s,
        tabs: s.tabs.map((t, i) =>
          i === idx ? { ...t, activePaneId: paneId } : t
        ),
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
        tabs: s.tabs.map((t, i) =>
          i === idx ? { ...t, activePaneId: nextId } : t
        ),
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
          i === idx
            ? { ...t, root: newRoot, activePaneId: sourceId }
            : t
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
          return { ...t, root: newTgtRoot, activePaneId: sourcePaneId };
        }
        if (i === srcIdx && prunedSrc !== null) {
          return {
            ...t,
            root: prunedSrc,
            activePaneId:
              t.activePaneId === sourcePaneId
                ? firstLeafId(prunedSrc)
                : t.activePaneId,
          };
        }
        return t;
      });
      // The source tab emptied out — its only pane just left. Drop it.
      if (prunedSrc === null) {
        newTabs = newTabs.filter((_, i) => i !== srcIdx);
      }

      update(() => ({ ...s, tabs: newTabs, activeTabId: targetTabId }));
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
