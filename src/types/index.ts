export type PaneId = string;
export type TabId = string;

export type PaneType =
  | { kind: "terminal"; ptyId: number | null; cwd: string }
  | { kind: "markdown"; filePath: string }
  // A read-only viewer for any non-markdown text file (source, config,
  // extensionless files like Dockerfile). Syntax-highlighted; see TextPane.
  | { kind: "text"; filePath: string };

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
  // True once the user has renamed the tab manually (tmux rename-window
  // behavior): freezes `title` against further shell-driven OSC updates until
  // the user clears the rename field.
  manualTitle: boolean;
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
  renamingTabId: TabId | null; // tab whose title is currently being edited inline
}
