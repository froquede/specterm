import { createSignal, onCleanup, Show } from "solid-js";
import { attachPanZoom, type PanZoom } from "../lib/pan-zoom";

interface ImagePaneProps {
  filePath: string;
}

// How far a click on + or − moves. A wheel notch is ~10%; a button press is a
// deliberate act and gets a step you can count.
const BUTTON_STEP = 1.25;
// Zoom limits, in viewport scale — where 1 is "fitted to the pane". They are
// wider than the diagram viewport's because the content is different: a photo
// fitted into a small pane can sit at 0.2 of its own pixels, so 1:1 alone needs
// a scale of 5, and inspecting a screenshot pixel by pixel needs more.
const MIN_SCALE = 0.1;
const MAX_SCALE = 40;

// Read-only viewer for an image file opened directly — from the file tree, or
// named on the command line (see electron/open-paths.cjs), as opposed to one
// embedded in a markdown note (MarkdownPane/lib/markdown.ts covers that). The
// renderer's document is file:// already, so an absolute path just works as an
// <img src> with no read/IPC step needed.
//
// It opens fitted, and pans and zooms with the same gestures the diagram
// viewport uses — wheel to zoom toward the pointer, drag to pan, double-click
// to go back to fit. See lib/pan-zoom.ts, which both share.
export default function ImagePane(props: ImagePaneProps) {
  let viewportRef!: HTMLDivElement;
  let stageRef!: HTMLDivElement;
  let imgRef!: HTMLImageElement;

  const [failed, setFailed] = createSignal(false);
  const [naturalSize, setNaturalSize] = createSignal<string | null>(null);
  const [scale, setScale] = createSignal(1);
  // Bumped whenever the pane is resized, so the percentage readout — which is
  // scale measured against the image's own pixels, not against the fit — is
  // recomputed when the fit itself changes.
  const [fitEpoch, setFitEpoch] = createSignal(0);

  let panZoom: PanZoom | null = null;
  let resizeObserver: ResizeObserver | null = null;

  // Scale 1 means "fitted", which is a different number of image pixels in
  // every pane width. This turns it into the number people expect to see: 100%
  // is one image pixel per CSS pixel.
  const percent = () => {
    fitEpoch();
    const fitted = imgRef?.clientWidth ?? 0;
    const natural = imgRef?.naturalWidth ?? 0;
    if (!fitted || !natural) return Math.round(scale() * 100);
    return Math.round((scale() * fitted * 100) / natural);
  };

  // The scale at which one image pixel covers one CSS pixel. Equal to 1 for any
  // image small enough to be shown whole, since the fit never upscales.
  const oneToOneScale = () => {
    const fitted = imgRef?.clientWidth ?? 0;
    const natural = imgRef?.naturalWidth ?? 0;
    return fitted && natural ? natural / fitted : 1;
  };

  const setup = () => {
    if (panZoom) return;
    panZoom = attachPanZoom(viewportRef, stageRef, {
      minScale: MIN_SCALE,
      maxScale: MAX_SCALE,
      onScaleChange: setScale,
    });
    // The fit changes with the pane, and so does what "100%" means relative to
    // it. Only fires on a real layout change — the transform doesn't resize
    // anything — and is disconnected below with everything else.
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => setFitEpoch((n) => n + 1));
      resizeObserver.observe(viewportRef);
    }
  };

  onCleanup(() => {
    panZoom?.dispose();
    panZoom = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
  });

  return (
    <div class="image-pane">
      <div class="image-toolbar">
        <span class="image-filepath">{props.filePath}</span>
        <div class="image-toolbar-right">
          <Show when={naturalSize()}>
            <span class="image-dimensions">{naturalSize()}</span>
          </Show>
          <Show when={!failed()}>
            <div class="image-zoom">
              <button
                class="image-zoom-btn"
                title="Zoom out"
                onClick={() => panZoom?.zoomBy(1 / BUTTON_STEP)}
              >
                −
              </button>
              <span class="image-zoom-level">{percent()}%</span>
              <button
                class="image-zoom-btn"
                title="Zoom in"
                onClick={() => panZoom?.zoomBy(BUTTON_STEP)}
              >
                +
              </button>
              <button
                class="image-zoom-btn image-zoom-text"
                title="Fit to pane (or double-click the image)"
                onClick={() => panZoom?.reset()}
              >
                Fit
              </button>
              <button
                class="image-zoom-btn image-zoom-text"
                title="Actual size"
                onClick={() => panZoom?.zoomTo(oneToOneScale())}
              >
                1:1
              </button>
            </div>
          </Show>
        </div>
      </div>
      <div class="image-body" ref={viewportRef}>
        <Show
          when={!failed()}
          fallback={<div class="image-error">Can't load this image.</div>}
        >
          <div class="image-stage" ref={stageRef}>
            <img
              ref={imgRef}
              src={props.filePath}
              alt={props.filePath}
              draggable={false}
              onLoad={(e) => {
                const img = e.currentTarget;
                setNaturalSize(`${img.naturalWidth} × ${img.naturalHeight}`);
                // Wired only once the image is actually there: an image that
                // never loads has nothing to pan, and the fallback replaces the
                // stage the transform would go on.
                setup();
                setFitEpoch((n) => n + 1);
              }}
              onError={() => setFailed(true)}
            />
          </div>
        </Show>
      </div>
    </div>
  );
}
