import { createSignal } from "solid-js";
import { getBackend } from "../backends";

// A tab or pane drag that has wandered outside this window. Releasing there
// hands the tab off to whatever is under the cursor — another Specterm window,
// or, if there is none, a new window of its own.
//
// Only the *visual* state lives here. Where the drop actually landed is decided
// by the host from the real cursor position, because a drag that leaves the
// window may stop delivering pointer events to it altogether. See the
// "drop-transfer" handler in electron/main.cjs.
export const [tearingOff, setTearingOff] = createSignal(false);

// The other half of that: a drag happening in *another* window is currently over
// this one, so releasing there drops a tab in here. This window sees no pointer
// events for it — the gesture belongs to the window it started in — so the host
// tells us instead. See onDragOver, wired up in App.
export const [dragOver, setDragOver] = createSignal(false);

// Whether a pointer position falls outside this window. The app fills the window
// edge to edge, so the viewport is the window.
export function isOutsideWindow(e: { clientX: number; clientY: number }) {
  return (
    e.clientX < 0 ||
    e.clientY < 0 ||
    e.clientX > window.innerWidth ||
    e.clientY > window.innerHeight
  );
}

// Pointermove fires far more often than a window highlight can change, and each
// ping costs the host a cursor read and a bounds scan. One every other frame is
// well past the point where the highlight looks instant.
const PING_INTERVAL_MS = 32;

// Keep pinging even while the pointer sits still. The host puts the highlight
// out when the pings stop — that is how it survives a source window that dies
// mid-drag — so a drag held motionless over another window has to keep saying
// it's still there, or the target would go dark under a live drag. Well inside
// the host's idle timeout (DRAG_IDLE_MS in electron/main.cjs).
const HEARTBEAT_MS = 250;

let lastPing = 0;
// The running heartbeat, and with it the answer to "has the host heard about
// this drag at all" — a gesture that never left the window must not send an end
// for a drag nobody was told about.
let heartbeat: number | undefined;

function pingDragHover() {
  const now = performance.now();
  if (heartbeat !== undefined && now - lastPing < PING_INTERVAL_MS) return;
  lastPing = now;
  void getBackend().then((backend) => backend.dragHover());
  heartbeat ??= window.setInterval(pingDragHover, HEARTBEAT_MS);
}

/**
 * Track a drag against the window's edge: sets `tearingOff`, and keeps the host
 * (and through it, the window under the cursor) informed. Returns whether the
 * pointer is currently outside. Call on every pointermove of a tab/pane drag.
 */
export function trackTearOff(e: { clientX: number; clientY: number }): boolean {
  const outside = isOutsideWindow(e);
  setTearingOff(outside);
  if (outside) pingDragHover();
  else endTearOff();
  return outside;
}

/** The drag ended — dropped, cancelled, or came back inside. */
export function endTearOff() {
  setTearingOff(false);
  if (heartbeat === undefined) return;
  clearInterval(heartbeat);
  heartbeat = undefined;
  void getBackend().then((backend) => backend.dragEnd());
}
