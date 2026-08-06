import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import {
  closeDiagram,
  openDiagramTarget,
  paneDiagrams,
  stepDiagram,
} from "../stores/diagrams";
import { renderDiagramInto } from "../lib/mermaid";
import { getBackend } from "../backends";
import { IconChevronUp, IconChevronDown, IconX } from "../lib/icons";

interface DiagramOverlayProps {
  paneId: string;
}

/**
 * A diagram from this pane's output, drawn over the pane.
 *
 * Deliberately an overlay and not a pane of its own: the terminal it came from
 * is the context you are reading it in, and a split would push that terminal to
 * half width — reflowing the very output the diagram was found in. This costs
 * nothing but the space it covers, and Esc gives it back.
 */
export default function DiagramOverlay(props: DiagramOverlayProps) {
  // A signal rather than a plain ref: the host only exists while the overlay is
  // open, so the render effect has to depend on it appearing, not merely hope
  // it was assigned before the effect first ran.
  const [host, setHost] = createSignal<HTMLDivElement | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal(false);

  const target = () => {
    const open = openDiagramTarget();
    return open && open.paneId === props.paneId ? open : null;
  };
  const list = () => paneDiagrams(props.paneId);
  const diagram = () => {
    const open = target();
    return open ? (list().find((d) => d.id === open.id) ?? null) : null;
  };
  const position = () => {
    const open = target();
    return open ? list().findIndex((d) => d.id === open.id) + 1 : 0;
  };

  // Draw whenever the diagram changes — including in place, when the transcript
  // lookup lands a better copy of a source already on screen (see the store).
  createEffect(() => {
    const current = diagram();
    const element = host();
    if (!current || !element) return;
    setError(null);
    // A source guessed off the screen is allowed to shed more trailing lines
    // than a fenced one, which is complete by construction: the guess ends
    // wherever the prose after the block stopped looking like a diagram.
    renderDiagramInto(element, current.source, current.exact ? 4 : 24).catch(
      (e: unknown) => {
        element.innerHTML = "";
        setError(e instanceof Error ? e.message : String(e));
      }
    );
  });

  async function copySource() {
    const current = diagram();
    if (!current) return;
    try {
      const backend = await getBackend();
      await backend.clipboardWriteText(current.source);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch (_) {
      // Clipboard refused — the source is still on screen behind the overlay.
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!target()) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeDiagram();
      return;
    }
    // Only with a second diagram to step to, so the arrows keep reaching the
    // shell underneath in the ordinary case of a single one.
    if (list().length < 2) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      stepDiagram(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      stepDiagram(1);
    }
  }

  onMount(() => window.addEventListener("keydown", onKeyDown, true));
  onCleanup(() => window.removeEventListener("keydown", onKeyDown, true));

  return (
    <Show when={diagram()}>
      {(current) => (
        <div class="diagram-overlay">
          <div class="diagram-overlay-bar">
            <span class="diagram-overlay-title">{current().title}</span>
            <Show when={list().length > 1}>
              <span class="diagram-overlay-nav">
                <button
                  class="diagram-overlay-btn"
                  title="Previous diagram (←)"
                  onClick={() => stepDiagram(-1)}
                >
                  <IconChevronUp size={13} stroke-width={2} />
                </button>
                <span class="diagram-overlay-count">
                  {position()}/{list().length}
                </span>
                <button
                  class="diagram-overlay-btn"
                  title="Next diagram (→)"
                  onClick={() => stepDiagram(1)}
                >
                  <IconChevronDown size={13} stroke-width={2} />
                </button>
              </span>
            </Show>
            <button
              class="diagram-overlay-btn diagram-overlay-copy"
              title="Copy the mermaid source"
              onClick={copySource}
            >
              {copied() ? "Copied" : "Copy source"}
            </button>
            <button
              class="diagram-overlay-btn"
              title="Close (Esc)"
              onClick={closeDiagram}
            >
              <IconX size={13} stroke-width={2} />
            </button>
          </div>
          {/* The rendered SVG goes here; the host is written to imperatively by
              the effect above, so nothing reactive may live inside it. */}
          <div ref={setHost} class="diagram-overlay-body" />
          <Show when={error()}>
            <div class="diagram-overlay-error">
              <p>Mermaid couldn't parse this block: {error()}</p>
              <pre>{current().source}</pre>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
}
