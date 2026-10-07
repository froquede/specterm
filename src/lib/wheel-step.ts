// The wheel as a stepper: over the tab strip it moves between tabs, and with
// Shift over the panes it moves between panes. Both read one gesture the same
// way, so they share it.

// Cooldown after a wheel-driven step. A trackpad swipe fires dozens of small
// wheel events for one gesture; without this, one swipe would flip through
// half the tabs (or panes) instead of moving one at a time, the way a mouse
// wheel's notches do. Momentum that outlasts it can still step again.
export const WHEEL_STEP_COOLDOWN_MS = 220;

// The axis that moved. macOS turns a mouse's Shift+wheel into a horizontal
// scroll, and a trackpad can swipe either way, so whichever is larger counts.
export function wheelDelta(e: WheelEvent): number {
  return Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
}
