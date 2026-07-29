import { createSignal } from "solid-js";

// A tab or pane drag that has wandered outside this window. Releasing there
// hands the tab off to whatever is under the cursor — another Specterm window,
// or, if there is none, a new window of its own.
//
// Only the *visual* state lives here. Where the drop actually landed is decided
// by the host from the real cursor position, because a drag that leaves the
// window may stop delivering pointer events to it altogether. See the
// "drop-transfer" handler in electron/main.cjs.
export const [tearingOff, setTearingOff] = createSignal(false);

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
