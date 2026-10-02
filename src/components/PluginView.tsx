import { createEffect, createMemo, createRoot, createSignal, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { PluginViewKey } from "../types";
import {
  findPluginOverlay,
  findPluginView,
  pluginHost,
  viewKey,
  invokePlugin,
  onPluginEvent,
  onPluginReveal,
  pluginStorage,
  type PluginStorage,
} from "../stores/plugins";
import { useTabStore } from "../stores/tabs";
import { useTerminalCwd } from "../lib/terminal-registry";
import { getBackend } from "../backends";
import { noteStructure, renderMarkdown, type NoteHeading, type NoteLink } from "../lib/markdown";
import { os } from "../lib/platform";
import "../styles/plugins.css";

// What a plugin's panel module gets. Versioned with the manifest's
// `engines.specterm`: an addition is a new minor (noted beside it), a change is
// a new major.
export interface PluginPanelApi {
  apiVersion: "1.3";
  pluginId: string;
  viewId: string;
  /** Call a method its host module registered with `ctx.handle`. */
  invoke(method: string, ...args: unknown[]): Promise<unknown>;
  /** Hear `ctx.emit(event, payload)` from the host. Returns the unsubscribe. */
  on(event: string, cb: (payload: unknown) => void): () => void;
  /** Close this view. */
  close(): void;
  /** 1.1 — The payload of a clicked toast. One that arrived before the panel
   *  subscribed is delivered on subscribing. Returns the unsubscribe. */
  onReveal(cb: (payload: unknown) => void): () => void;
  /** 1.1 — Markdown to HTML with the app's own renderer: raw HTML in the
   *  source is escaped, never passed through. */
  renderMarkdown(source: string): string;
  /** 1.1 — The host OS, for things like shortcut labels. */
  platform: "darwin" | "win32" | "linux";
  /** 1.1 — Open an http(s) URL in the default browser. */
  openExternal(url: string): void;
  /** 1.2 — The active pane's working directory: called now, and again
   *  whenever it changes (a pane or tab switch, a `cd`). null when the active
   *  pane isn't a terminal or hasn't reported one. Returns the unsubscribe. */
  onActiveCwd(cb: (cwd: string | null) => void): () => void;
  /** 1.2 — Open a file in a new tab ("tab") or beside the active pane
   *  ("split"), the way the file tree does. */
  openFile(path: string, mode?: "tab" | "split"): void;
  /** 1.2 — A small JSON store for this plugin, shared by its windows. */
  storage: PluginStorage;
  /** 1.3 — The file shown in the active pane: called now, and again whenever
   *  it changes. null when the active pane is a terminal. */
  onActiveFile(cb: (path: string | null) => void): () => void;
  /** 1.3 — Scroll the active pane's rendered markdown to its Nth heading, N as
   *  counted by noteStructure. Does nothing for a pane in edit mode. */
  revealHeading(index: number): void;
  /** 1.3 — The headings and links of a markdown source, parsed by the same
   *  renderer the preview uses, so heading N here is heading N there. */
  noteStructure(source: string): { headings: NoteHeading[]; links: NoteLink[] };
  /** 1.3 — Show one of this plugin's sidebar views. */
  showView(viewId: string): void;
}

const PLATFORM = ({ mac: "darwin", windows: "win32", linux: "linux" } as const)[os];

// A sidebar view contributed by a plugin. The frame and the title are ours, so
// every plugin's view sits in the sidebar like the built-in ones; the body is an
// element the plugin's panel module owns until it is unmounted.
//
// The module is imported when the view first opens, never at boot. Its
// stylesheet is attached for as long as the view is mounted. Everything the
// panel subscribed to through `api.on` is dropped here when the view goes,
// whether or not the panel's own dispose remembered to.
// The same component mounts an overlay (`overlay`): no frame, a backdrop the
// core owns that closes it on a click outside or Escape, and the panel module
// mounted with the overlay's id.
export default function PluginView(props: {
  viewKey: PluginViewKey;
  onClose: () => void;
  overlay?: boolean;
}) {
  // Read once: App remounts this component when the key changes.
  const found = (() => {
    if (props.overlay) {
      const o = findPluginOverlay(props.viewKey);
      return o && { plugin: o.plugin, view: { id: o.overlay.id, title: "", ownHeader: true } };
    }
    return findPluginView(props.viewKey);
  })();
  const store = useTabStore();
  // The memo matters: the cwd epoch moves when *any* pane changes directory,
  // and a panel should only hear about the active one.
  const activeCwd = createMemo(() => {
    const paneId = store.activeTab?.activePaneId;
    return paneId ? useTerminalCwd(paneId) || null : null;
  });
  const [error, setError] = createSignal<string | null>(null);
  let body!: HTMLDivElement;
  let disposed = false;
  let dispose: (() => void) | null = null;
  let stylesheet: HTMLLinkElement | null = null;
  const unsubscribes = new Set<() => void>();

  onMount(async () => {
    if (!found?.plugin.panel) {
      setError("This plugin has no panel to show.");
      return;
    }
    const { plugin, view } = found;
    const panelUrl = found.plugin.panel;
    if (plugin.style) {
      stylesheet = document.createElement("link");
      stylesheet.rel = "stylesheet";
      stylesheet.href = plugin.style;
      stylesheet.dataset.plugin = plugin.id;
      document.head.appendChild(stylesheet);
    }
    const api: PluginPanelApi = {
      apiVersion: "1.3",
      pluginId: plugin.id,
      viewId: view.id,
      invoke: (method, ...args) => invokePlugin(plugin.id, method, args),
      on(event, cb) {
        const off = onPluginEvent(plugin.id, event, cb);
        unsubscribes.add(off);
        return () => {
          off();
          unsubscribes.delete(off);
        };
      },
      close: () => props.onClose(),
      onReveal(cb) {
        const off = onPluginReveal(plugin.id, cb);
        unsubscribes.add(off);
        return () => {
          off();
          unsubscribes.delete(off);
        };
      },
      renderMarkdown: (source) => renderMarkdown(String(source ?? "")),
      platform: PLATFORM,
      openExternal(url) {
        if (!/^https?:\/\//i.test(String(url))) return;
        void getBackend().then((backend) => backend.openExternal(String(url)));
      },
      onActiveCwd(cb) {
        // Its own root, so the subscription ends exactly when the panel asks
        // (or the view closes) and not before.
        const dispose = createRoot((disposeRoot) => {
          createEffect(() => {
            const cwd = activeCwd();
            try {
              cb(cwd);
            } catch (err) {
              console.error(`[plugin ${plugin.id}] onActiveCwd listener threw:`, err);
            }
          });
          return disposeRoot;
        });
        unsubscribes.add(dispose);
        return () => {
          dispose();
          unsubscribes.delete(dispose);
        };
      },
      openFile(path, mode = "tab") {
        if (typeof path === "string" && path) pluginHost.openFile(path, mode === "split" ? "split" : "tab");
      },
      onActiveFile(cb) {
        const dispose = createRoot((disposeRoot) => {
          createEffect(() => {
            const file = pluginHost.activeFile();
            try {
              cb(file);
            } catch (err) {
              console.error(`[plugin ${plugin.id}] onActiveFile listener threw:`, err);
            }
          });
          return disposeRoot;
        });
        unsubscribes.add(dispose);
        return () => {
          dispose();
          unsubscribes.delete(dispose);
        };
      },
      revealHeading: (index) => pluginHost.revealHeading(Number(index)),
      noteStructure: (source) => noteStructure(String(source ?? "")),
      showView: (viewId) => pluginHost.showView(viewKey(plugin.id, String(viewId))),
      storage: (() => {
        const storage = pluginStorage(plugin.id);
        return {
          get: storage.get,
          set: storage.set,
          onChange(cb) {
            const off = storage.onChange(cb);
            unsubscribes.add(off);
            return () => {
              off();
              unsubscribes.delete(off);
            };
          },
        };
      })(),
    };
    try {
      const mod = await import(/* @vite-ignore */ panelUrl);
      if (disposed) return;
      if (typeof mod.mount !== "function") {
        throw new Error("the panel module must export mount(element, api)");
      }
      const result = await mod.mount(body, api);
      if (typeof result === "function") {
        if (disposed) result();
        else dispose = result;
      }
    } catch (err) {
      if (!disposed) setError(err instanceof Error ? err.message : String(err));
    }
  });

  onCleanup(() => {
    disposed = true;
    for (const off of unsubscribes) off();
    unsubscribes.clear();
    try {
      dispose?.();
    } catch (err) {
      console.error(`[plugin ${found?.plugin.id}] dispose threw:`, err);
    }
    stylesheet?.remove();
    body.replaceChildren();
  });

  const content = () => (
    <>
      <Show when={error()}>
        <div class="plugin-view-error">{error()}</div>
      </Show>
      <div class="plugin-view-body" ref={body} />
    </>
  );

  if (props.overlay) {
    return (
      <Portal>
        <div
          class="plugin-overlay-backdrop"
          data-plugin={found?.plugin.id}
          onClick={() => props.onClose()}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              props.onClose();
            }
          }}
        >
          <div class="plugin-overlay" onClick={(e) => e.stopPropagation()}>
            {content()}
          </div>
        </div>
      </Portal>
    );
  }

  return (
    <div
      class="plugin-view"
      role="complementary"
      aria-label={found?.view.title ?? "Plugin"}
      data-plugin={found?.plugin.id}
    >
      <Show when={!found?.view.ownHeader}>
        <div class="plugin-view-header">
          <span class="plugin-view-title">{found?.view.title ?? "Plugin"}</span>
        </div>
      </Show>
      {content()}
    </div>
  );
}
