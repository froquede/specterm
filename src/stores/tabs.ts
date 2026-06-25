import { createSignal } from "solid-js";
import { nanoid } from "nanoid";
import type { AppState, Tab, PaneType, PaneId, SplitNode } from "../types";
import {
  createLeaf,
  collectLeaves,
  firstLeafId,
  moveLeaf,
  findParentSplit,
  setSplitDirection,
  toggleSplitDirection,
  type DropEdge,
} from "../lib/split-tree";
import { destroyTerminal } from "../lib/terminal-registry";

function createTerminalTab(): Tab {
  const leaf = createLeaf({ kind: "terminal", ptyId: null, cwd: "" });
  return {
    id: nanoid(8),
    title: "Terminal",
    root: leaf,
    activePaneId: leaf.id,
  };
}

const initialTab = createTerminalTab();

// Use createSignal instead of createStore for full object replacement
const [state, setStateRaw] = createSignal<AppState>({
  tabs: [initialTab],
  activeTabId: initialTab.id,
  sidebarOpen: true,
  sidebarWidth: 250,
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
  newPane: PaneType
): SplitNode {
  if (root.type === "leaf") {
    if (root.id === paneId) {
      return {
        type: "split",
        id: nanoid(8),
        direction,
        first: root,
        second: createLeaf(newPane),
        ratio: 0.5,
      };
    }
    return root;
  }
  return {
    ...root,
    first: splitPaneInTree(root.first, paneId, direction, newPane),
    second: splitPaneInTree(root.second, paneId, direction, newPane),
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
      const before = new Set(collectLeaves(tab.root).map((l) => l.id));
      const newRoot = splitPaneInTree(tab.root, tab.activePaneId, direction, newPane);
      // Focus the freshly created pane so typing lands there (focus = opacity 1).
      const newLeaf = collectLeaves(newRoot).find((l) => !before.has(l.id));

      update(() => ({
        ...s,
        tabs: s.tabs.map((t, i) =>
          i === idx
            ? { ...t, root: newRoot, activePaneId: newLeaf?.id ?? t.activePaneId }
            : t
        ),
      }));
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

    movePane(sourceId: PaneId, targetId: PaneId, edge: DropEdge) {
      const s = state();
      const idx = s.tabs.findIndex((t) => t.id === s.activeTabId);
      if (idx === -1) return;

      const newRoot = moveLeaf(s.tabs[idx].root, sourceId, targetId, edge);
      if (newRoot === s.tabs[idx].root) return;

      update(() => ({
        ...s,
        tabs: s.tabs.map((t, i) =>
          i === idx
            ? { ...t, root: newRoot, activePaneId: sourceId }
            : t
        ),
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
        update(() => ({
          ...s,
          tabs: s.tabs.map((t) =>
            t.id === tabId ? { ...t, title } : t
          ),
        }));
      }, 100);
    },

    toggleSidebar() {
      update((s) => ({ ...s, sidebarOpen: !s.sidebarOpen }));
    },

    openSidebar() {
      update((s) => (s.sidebarOpen ? s : { ...s, sidebarOpen: true }));
    },
  };
}
