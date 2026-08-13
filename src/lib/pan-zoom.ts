// The pan/zoom viewport, in every place the app lets you push a picture around.
//
// It started inside lib/mermaid.ts, because diagrams were the only thing that
// needed it — the markdown preview and the terminal diagram overlay share one
// implementation there. The image viewer wants exactly the same gesture
// vocabulary, and the worst thing a second viewer could do is invent a second
// one: two panes in the same window that answer the same wheel differently.
// So the machinery moved here and mermaid imports it, unchanged in behaviour.
//
// The vocabulary, one place to read it:
//   - **wheel** zooms, toward the pointer.
//   - **left-drag** pans.
//   - **double-click** goes back to where you started.
//
// Nothing is bound to a key. `⌘=` / `⌘-` / `⌘0` already belong to the terminal
// font size, app-wide, and a viewer that quietly stole them while it happened
// to be focused would be a worse surprise than not having them.

export interface PanZoomOptions {
  /** How far out you can go. Default 0.2. */
  minScale?: number;
  /** How far in you can go. Default 5. */
  maxScale?: number;
  /** Called whenever the scale changes — for a readout in a toolbar. */
  onScaleChange?: (scale: number) => void;
}

export interface PanZoom {
  /** Remove every listener, including any a drag left armed. */
  dispose(): void;
  /** Multiply the current scale, anchored on the middle of the viewport. */
  zoomBy(factor: number): void;
  /** Go to an absolute scale, anchored on the middle of the viewport. */
  zoomTo(scale: number): void;
  /** Scale 1, no pan — the state the content was handed over in. */
  reset(): void;
  /** The current scale. */
  scale(): number;
}

// Wheel deltas are not comparable between devices, so the factor is exponential
// in the delta rather than a fixed step per event. A mouse notch is one event of
// ±120 device pixels, which these constants deliberately keep at the ±10% step
// the viewport has always used (e^(120 × 0.0008) ≈ 1.1). A trackpad sends a
// stream of small deltas instead, and gets a smooth ramp out of the same
// formula rather than a 10% jump per twitch.
const WHEEL_INTENSITY = 0.0008;
// A pinch arrives as ctrl+wheel with much smaller deltas, so it needs its own
// constant or a two-finger pinch would barely move.
const PINCH_INTENSITY = 0.01;
// Some devices (and every "scroll by page" mode) can deliver one enormous
// delta. Clamping the *factor* keeps a single event from swallowing the whole
// zoom range, without capping how fast a real gesture can go.
const MAX_STEP = 2;

const LINE_HEIGHT_PX = 16;
const PAGE_HEIGHT_PX = 400;

/**
 * Make `inner` draggable and zoomable inside `wrapper`.
 *
 * `inner` is the element that carries the transform; `wrapper` is the box that
 * clips it and receives the events. For the pointer-anchored zoom to be exact,
 * `inner`'s untransformed border box must start at `wrapper`'s top-left corner
 * (a block child, or an absolutely positioned `inset: 0` stage) and its
 * `transform-origin` must be `0 0`.
 *
 * Window-level move/up listeners exist only for the duration of a drag, so a
 * pane that unmounts mid-drag leaves nothing behind — and `dispose()` covers
 * the case where it unmounts *during* one, which is the only way a listener
 * could otherwise outlive the element.
 */
export function attachPanZoom(
  wrapper: HTMLElement,
  inner: HTMLElement,
  options: PanZoomOptions = {}
): PanZoom {
  const minScale = options.minScale ?? 0.2;
  const maxScale = options.maxScale ?? 5;
  const onScaleChange = options.onScaleChange;

  let scale = 1;
  let panX = 0;
  let panY = 0;

  function applyTransform() {
    inner.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  }

  // Zoom about a point given in wrapper coordinates: whatever is under that
  // point is what the user is looking at, so it must not move.
  function zoomAbout(next: number, cx: number, cy: number) {
    const clamped = Math.max(minScale, Math.min(maxScale, next));
    if (clamped === scale) return;
    panX = cx - (cx - panX) * (clamped / scale);
    panY = cy - (cy - panY) * (clamped / scale);
    scale = clamped;
    applyTransform();
    onScaleChange?.(scale);
  }

  function center(): [number, number] {
    const rect = wrapper.getBoundingClientRect();
    return [rect.width / 2, rect.height / 2];
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const delta =
      e.deltaMode === 1
        ? e.deltaY * LINE_HEIGHT_PX
        : e.deltaMode === 2
          ? e.deltaY * PAGE_HEIGHT_PX
          : e.deltaY;
    if (delta === 0) return;

    const intensity = e.ctrlKey ? PINCH_INTENSITY : WHEEL_INTENSITY;
    const step = Math.min(MAX_STEP, Math.max(1 / MAX_STEP, Math.exp(-delta * intensity)));

    const rect = wrapper.getBoundingClientRect();
    zoomAbout(scale * step, e.clientX - rect.left, e.clientY - rect.top);
  }

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startPanX = 0;
  let startPanY = 0;

  function onMouseMove(e: MouseEvent) {
    if (!dragging) return;
    panX = startPanX + (e.clientX - startX);
    panY = startPanY + (e.clientY - startY);
    applyTransform();
  }

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    wrapper.style.cursor = "";
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", endDrag);
  }

  function onMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startPanX = panX;
    startPanY = panY;
    wrapper.style.cursor = "grabbing";
    e.preventDefault();
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", endDrag);
  }

  function reset() {
    scale = 1;
    panX = 0;
    panY = 0;
    applyTransform();
    onScaleChange?.(scale);
  }

  wrapper.addEventListener("wheel", onWheel, { passive: false });
  wrapper.addEventListener("mousedown", onMouseDown);
  wrapper.addEventListener("dblclick", reset);

  return {
    dispose() {
      endDrag();
      wrapper.removeEventListener("wheel", onWheel);
      wrapper.removeEventListener("mousedown", onMouseDown);
      wrapper.removeEventListener("dblclick", reset);
    },
    zoomBy(factor: number) {
      const [cx, cy] = center();
      zoomAbout(scale * factor, cx, cy);
    },
    zoomTo(next: number) {
      const [cx, cy] = center();
      zoomAbout(next, cx, cy);
    },
    reset,
    scale: () => scale,
  };
}
