// The live web pages of browser panes, kept outside the pane tree.
//
// A <webview> loses its page whenever it leaves the document: moving it to
// another parent reloads it, and App renders only the active tab, so a pane
// in a background tab is unmounted. A video playing in one tab would restart
// every time you came back to it. So each page lives here instead, in one
// layer over the panes (`.browser-layer`, mounted by App), for as long as its
// pane exists. The pane renders a placeholder; the page is laid over the
// placeholder's rectangle while it is on screen, and hidden (still loaded,
// still playing) while it is not. Pages whose pane is gone are destroyed by
// `disposeBrowsersExcept`, which App runs whenever the tree changes.
//
// The page runs in its own sandboxed process with no preload and no Node,
// in the `persist:browser` session (cookies kept across launches, apart from
// the app's own); electron/main.cjs enforces that whatever the element asks
// for (see "will-attach-webview").

import { createSignal, type Accessor } from "solid-js";
import type { PaneId } from "../types";

export const BROWSER_PARTITION = "persist:browser";
const SEARCH_URL = "https://www.google.com/search?q=";

// Electron's <webview> element, the parts used here.
interface WebviewElement extends HTMLElement {
  src: string;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  getWebContentsId(): number;
}

export interface BrowserView {
  url: Accessor<string>;
  title: Accessor<string>;
  loading: Accessor<boolean>;
  canGoBack: Accessor<boolean>;
  canGoForward: Accessor<boolean>;
  navigate(input: string): void;
  back(): void;
  forward(): void;
  reload(): void;
  stop(): void;
  focus(): void;
}

export interface BrowserCallbacks {
  /** The page got the keyboard: the pane should become the active one. */
  onFocus(): void;
  /** The page moved to another address (a link, a redirect, history). */
  onNavigate(url: string): void;
  onTitle(title: string): void;
}

interface Entry {
  wrapper: HTMLDivElement;
  view: WebviewElement;
  api: BrowserView;
  ready: boolean;
  placeholder: HTMLElement | null;
  callbacks: BrowserCallbacks | null;
  observer: ResizeObserver;
  setUrl(url: string): void;
  setTitle(title: string): void;
  setLoading(v: boolean): void;
  setHistory(back: boolean, forward: boolean): void;
}

const entries = new Map<PaneId, Entry>();
let layer: HTMLElement | null = null;

/**
 * What the address bar's text means: an address when it looks like one
 * (a scheme, or a dotted host with no spaces, or localhost), a search
 * otherwise. Only http(s) and about:blank load; anything else becomes a search.
 */
export function normalizeAddress(input: string): string {
  const text = input.trim();
  if (!text) return "about:blank";
  if (text === "about:blank") return text;
  if (/^https?:\/\//i.test(text)) return text;
  if (!/\s/.test(text) && /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?(\/.*)?$/i.test(text)) {
    return `http://${text}`;
  }
  if (!/\s/.test(text) && /^[^/:]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text)) return `https://${text}`;
  return SEARCH_URL + encodeURIComponent(text);
}

/** What a tab or pane title says for a page: its title, else its host. */
export function browserTitle(paneId: PaneId, url: string): string {
  const title = entries.get(paneId)?.api.title();
  if (title) return title;
  try {
    const host = new URL(url).hostname;
    if (host) return host.replace(/^www\./, "");
  } catch {
    /* not an address yet */
  }
  return "New page";
}

function isLoadable(url: string): boolean {
  return url === "about:blank" || /^https?:\/\//i.test(url);
}

/** The layer pages are laid out in. App mounts it once per window. */
export function mountBrowserLayer(el: HTMLElement): () => void {
  layer = el;
  for (const entry of entries.values()) el.appendChild(entry.wrapper);
  // A gesture that starts in the app (resizing a split or the sidebar,
  // dragging a pane) must keep getting the pointer when it crosses a page,
  // which would otherwise take it into its own process.
  const passive = () => el.classList.add("browser-layer-passive");
  const active = () => el.classList.remove("browser-layer-passive");
  document.addEventListener("pointerdown", passive, true);
  document.addEventListener("pointerup", active, true);
  document.addEventListener("pointercancel", active, true);
  const observer = new ResizeObserver(scheduleSync);
  observer.observe(el);
  return () => {
    document.removeEventListener("pointerdown", passive, true);
    document.removeEventListener("pointerup", active, true);
    document.removeEventListener("pointercancel", active, true);
    observer.disconnect();
    if (layer === el) layer = null;
  };
}

