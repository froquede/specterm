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

// What currently occupies the single sidebar slot in .app-body. The file tree
// and the settings panel are mutually exclusive by construction — one field,
// not two booleans to keep in sync.
export type SidebarView = "files" | "settings";

export interface AppState {
  tabs: Tab[];
  activeTabId: TabId;
  sidebarView: SidebarView | null; // null = sidebar closed
  sidebarWidth: number;
}
