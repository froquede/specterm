import type { SidebarView } from "../types";

// Which sidebar you had open, remembered across launches.
//
// The width already persisted (it is a setting, in stores/settings); whether the
// sidebar was open at all, and which of its two views was showing, did not — so
// every launch opened the file tree whether or not that was where you left it.
//
// It lives here rather than in stores/settings for one reason: settings are
// mirrored into every open window (see lib/store-sync), and this must not be.
// Opening the settings panel in one window would slam the file tree shut in the
// other, which is not a preference being applied, it's a window reaching into
// another one. So this is its own key, written by whichever window changed it
// last, and read only at boot.

const STORAGE_KEY = "specterm.sidebar";

const VALID: readonly (SidebarView | null)[] = ["files", "settings", null];

/** What the sidebar should show on this window's first paint. */
export function loadSidebarView(): SidebarView | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return "files"; // first run: the file tree, as before
    const parsed = JSON.parse(raw) as { view?: unknown };
    const view = parsed?.view === undefined ? "files" : parsed.view;
    return VALID.includes(view as SidebarView | null)
      ? (view as SidebarView | null)
      : "files";
  } catch (_) {
    // Unreadable or corrupt — open the file tree, which is what a fresh profile
    // does. Never worth failing a launch over.
    return "files";
  }
}

export function saveSidebarView(view: SidebarView | null): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ view }));
  } catch (_) {
    /* Storage full or unavailable — the sidebar still works, it just forgets. */
  }
}
