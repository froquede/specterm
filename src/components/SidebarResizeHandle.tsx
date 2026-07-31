import { onCleanup } from "solid-js";
import {
  sidebarWidth,
  setSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
} from "../stores/settings";

// The grab strip between the sidebar and the panes. Dragging it writes straight
// through to the persisted `sidebarWidth`, which the stylesheet reads as
// --sidebar-width — so the sidebar and the panes both follow the pointer, and
// the width survives a restart. Double-click restores the default.
//
// Pointer capture (rather than window listeners) keeps the drag alive when the
// pointer outruns the strip or leaves the window mid-drag.
export default function SidebarResizeHandle() {
  let startX = 0;
  let startWidth = 0;

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    startX = e.clientX;
    startWidth = sidebarWidth();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    el.classList.add("dragging");
    document.body.classList.add("resizing-sidebar");
  }

  // No per-view floor to respect any more: the settings panel used to refuse to
  // go below 340px, which meant the strip kept "moving" while the sidebar
  // visibly didn't, and switching views at a narrower width shoved the panes
  // sideways and back. Both views now take the one width, and the only clamp is
  // the store's own (SIDEBAR_WIDTH_MIN/MAX).
  function onPointerMove(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    if (!el.hasPointerCapture(e.pointerId)) return;
    setSidebarWidth(startWidth + (e.clientX - startX));
  }

  function endDrag(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    if (!el.hasPointerCapture(e.pointerId)) return;
    el.releasePointerCapture(e.pointerId);
    el.classList.remove("dragging");
    document.body.classList.remove("resizing-sidebar");
  }

  onCleanup(() => document.body.classList.remove("resizing-sidebar"));

  return (
    <div
      class="sidebar-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDblClick={() => setSidebarWidth(SIDEBAR_WIDTH_DEFAULT)}
    />
  );
}
