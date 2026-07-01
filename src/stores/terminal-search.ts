import { createSignal } from "solid-js";

// Which pane currently shows the in-terminal find bar (⌘F / Ctrl+Shift+F).
// At most one search is open at a time; null means closed. The bar itself
// lives inside that pane and drives the pane's xterm SearchAddon.
export const [searchPaneId, setSearchPaneId] = createSignal<string | null>(null);

export function openSearch(paneId: string) {
  setSearchPaneId(paneId);
}

export function closeSearch() {
  setSearchPaneId(null);
}
