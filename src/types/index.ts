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
  // Panes focused before `activePaneId`, most recent first, excluding it.
  // Closing the active pane hands focus to the first entry here that's still
  // alive, so you land back where you came from instead of at the tree's
  // first leaf. Pruned on close and capped — see FOCUS_HISTORY_LIMIT.
  paneHistory: PaneId[];
}

// What currently occupies the single sidebar slot in .app-body. The file tree
// and the settings panel are mutually exclusive by construction — one field,
// not two booleans to keep in sync.
export type SidebarView = "files" | "settings";

export interface AppState {
  tabs: Tab[];
  activeTabId: TabId;
  // The tab-level twin of Tab.paneHistory: tabs visited before `activeTabId`,
  // most recent first. Closing the active tab returns to the last one you were
  // actually on, rather than to whichever tab inherits its index.
  tabHistory: TabId[];
  sidebarView: SidebarView | null; // null = sidebar closed
  renamingTabId: TabId | null; // tab whose title is currently being edited inline
}
