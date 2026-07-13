import type { Terminal } from "@xterm/xterm";

// Selecting text in a pane whose program has grabbed the mouse.
//
// Full-screen programs — Claude Code, vim, htop, lazygit — turn on mouse
// tracking (DECSET ?1000/?1002/?1003 + ?1006). xterm.js then hands every button
// press to the program and *disables its own selection*, because the drag now
// belongs to the app. That's what every terminal does, and it's why you can't
// copy from a pane running Claude: the drag never becomes a selection, so there
// is nothing for ⌘C / Ctrl+Shift+C to read. The conventional escape hatch is to
// hold Shift, which xterm honours via `shouldForceSelection` — but you have to
// know it exists.
//
// So distinguish the two intents instead of making the user encode them:
//
//   press, release without moving   → a click. Forward it; the program reacts.
//   press, move past DRAG_THRESHOLD → a selection. Keep it local.
//
// A press is therefore held back until it's clear which one it is. Once we know:
//
//   click     — replay the original press (and its release) so the program sees
//               a normal, ordinary click.
//   selection — replay the press with `shiftKey` forced on. That's xterm's own
//               public trigger for "select even though the app owns the mouse":
//               its selection service starts tracking, and its mouse-report
//               handler skips the event. From there xterm's own document-level
//               listeners extend the selection as the pointer moves, so the rest
//               of the drag needs no help from us.
//
// Hold Shift yourself and none of this runs — the event is already what xterm
// wants. Same for Alt (column select). Motion reporting is untouched, so hover
// highlighting still works, and the wheel is a separate event we never see.

// How far the pointer must travel before a press counts as a drag rather than a
// click. Matches the browser's own drag threshold; below it, a press-release is
// a click even if the hand wobbles.
const DRAG_THRESHOLD_PX = 3;

// Marks the events we re-dispatch, so our own capture-phase listener ignores
// them instead of intercepting its own replay.
const REPLAYED = Symbol("specterm.replayed");

type ReplayableMouseEvent = MouseEvent & { [REPLAYED]?: true };

function replay(target: EventTarget, source: MouseEvent, forceShift: boolean) {
  const event: ReplayableMouseEvent = new MouseEvent(source.type, {
    bubbles: true,
    cancelable: true,
    view: window,
    detail: source.detail,
    screenX: source.screenX,
    screenY: source.screenY,
    clientX: source.clientX,
    clientY: source.clientY,
    button: source.button,
    buttons: source.buttons,
    ctrlKey: source.ctrlKey,
    altKey: source.altKey,
    metaKey: source.metaKey,
    shiftKey: forceShift || source.shiftKey,
  });
  event[REPLAYED] = true;
  target.dispatchEvent(event);
}

/**
 * Let a plain drag select text in `term` even while the program running in it
 * has taken over the mouse; a plain click still reaches the program. Returns a
 * teardown function.
 */
export function installClickVsDragSelection(
  term: Terminal,
  container: HTMLElement
): () => void {
  // Pending press: captured, not yet classified as click or drag.
  let pending: MouseEvent | null = null;
  let target: EventTarget | null = null;

  // True while the program running in the pane is reading the mouse. xterm
  // mirrors its own DEC modes here, so this is exactly the condition under
  // which it disables selection.
  const appOwnsMouse = () => term.modes.mouseTrackingMode !== "none";

  function onMouseDown(e: MouseEvent) {
    if ((e as ReplayableMouseEvent)[REPLAYED]) return; // our own replay
    if (e.button !== 0) return; // left button only; right-click keeps its menu
    if (!appOwnsMouse()) return; // xterm already selects on drag — leave it be
    if (e.shiftKey || e.altKey) return; // the user asked for xterm's own handling

    // Hold the press back until the gesture reveals itself.
    e.preventDefault();
    e.stopPropagation();
    pending = e;
    target = e.target;
  }

  function onMouseMove(e: MouseEvent) {
    if (!pending) return;
    const moved = Math.hypot(
      e.clientX - pending.clientX,
      e.clientY - pending.clientY
    );
    if (moved < DRAG_THRESHOLD_PX) return;

    // A drag. Replay the press as a Shift-press so xterm selects locally and
    // reports nothing to the program; its own listeners drive the rest.
    const press = pending;
    const on = target;
    pending = null;
    target = null;
    if (on) replay(on, press, true);
  }

  function onMouseUp(e: MouseEvent) {
    if ((e as ReplayableMouseEvent)[REPLAYED]) return;
    if (!pending) return;
    // Released without travelling: a click. Swallow the real release and replay
    // the pair in order, so the program sees exactly one press and one release
    // (letting the real one through as well would report the release twice —
    // xterm starts listening for it the moment it sees our replayed press).
    e.preventDefault();
    e.stopPropagation();
    const press = pending;
    const on = target;
    pending = null;
    target = null;
    if (!on) return;
    // Clicking dismisses the previous selection, as it does in any terminal.
    // xterm won't do it for us here: its selection service is disabled while the
    // program owns the mouse, so it ignores the press entirely.
    term.clearSelection();
    replay(on, press, false);
    replay(on, e, false);
  }

  // Capture on the pane container: these run before xterm's listeners, which
  // sit on the .xterm element inside it. Move/up go on the window so a drag
  // that leaves the pane is still classified.
  container.addEventListener("mousedown", onMouseDown, true);
  window.addEventListener("mousemove", onMouseMove, true);
  window.addEventListener("mouseup", onMouseUp, true);

  return () => {
    container.removeEventListener("mousedown", onMouseDown, true);
    window.removeEventListener("mousemove", onMouseMove, true);
    window.removeEventListener("mouseup", onMouseUp, true);
  };
}
