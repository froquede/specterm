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

// --- History snapshots -----------------------------------------------------
// The frozen twin of the live shapes above: what a tab looked like, with the
// runtime bindings (pty ids, pane ids, focus history) stripped out. See
// lib/session-snapshot.ts for why each one goes, and stores/history.ts for the
// two things these feed: the reopen-closed-tab stack and the restore-on-boot
// snapshot.

// A resumable process that was running in a pane. Captured generically so the
// history doesn't know what Claude Code is: a provider (lib/session-providers/)
// recognizes the process and hands back these three fields, and the restore path
// only ever deals with `resumeCommand`.
export interface SessionMeta {
  provider: string; // which provider recognized it, e.g. "claude"
  id: string; // the provider's own session identifier
  resumeCommand: string; // what to type/run to pick the session back up
  // True when the id came from the running process itself rather than from a
  // guess about it. Providers often have both routes (see session-providers/
  // claude.ts); this stops a later heuristic answer from overwriting an exact
  // one, and stops the exact route from being re-run once it has succeeded.
  exact?: boolean;
}

export type SnapshotPane =
  | {
      kind: "terminal";
      cwd: string;
      title?: string;
      session?: SessionMeta;
      // Where to find this pane's screen in the screen store (lib/session-
      // screens.ts). It's the live pane id at capture time — stable for a pane's
      // whole life, so the layout snapshot can be rewritten on every store change
      // while the screens themselves are only written when the window closes, and
      // the two still line up. Absent for a pane whose screen wasn't kept: a
      // snapshot older than this field, one that never mounted, or one dropped to
      // stay inside the storage budget.
      screenKey?: string;
    }
  | { kind: "markdown"; filePath: string }
  | { kind: "text"; filePath: string };

export type SnapshotNode =
  | { type: "leaf"; pane: SnapshotPane }
  | {
      type: "split";
      direction: "h" | "v";
      first: SnapshotNode;
      second: SnapshotNode;
      ratio: number;
    };

export interface TabSnapshot {
  title: string;
  manualTitle: boolean;
  root: SnapshotNode;
  // Which leaf was focused, by position in `collectLeaves` order — ids don't
  // survive the round trip, positions do.
  activePaneIndex: number;
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
