import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { attachBrowser, type BrowserView } from "../lib/browser-registry";
import { getBackend } from "../backends";
import {
  IconArrowLeft,
  IconArrowRight,
  IconRefresh,
  IconReveal,
  IconX,
  ICON_SIZE,
  ICON_STROKE,
} from "../lib/icons";

interface BrowserPaneProps {
  paneId: string;
  url: string;
  isActive: boolean;
  onFocus: () => void;
  onNavigate: (url: string) => void;
  onTitle: (title: string) => void;
}

// A web page in a pane: back, forward, reload and an address bar over the
// page. The page itself is not rendered here. It lives in the browser layer
// (lib/browser-registry.ts) so that it survives this component unmounting,
// which happens on every switch to another tab; this renders the placeholder
// the page is laid over.
export default function BrowserPane(props: BrowserPaneProps) {
  let placeholder!: HTMLDivElement;
  let input!: HTMLInputElement;
  const [view, setView] = createSignal<BrowserView | null>(null);
  const [draft, setDraft] = createSignal<string | null>(null);

  onMount(() => {
    const { view: v, detach } = attachBrowser(props.paneId, props.url, placeholder, {
      onFocus: props.onFocus,
      onNavigate: props.onNavigate,
      onTitle: props.onTitle,
    });
    setView(v);
    onCleanup(detach);
    if (v.title()) props.onTitle(v.title());
    // A new page starts at the address bar.
    if (!props.url && props.isActive) input.focus();
  });

  // The address shown: what is being typed, else where the page is.
  const shown = () => {
    const d = draft();
    if (d !== null) return d;
    const u = view()?.url() ?? props.url;
    return u === "about:blank" ? "" : u;
  };

  // Focus moving to this pane from the keyboard (a pane switch shortcut)
  // hands the keyboard to the page, as it would to a terminal.
  createEffect(() => {
    if (props.isActive && document.activeElement !== input && props.url) view()?.focus();
  });

  function submit(e: Event) {
    e.preventDefault();
    const text = draft() ?? shown();
    setDraft(null);
    view()?.navigate(text);
    view()?.focus();
  }

  return (
    <div class="browser-pane">
      <form class="browser-toolbar" onSubmit={submit}>
        <button
          type="button"
          class="browser-btn"
          title="Back"
          aria-label="Back"
          disabled={!view()?.canGoBack()}
          onClick={() => view()?.back()}
        >
          <IconArrowLeft size={ICON_SIZE - 1} stroke-width={ICON_STROKE} />
        </button>
        <button
          type="button"
          class="browser-btn"
          title="Forward"
          aria-label="Forward"
          disabled={!view()?.canGoForward()}
          onClick={() => view()?.forward()}
        >
          <IconArrowRight size={ICON_SIZE - 1} stroke-width={ICON_STROKE} />
        </button>
        <Show
          when={view()?.loading()}
          fallback={
            <button type="button" class="browser-btn" title="Reload" aria-label="Reload" onClick={() => view()?.reload()}>
              <IconRefresh size={ICON_SIZE - 2} stroke-width={ICON_STROKE} />
            </button>
          }
        >
          <button type="button" class="browser-btn" title="Stop" aria-label="Stop" onClick={() => view()?.stop()}>
            <IconX size={ICON_SIZE - 1} stroke-width={ICON_STROKE} />
          </button>
        </Show>
        <input
          ref={input}
          class="browser-address"
          type="text"
          spellcheck={false}
          placeholder="Search or type an address"
          value={shown()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setDraft(null);
              e.currentTarget.value = shown();
              view()?.focus();
            }
          }}
        />
        <button
          type="button"
          class="browser-btn"
          title="Open in your browser"
          aria-label="Open in your browser"
          disabled={!/^https?:/.test(view()?.url() ?? "")}
          onClick={() => {
            const u = view()?.url();
            if (u) void getBackend().then((b) => b.openExternal(u));
          }}
        >
          <IconReveal size={ICON_SIZE - 2} stroke-width={ICON_STROKE} />
        </button>
        <Show when={view()?.loading()}>
          <div class="browser-progress" />
        </Show>
      </form>
      <div class="browser-placeholder" ref={placeholder} />
    </div>
  );
}
