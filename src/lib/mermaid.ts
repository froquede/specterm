// Mermaid, in the two places that draw it.
//
// This started inside lib/markdown.ts, where the markdown preview was the only
// thing that had diagrams in it. Terminal output has them too — Claude Code
// answers with mermaid constantly — and lib/terminal-diagrams.ts now renders
// those into a pane overlay. Both want the same three things: the library
// loaded once and lazily, one palette, and a viewport you can pan and zoom.
//
// Lazy matters more than it looks. Mermaid is by far the largest dependency in
// the app (~1MB of parser and layout engine, more than everything else in the
// bundle put together), and a terminal that pays for it at startup has lost the
// one thing it is for. So nothing here is imported until a diagram is actually
// about to be drawn: the terminal detector deliberately recognizes blocks with
// a regex rather than by asking mermaid to parse them, precisely so that a pane
// that merely *prints* a diagram never loads the chunk. The click does.

// The line that opens a mermaid diagram — its diagram type. Used to tell a real
// block from a fenced code sample that happens to say "mermaid", without
// loading mermaid itself to find out. Kept here beside the renderer because it
// describes the same grammar; every type mermaid 11 supports is listed, so a
// diagram kind this app doesn't know about still gets recognized.
export const DIAGRAM_HEADER_RE =
  /^(?:flowchart|graph|sequenceDiagram|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|gitGraph|mindmap|timeline|zenuml|sankey-beta|xychart-beta|block-beta|packet-beta|kanban|architecture-beta|radar-beta|treemap-beta|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment)\b/;

// The palette. Matches the markdown preview's surface rather than the active
// terminal theme: a diagram is a picture, and re-rendering every open one on a
// theme change would mean re-running layout for no gain in legibility.
const THEME_VARIABLES = {
  darkMode: true,
  background: "#1e1e2e",
  primaryColor: "#89b4fa",
  primaryTextColor: "#cdd6f4",
  primaryBorderColor: "#45475a",
  lineColor: "#6c7086",
  secondaryColor: "#cba6f7",
  tertiaryColor: "#313244",
};

type MermaidApi = typeof import("mermaid").default;

let mermaidPromise: Promise<MermaidApi> | null = null;

/**
 * The mermaid module, imported and initialized exactly once.
 *
 * The promise itself is the cache, so two callers racing (the preview finishing
 * its render while the terminal overlay opens) share one import and one
 * `initialize` rather than interleaving two.
 */
export function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        theme: "dark",
        themeVariables: THEME_VARIABLES,
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

/**
 * Make an SVG draggable and zoomable inside `wrapper`.
 *
 * `inner` is the element that carries the transform; `wrapper` is the box that
 * clips it and receives the events. Window-level move/up listeners exist only
 * for the duration of a drag, so an overlay that closes mid-drag leaves nothing
 * behind — and the returned disposer covers the case where it closes *during*
 * one, which is the only way a listener could otherwise outlive the element.
 */
export function attachPanZoom(
  wrapper: HTMLElement,
  inner: HTMLElement
): () => void {
  let scale = 1;
  let panX = 0;
  let panY = 0;

  function applyTransform() {
    inner.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.max(0.2, Math.min(5, scale * delta));

    // Zoom toward the cursor rather than the origin: the point under the
    // pointer is the one the user is looking at, so it must not move.
    const rect = wrapper.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    panX = cx - (cx - panX) * (newScale / scale);
    panY = cy - (cy - panY) * (newScale / scale);
    scale = newScale;

    applyTransform();
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

  function onDoubleClick() {
    scale = 1;
    panX = 0;
    panY = 0;
    applyTransform();
  }

  wrapper.addEventListener("wheel", onWheel, { passive: false });
  wrapper.addEventListener("mousedown", onMouseDown);
  wrapper.addEventListener("dblclick", onDoubleClick);

  return () => {
    endDrag();
    wrapper.removeEventListener("wheel", onWheel);
    wrapper.removeEventListener("mousedown", onMouseDown);
    wrapper.removeEventListener("dblclick", onDoubleClick);
  };
}

/**
 * Put `svg` inside a pan/zoom viewport, in the place it currently occupies.
 *
 * Used by the markdown preview, where mermaid has already replaced each
 * `<pre class="mermaid">` with its rendered SVG in the document.
 */
export function wrapInViewport(svg: Element): () => void {
  const parent = svg.parentElement;
  if (!parent) return () => {};

  const wrapper = document.createElement("div");
  wrapper.className = "mermaid-viewport";
  const inner = document.createElement("div");
  inner.className = "mermaid-inner";

  parent.replaceChild(wrapper, svg);
  inner.appendChild(svg);
  wrapper.appendChild(inner);

  return attachPanZoom(wrapper, inner);
}

// Mermaid needs a DOM id for every render, and reuses it for the ids *inside*
// the SVG it produces. Two diagrams sharing one would collide on marker and
// clip-path references, which shows up as arrowheads vanishing from whichever
// rendered second.
let renderSeq = 0;

export interface DiagramRender {
  /** Diagram source that actually rendered — may be shorter than what was asked
   *  for, when trailing lines had to be dropped. See renderDiagramInto. */
  source: string;
  /** How many trailing lines were dropped to make it parse. */
  trimmed: number;
}

/**
 * Draw `source` into `host` as a pannable, zoomable diagram.
 *
 * Rejects with the parser's own message when the source isn't a diagram at all;
 * the caller shows that alongside the raw text rather than an empty box.
 *
 * **Why it retries shorter.** Diagrams read off the terminal don't come with
 * their own end marker — Claude Code renders a fenced block without its fences,
 * so the detector has to guess where the block stopped and prose resumed (see
 * lib/terminal-diagrams.ts). Guessing long and letting the parser say where it
 * broke is far more robust than any grammar heuristic: a flowchart is valid at
 * almost every line boundary, so the longest prefix that parses is the block.
 * `maxTrim` bounds the work — each attempt is a full parse, and a source that
 * needs more than a handful of lines removed was never a diagram.
 */
export async function renderDiagramInto(
  host: HTMLElement,
  source: string,
  maxTrim = 12
): Promise<DiagramRender> {
  const mermaid = await loadMermaid();
  const lines = source.replace(/\s+$/, "").split("\n");

  let lastError: unknown = null;
  for (let trimmed = 0; trimmed <= maxTrim && lines.length - trimmed > 1; trimmed++) {
    const candidate = lines.slice(0, lines.length - trimmed).join("\n");
    const id = `specterm-mermaid-${++renderSeq}`;
    try {
      const { svg } = await mermaid.render(id, candidate);
      host.innerHTML = "";

      const wrapper = document.createElement("div");
      wrapper.className = "mermaid-viewport";
      const inner = document.createElement("div");
      inner.className = "mermaid-inner";
      inner.innerHTML = svg;
      wrapper.appendChild(inner);
      host.appendChild(wrapper);

      attachPanZoom(wrapper, inner);
      return { source: candidate, trimmed };
    } catch (e) {
      lastError = e;
      // mermaid.render leaves its scratch element behind on failure; without
      // this, a source that needs a few attempts litters the body with orphans
      // that never get collected because they're still in the document.
      document.getElementById(`d${id}`)?.remove();
      document.getElementById(id)?.remove();
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? "could not render diagram"));
}
