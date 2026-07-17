import { createSignal } from "solid-js";

// Shared state for pointer-driven tab drag-and-reorder (see
// src/stores/pane-drag.ts for the pane equivalent). Tabs are a flat list, so
// there's no split-tree edge math here — just "insert before/after this
// other tab".

export const [draggingTabId, setDraggingTabId] = createSignal<string | null>(
  null
);
export const [tabDropTarget, setTabDropTarget] = createSignal<{
  tabId: string;
  before: boolean;
} | null>(null);