function createEntry(paneId: PaneId, initialUrl: string): Entry {
  const [url, setUrl] = createSignal(initialUrl);
  const [title, setTitle] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [canGoBack, setCanGoBack] = createSignal(false);
  const [canGoForward, setCanGoForward] = createSignal(false);

  const wrapper = document.createElement("div");
  wrapper.className = "browser-view";
  wrapper.dataset.paneId = paneId;
  wrapper.style.visibility = "hidden";

  const view = document.createElement("webview") as WebviewElement;
  view.setAttribute("partition", BROWSER_PARTITION);
  // New windows the page opens (target=_blank, window.open) are turned into
  // browser tabs by the main process; without this they are dropped silently.
  view.setAttribute("allowpopups", "");
  // A new page has no address yet, and no guest until it gets one: starting
  // it at about:blank would leave a blank entry for Back to land on.
  if (initialUrl && isLoadable(initialUrl)) view.setAttribute("src", initialUrl);
  wrapper.appendChild(view);

  const entry: Entry = {
    wrapper,
    view,
    ready: false,
    placeholder: null,
    callbacks: null,
    observer: new ResizeObserver(scheduleSync),
    setUrl,
    setTitle,
    setLoading,
    setHistory(back, forward) {
      setCanGoBack(back);
      setCanGoForward(forward);
    },
    api: {
      url,
      title,
      loading,
      canGoBack,
      canGoForward,
      navigate(input) {
        const target = normalizeAddress(input);
        setUrl(target);
        if (entry.ready) void view.loadURL(target).catch(() => {});
        else view.setAttribute("src", target);
      },
      back: () => entry.ready && view.goBack(),
      forward: () => entry.ready && view.goForward(),
      reload: () => entry.ready && view.reload(),
      stop: () => entry.ready && view.stop(),
      focus: () => view.focus(),
    },
  };

  const refreshHistory = () => {
    if (entry.ready) entry.setHistory(view.canGoBack(), view.canGoForward());
  };
  const navigated = (next: string) => {
    if (!next) return;
    setUrl(next);
    refreshHistory();
    // about:blank is where a new page starts, not an address worth keeping.
    if (next !== "about:blank") entry.callbacks?.onNavigate(next);
  };

  view.addEventListener("dom-ready", () => {
    entry.ready = true;
    refreshHistory();
  });
  view.addEventListener("did-start-loading", () => setLoading(true));
  view.addEventListener("did-stop-loading", () => {
    setLoading(false);
    refreshHistory();
  });
  view.addEventListener("did-navigate", (e) => navigated((e as Event & { url: string }).url));
  view.addEventListener("did-navigate-in-page", (e) => {
    const ev = e as Event & { url: string; isMainFrame: boolean };
    if (ev.isMainFrame) navigated(ev.url);
  });
  view.addEventListener("page-title-updated", (e) => {
    const t = (e as Event & { title: string }).title;
    setTitle(t);
    entry.callbacks?.onTitle(t);
  });
  view.addEventListener("focus", () => entry.callbacks?.onFocus());

  layer?.appendChild(wrapper);
  return entry;
}

/**
 * Show `paneId`'s page over `placeholder`, creating the page on first use.
 * Returns the page's controls and the detach, which hides the page without
 * unloading it.
 */
export function attachBrowser(
  paneId: PaneId,
  url: string,
  placeholder: HTMLElement,
  callbacks: BrowserCallbacks
): { view: BrowserView; detach: () => void } {
  let entry = entries.get(paneId);
  if (!entry) {
    entry = createEntry(paneId, url);
    entries.set(paneId, entry);
  }
  const e = entry;
  if (e.placeholder) e.observer.unobserve(e.placeholder);
  e.placeholder = placeholder;
  e.callbacks = callbacks;
  e.observer.observe(placeholder);
  scheduleSync();
  return {
    view: e.api,
    detach() {
      if (e.placeholder !== placeholder) return;
      e.observer.unobserve(placeholder);
      e.placeholder = null;
      e.callbacks = null;
      scheduleSync();
    },
  };
}

/** Destroy every page whose pane is not in `alive`. */
export function disposeBrowsersExcept(alive: ReadonlySet<PaneId>) {
  for (const [id, entry] of entries) {
    if (alive.has(id)) continue;
    entry.observer.disconnect();
    entry.wrapper.remove();
    entries.delete(id);
  }
}

/** The pane whose page has this web contents id (a page asking for a new window). */
export function browserPaneForWebContents(webContentsId: number): PaneId | null {
  for (const [id, entry] of entries) {
    try {
      if (entry.ready && entry.view.getWebContentsId() === webContentsId) return id;
    } catch {
      /* not attached yet */
    }
  }
  return null;
}

export function focusBrowser(paneId: PaneId): boolean {
  const entry = entries.get(paneId);
  if (!entry) return false;
  entry.view.focus();
  return true;
}

// --- layout -----------------------------------------------------------------
// Every page is laid over its placeholder. A ResizeObserver on each
// placeholder and on the layer says when something may have moved; positions
// can still shift without a size changing (a neighbour's split moving), so
// each nudge runs a short burst of frames rather than one.

const SYNC_FRAMES = 12;
let framesLeft = 0;
let frame = 0;

function scheduleSync() {
  framesLeft = SYNC_FRAMES;
  if (!frame) frame = requestAnimationFrame(tick);
}

function tick() {
  frame = 0;
  syncAll();
  if (--framesLeft > 0) frame = requestAnimationFrame(tick);
}

function syncAll() {
  if (!layer) return;
  const base = layer.getBoundingClientRect();
  for (const entry of entries.values()) {
    const ph = entry.placeholder;
    const r = ph?.isConnected ? ph.getBoundingClientRect() : null;
    const style = entry.wrapper.style;
    if (!r || r.width === 0 || r.height === 0) {
      if (style.visibility !== "hidden") style.visibility = "hidden";
      continue;
    }
    const next = {
      left: `${r.left - base.left}px`,
      top: `${r.top - base.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    };
    if (style.left !== next.left) style.left = next.left;
    if (style.top !== next.top) style.top = next.top;
    if (style.width !== next.width) style.width = next.width;
    if (style.height !== next.height) style.height = next.height;
    // The page's own size too: a <webview> sized by percentages does not
    // always pass a new size on to its page, which then keeps the width it
    // was first laid out at.
    const vs = entry.view.style;
    if (vs.width !== next.width) vs.width = next.width;
    if (vs.height !== next.height) vs.height = next.height;
    if (style.visibility !== "visible") style.visibility = "visible";
  }
}
