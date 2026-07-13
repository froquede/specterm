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

  // The view currently in the sidebar slot may hold a floor of its own — the
  // settings panel does, because its controls stop being usable below it. Clamp
  // the drag to that floor so the stored width never outruns what's on screen
  // (otherwise the strip keeps "moving" while the sidebar visibly doesn't).
  function renderedFloor(handle: HTMLElement): number {
    const sidebar = handle.previousElementSibling;
    if (!(sidebar instanceof HTMLElement)) return 0;
    return parseFloat(getComputedStyle(sidebar).minWidth) || 0;
  }

  function onPointerMove(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    if (!el.hasPointerCapture(e.pointerId)) return;
    const width = startWidth + (e.clientX - startX);
    setSidebarWidth(Math.max(renderedFloor(el), width));
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
