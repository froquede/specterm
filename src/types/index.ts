export type PaneId = string;
export type TabId = string;

export type PaneType =
  | { kind: "terminal"; ptyId: number | null; cwd: string }
  | { kind: "markdown"; filePath: string };

export type SplitNode =
  | { type: "leaf"; id: PaneId; pane: PaneType }
  | {
      type: "split";
      id: string;
      direction: "h" | "v";
      first: SplitNode;
      second: SplitNode;
      ratio: number;
    };

export interface Tab {
  id: TabId;
  title: string;
  root: SplitNode;
  activePaneId: PaneId;
}

export interface AppState {
  tabs: Tab[];
  activeTabId: TabId;
  sidebarOpen: boolean;
  sidebarWidth: number;
}
