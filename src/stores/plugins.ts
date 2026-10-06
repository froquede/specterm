import { createSignal } from "solid-js";
import { getBackend, windowBoot } from "../backends";
import type {
  PluginBadge,
  PluginContribution,
  PluginInfo,
  PluginSidebarView,
  PluginsChanged,
  PluginToast,
} from "../backends/types";
import type { PluginViewKey } from "../types";
import { cmd } from "../lib/platform";
import {
  registerBindings,
  unregisterBindings,
  type BindingSpec,
} from "./keybindings";
import { publishStoreChange, registerStoreSync } from "../lib/store-sync";
import { afterFirstTerminalRender } from "../lib/terminal-registry";

// The renderer's side of plugins: what the enabled ones contribute to this
// window, their badges, and the one subscription their events arrive on. The
// host side is electron/plugins.cjs; the design is docs/plugin-architecture.md.
//
// Everything a plugin contributes to the chrome is static data from its
// manifest, so the tab bar can draw it from the boot answer on the first frame.
// Plugin code is only loaded when one of its views is opened (PluginView).

const [contributions, setContributions] = createSignal<readonly PluginContribution[]>(
  windowBoot().plugins ?? []
);
const [badges, setBadges] = createSignal<Readonly<Record<string, PluginBadge>>>({});
// Settings' list, loaded the first time Settings asks for it and kept current
// from then on by the same change events.
const [pluginList, setPluginList] = createSignal<readonly PluginInfo[] | null>(null);

export { contributions as pluginContributions, badges as pluginBadges, pluginList };

export const viewKey = (pluginId: string, viewId: string): PluginViewKey =>
  `plugin:${pluginId}/${viewId}`;

export function findPluginView(
  key: string | null
): { plugin: PluginContribution; view: PluginSidebarView } | null {
  if (!key || !key.startsWith("plugin:")) return null;
  for (const plugin of contributions()) {
    for (const view of plugin.sidebarViews) {
      if (viewKey(plugin.id, view.id) === key) return { plugin, view };
    }
  }
  return null;
}

export function findPluginOverlay(
  key: string | null
): { plugin: PluginContribution; overlay: { id: string } } | null {
  if (!key || !key.startsWith("plugin:")) return null;
  for (const plugin of contributions()) {
    for (const overlay of plugin.overlays ?? []) {
      if (viewKey(plugin.id, overlay.id) === key) return { plugin, overlay };
    }
  }
  return null;
}

// The overlay open in this window, if any: one at a time, like a palette.
const [openOverlay, setOpenOverlay] = createSignal<PluginViewKey | null>(null);
export { openOverlay };

export function toggleOverlay(key: PluginViewKey) {
  setOpenOverlay((current) => (current === key ? null : key));
}

export function closeOverlay() {
  setOpenOverlay(null);
}

export interface PluginButton {
  pluginId: string;
  viewKey: PluginViewKey;
  icon: string;
  title: string;
}

export function pluginButtons(): PluginButton[] {
  return contributions()
    .filter((p) => p.tabBarButton)
    .sort(
      (a, b) =>
        (a.tabBarButton!.order ?? 100) - (b.tabBarButton!.order ?? 100) || a.id.localeCompare(b.id)
    )
    .map((p) => ({
      pluginId: p.id,
      viewKey: viewKey(p.id, p.tabBarButton!.view),
      icon: p.tabBarButton!.icon,
      title: p.tabBarButton!.title,
    }));
}

export async function invokePlugin(
  pluginId: string,
  method: string,
  args: unknown[]
): Promise<unknown> {
  const backend = await getBackend();
  return backend.pluginInvoke(pluginId, method, args);
}

// Panels subscribe here rather than to the backend directly, so however many
// panels are open there is exactly one IPC listener, and a panel's listeners
// can be dropped as a set when it unmounts.
type EventListener = (payload: unknown) => void;
const eventListeners = new Map<string, Set<{ event: string; cb: EventListener }>>();

export function onPluginEvent(pluginId: string, event: string, cb: EventListener): () => void {
  let set = eventListeners.get(pluginId);
  if (!set) eventListeners.set(pluginId, (set = new Set()));
  const entry = { event, cb };
  set.add(entry);
  return () => {
    set!.delete(entry);
    if (set!.size === 0) eventListeners.delete(pluginId);
  };
}

function dispatchEvent(pluginId: string, event: string, payload: unknown) {
  const set = eventListeners.get(pluginId);
  if (!set) return;
  for (const entry of [...set]) {
    if (entry.event !== event) continue;
    try {
      entry.cb(payload);
    } catch (err) {
      console.error(`[plugin ${pluginId}] "${event}" listener threw:`, err);
    }
  }
}

// --- toasts and reveals ---------------------------------------------------------
//
// A toast is a plugin host's heads-up (a new message), shown under the plugin's
// tab-bar button in this window. One at a time: a newer one replaces it. It is
// skipped where it adds nothing — the plugin's view is already open here, and
// the panel picks the news up itself — and for a plugin with no button to hang
// it from. Clicking it opens the view and hands the toast's payload to the
// panel through api.onReveal.

export const TOAST_MS = 5000;

export interface ActiveToast {
  pluginId: string;
  viewKey: PluginViewKey;
  toast: PluginToast;
}

const [pluginToast, setPluginToast] = createSignal<ActiveToast | null>(null);
export { pluginToast };

let toastTimer: number | undefined;
let toastRemaining = TOAST_MS;
let toastStartedAt = 0;

function startToastTimer(ms: number) {
  window.clearTimeout(toastTimer);
  toastRemaining = ms;
  toastStartedAt = Date.now();
  toastTimer = window.setTimeout(() => setPluginToast(null), ms);
}

function showToast(pluginId: string, toast: PluginToast) {
  const button = pluginButtons().find((b) => b.pluginId === pluginId);
  if (!button || isViewOpenImpl(button.viewKey)) return;
  setPluginToast({ pluginId, viewKey: button.viewKey, toast });
  startToastTimer(TOAST_MS);
}

/** Hold the toast while the pointer is over it. */
export function pausePluginToast() {
  if (!pluginToast()) return;
  window.clearTimeout(toastTimer);
  toastRemaining = Math.max(0, toastRemaining - (Date.now() - toastStartedAt));
}

/** Let it run out again once the pointer leaves, with a little grace. */
export function resumePluginToast() {
  if (!pluginToast()) return;
  startToastTimer(Math.max(toastRemaining, 1500));
}

export function dismissPluginToast() {
  window.clearTimeout(toastTimer);
  setPluginToast(null);
}

// Reveal payloads wait here until the panel they are for has mounted and
// subscribed; a panel already open gets them straight away.
const pendingReveals = new Map<string, unknown>();
const revealListeners = new Map<string, Set<(payload: unknown) => void>>();

function reveal(pluginId: string, payload: unknown) {
  const listeners = revealListeners.get(pluginId);
  if (listeners?.size) {
    for (const cb of [...listeners]) {
      try {
        cb(payload);
      } catch (err) {
        console.error(`[plugin ${pluginId}] onReveal listener threw:`, err);
      }
    }
  } else {
    pendingReveals.set(pluginId, payload);
  }
}

export function onPluginReveal(pluginId: string, cb: (payload: unknown) => void): () => void {
  let set = revealListeners.get(pluginId);
  if (!set) revealListeners.set(pluginId, (set = new Set()));
  set.add(cb);
  if (pendingReveals.has(pluginId)) {
    const payload = pendingReveals.get(pluginId);
    pendingReveals.delete(pluginId);
    queueMicrotask(() => {
      if (set!.has(cb)) cb(payload);
    });
  }
  return () => {
    set!.delete(cb);
    if (set!.size === 0) revealListeners.delete(pluginId);
  };
}

/** The toast was clicked: open its plugin's view and hand over its payload. */
export function openPluginToast() {
  const active = pluginToast();
  if (!active) return;
  dismissPluginToast();
  if (active.toast.payload !== null) reveal(active.pluginId, active.toast.payload);
  showViewImpl(active.viewKey);
}

// --- storage -------------------------------------------------------------------
//
// api.storage: a small JSON object per plugin, in this origin's localStorage
// under `specterm.plugin.<id>`, and kept the same in every window through the
// store-sync channel the settings use. Small means small: a write that would
// take the plugin past STORAGE_MAX is refused, so no plugin can fill the
// storage the app itself depends on.

const STORAGE_PREFIX = "specterm.plugin.";
const STORAGE_MAX = 256 * 1024;
const storageListeners = new Map<string, Set<(key: string, value: unknown) => void>>();
const storageSynced = new Set<string>();

function readPluginStorage(pluginId: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_PREFIX + pluginId) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function notifyStorage(pluginId: string, key: string, value: unknown) {
  for (const cb of [...(storageListeners.get(pluginId) ?? [])]) {
    try {
      cb(key, value);
    } catch (err) {
      console.error(`[plugin ${pluginId}] storage listener threw:`, err);
    }
  }
}

// Another window wrote: tell this window's listeners about every key that
// now differs from what they last saw.
function syncStorage(pluginId: string) {
  if (storageSynced.has(pluginId)) return;
  storageSynced.add(pluginId);
  let seen = readPluginStorage(pluginId);
  registerStoreSync(`plugin:${pluginId}`, () => {
    const next = readPluginStorage(pluginId);
    for (const key of new Set([...Object.keys(seen), ...Object.keys(next)])) {
      if (JSON.stringify(seen[key]) !== JSON.stringify(next[key])) notifyStorage(pluginId, key, next[key]);
    }
    seen = next;
  });
}

export interface PluginStorage {
  get(key: string): unknown;
  /** JSON-serialisable values; `undefined` removes the key. Throws when the
   *  plugin's storage would grow past its limit. */
  set(key: string, value: unknown): void;
  /** Changes made in other windows. Returns the unsubscribe. */
  onChange(cb: (key: string, value: unknown) => void): () => void;
}

export function pluginStorage(pluginId: string): PluginStorage {
  syncStorage(pluginId);
  return {
    get: (key) => readPluginStorage(pluginId)[key],
    set(key, value) {
      const data = readPluginStorage(pluginId);
      if (value === undefined) delete data[key];
      else data[key] = JSON.parse(JSON.stringify(value));
      const raw = JSON.stringify(data);
      if (raw.length > STORAGE_MAX) throw new Error(`plugin storage is limited to ${STORAGE_MAX / 1024} KB`);
      localStorage.setItem(STORAGE_PREFIX + pluginId, raw);
      publishStoreChange(`plugin:${pluginId}`);
    },
    onChange(cb) {
      let set = storageListeners.get(pluginId);
      if (!set) storageListeners.set(pluginId, (set = new Set()));
      set.add(cb);
      return () => set!.delete(cb);
    },
  };
}

// The GitHub panel's watchlist used to be one of the app's settings. It is the
// GitHub plugin's own now; carried over once, the first time this version
// runs, before anything could write settings without it.
(function migrateGithubWatchlist() {
  try {
    if (localStorage.getItem(STORAGE_PREFIX + "github") !== null) return;
    const settings = JSON.parse(localStorage.getItem("specterm.settings") ?? "null");
    const list = settings?.githubWatchlist;
    if (!Array.isArray(list) || list.length === 0) return;
    const watchlist = list.filter((v: unknown) => typeof v === "string");
    localStorage.setItem(STORAGE_PREFIX + "github", JSON.stringify({ watchlist }));
  } catch (_) {
    /* Unreadable settings: nothing to carry over. */
  }
})();

// --- what panels and renderer modules can ask of the window ----------------------
//
// Set by App through initPlugins; read by PluginView and the renderer modules.

export const pluginHost = {
  openFile: (_path: string, _mode: "split" | "tab") => {},
  activeFile: (() => null) as () => string | null,
  revealHeading: (_index: number) => {},
  showView: (key: PluginViewKey) => showViewImpl(key),
};

// --- file-tree contributions (from renderer modules) -----------------------------
//
// A folder action is an item in the file tree's menu for a folder; a folder
// banner is a strip over the tree for the folder it is showing (the Vault's
// "Obsidian vault folder" offer). Both are asked about synchronously when the
// tree draws, and their answers come from the plugin's own state, which the
// core cannot watch: a plugin calls api.fileTree.refresh() when that state
// changes, and the tree asks again.

export interface FolderAction {
  pluginId: string;
  id: string;
  /** The item's label for this folder, or null to leave it out. */
  title(path: string): string | null;
  run(path: string): void;
}

export interface FolderBanner {
  pluginId: string;
  id: string;
  /** For the folder the tree shows and the names in it: what to offer, or null. */
  match(path: string, names: readonly string[]): { text: string; action: string } | null;
  run(path: string): void;
}

const [folderActions, setFolderActions] = createSignal<readonly FolderAction[]>([]);
const [folderBanners, setFolderBanners] = createSignal<readonly FolderBanner[]>([]);
const [fileTreeEpoch, setFileTreeEpoch] = createSignal(0);
export { folderActions, folderBanners, fileTreeEpoch };

// --- renderer modules -----------------------------------------------------------
//
// A plugin's renderer module is loaded in every window after its first paint,
// for what must exist before any of its views is open. It gets an api like the
// panel's, without the parts that only make sense in a view, and returns its
// dispose. Everything it registers is dropped when the plugin goes away,
// whether or not that dispose remembers to.

const rendererCommands = new Map<string, Map<string, () => void>>();

function runRendererCommand(pluginId: string, name: string) {
  const fn = rendererCommands.get(pluginId)?.get(name);
  if (!fn) {
    console.warn(`[plugin ${pluginId}] no renderer command "${name}" (still loading?)`);
    return;
  }
  try {
    fn();
  } catch (err) {
    console.error(`[plugin ${pluginId}] command "${name}" threw:`, err);
  }
}

interface LoadedRenderer {
  url: string;
  disposers: Set<() => void>;
  dispose: (() => void) | null;
  gone: boolean;
}

const renderers = new Map<string, LoadedRenderer>();
let renderersScheduled = false;

function scheduleRenderers() {
  if (renderersScheduled) return;
  renderersScheduled = true;
  const run = () => {
    renderersScheduled = false;
    void syncRenderers();
  };
  // After the window's first terminal has painted — not merely idle time,
  // which a window waiting on its shell has plenty of — and then in the next
  // idle slot, with a timeout so a busy window still gets them.
  void afterFirstTerminalRender().then(() => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 1000 });
    else setTimeout(run, 200);
  });
}

function unloadRenderer(pluginId: string) {
  const loaded = renderers.get(pluginId);
  if (!loaded) return;
  renderers.delete(pluginId);
  loaded.gone = true;
  try {
    loaded.dispose?.();
  } catch (err) {
    console.error(`[plugin ${pluginId}] renderer dispose threw:`, err);
  }
  for (const off of loaded.disposers) off();
  rendererCommands.delete(pluginId);
  setFolderActions((list) => list.filter((a) => a.pluginId !== pluginId));
  setFolderBanners((list) => list.filter((b) => b.pluginId !== pluginId));
}

async function syncRenderers() {
  const wanted = new Map(
    contributions()
      .filter((p) => p.renderer)
      .map((p) => [p.id, p] as const)
  );
  for (const [id, loaded] of [...renderers]) {
    if (wanted.get(id)?.renderer !== loaded.url) unloadRenderer(id);
  }
  for (const [id, plugin] of wanted) {
    if (renderers.has(id)) continue;
    const loaded: LoadedRenderer = { url: plugin.renderer!, disposers: new Set(), dispose: null, gone: false };
    renderers.set(id, loaded);
    try {
      const mod = await import(/* @vite-ignore */ plugin.renderer!);
      if (loaded.gone) continue;
      if (typeof mod.activate !== "function") throw new Error("the renderer module must export activate(api)");
      const result = await mod.activate(rendererApi(plugin, loaded));
      if (typeof result === "function") {
        if (loaded.gone) result();
        else loaded.dispose = result;
      }
    } catch (err) {
      console.error(`[plugin ${id}] renderer module failed:`, err);
    }
  }
}

/** What a renderer module's activate(api) gets (API 1.3). */
export type PluginRendererApi = ReturnType<typeof rendererApi>;

function rendererApi(plugin: PluginContribution, loaded: LoadedRenderer) {
  const id = plugin.id;
  const track = (off: () => void) => {
    loaded.disposers.add(off);
    return () => {
      off();
      loaded.disposers.delete(off);
    };
  };
  const storage = pluginStorage(id);
  return {
    apiVersion: "1.3" as const,
    pluginId: id,
    invoke: (method: string, ...args: unknown[]) => invokePlugin(id, method, args),
    on: (event: string, cb: (payload: unknown) => void) => track(onPluginEvent(id, event, cb)),
    storage: {
      get: storage.get,
      set: storage.set,
      onChange: (cb: (key: string, value: unknown) => void) => track(storage.onChange(cb)),
    },
    showView: (viewId: string) => pluginHost.showView(viewKey(id, viewId)),
    openFile: (path: string, mode: "tab" | "split" = "tab") => pluginHost.openFile(path, mode),
    commands: {
      register(name: string, fn: () => void) {
        let map = rendererCommands.get(id);
        if (!map) rendererCommands.set(id, (map = new Map()));
        map.set(name, fn);
        return track(() => rendererCommands.get(id)?.delete(name));
      },
    },
    fileTree: {
      addFolderAction(action: Omit<FolderAction, "pluginId">) {
        const entry = { ...action, pluginId: id };
        setFolderActions((list) => [...list, entry]);
        return track(() => setFolderActions((list) => list.filter((a) => a !== entry)));
      },
      addFolderBanner(banner: Omit<FolderBanner, "pluginId">) {
        const entry = { ...banner, pluginId: id };
        setFolderBanners((list) => [...list, entry]);
        return track(() => setFolderBanners((list) => list.filter((b) => b !== entry)));
      },
      /** Ask the tree to re-read every action and banner. */
      refresh: () => setFileTreeEpoch((n) => n + 1),
    },
  };
}

// The vault list was the app's own (`specterm.vaults`); it is the Vault
// plugin's now. Carried over once, the same way as the GitHub watchlist.
(function migrateVaults() {
  try {
    if (localStorage.getItem(STORAGE_PREFIX + "vault") !== null) return;
    const list = JSON.parse(localStorage.getItem("specterm.vaults") ?? "null");
    if (!Array.isArray(list) || list.length === 0) return;
    localStorage.setItem(STORAGE_PREFIX + "vault", JSON.stringify({ vaults: list }));
  } catch (_) {
    /* Unreadable: nothing to carry over. */
  }
})();

// --- shortcuts ---------------------------------------------------------------

let registeredIds = new Set<string>();
let toggleViewImpl: (key: PluginViewKey) => void = () => {};
let showViewImpl: (key: PluginViewKey) => void = () => {};
let isViewOpenImpl: (key: PluginViewKey) => boolean = () => false;

// Plugin rows go in after the core's and the dispatcher takes the first match,
// so a plugin can never take a chord the app already answers to.
function syncBindings(list: readonly PluginContribution[]) {
  unregisterBindings(registeredIds);
  const rows: BindingSpec[] = list.flatMap((p) =>
    p.commands.map((c) => ({
      id: `plugin.${p.id}.${c.id}`,
      key: c.key,
      ...cmd({ shift: c.shift }),
      allowInInput: true,
      label: `${p.name}: ${c.title}`,
      run: () => {
        if (c.toggleView) toggleViewImpl(viewKey(p.id, c.toggleView));
        else if (c.toggleOverlay) toggleOverlay(viewKey(p.id, c.toggleOverlay));
        else if (c.run) runRendererCommand(p.id, c.run);
        else if (c.invoke) {
          invokePlugin(p.id, c.invoke, []).catch((err) =>
            console.error(`[plugin ${p.id}] ${c.invoke} failed:`, err)
          );
        }
      },
    }))
  );
  registeredIds = new Set(rows.map((r) => r.id));
  registerBindings(rows);
}

// --- lifecycle ----------------------------------------------------------------

let initialized = false;

/**
 * Wire this window to the plugin host. Called once from App's onMount, after
 * the core keymap is registered. Nothing here blocks: the shortcuts come from
 * the boot answer, and the subscriptions resolve whenever they resolve.
 */
export function initPlugins(opts: {
  toggleView: (key: PluginViewKey) => void;
  showView: (key: PluginViewKey) => void;
  isViewOpen: (key: PluginViewKey) => boolean;
  openFile: (path: string, mode: "split" | "tab") => void;
  // The file shown in the active pane, or null for a terminal. Tracked.
  activeFile: () => string | null;
  // Scroll the active pane's rendered markdown to its Nth heading.
  revealHeading: (index: number) => void;
}) {
  if (initialized) return;
  initialized = true;
  toggleViewImpl = opts.toggleView;
  showViewImpl = opts.showView;
  isViewOpenImpl = opts.isViewOpen;
  pluginHost.openFile = opts.openFile;
  pluginHost.activeFile = opts.activeFile;
  pluginHost.revealHeading = opts.revealHeading;
  syncBindings(contributions());
  // Renderer modules come in after the first paint, never in front of it.
  scheduleRenderers();

  const applyChange = (change: PluginsChanged) => {
    // Most launches: the boot answer was right and nothing moves.
    if (JSON.stringify(change.contributions) !== JSON.stringify(contributions())) {
      setContributions(change.contributions);
      syncBindings(change.contributions);
      scheduleRenderers();
      if (openOverlay() && !findPluginOverlay(openOverlay())) closeOverlay();
    }
    setPluginList(change.plugins);
    // A plugin that went away takes its badge, toast and pending reveal with it.
    const live = new Set(change.contributions.map((p) => p.id));
    setBadges((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => live.has(id))));
    const toast = pluginToast();
    if (toast && !live.has(toast.pluginId)) dismissPluginToast();
    for (const id of [...pendingReveals.keys()]) if (!live.has(id)) pendingReveals.delete(id);
  };

  void getBackend().then(async (backend) => {
    await backend.onPluginsChanged(applyChange);
    await backend.onPluginBadge((id, value) =>
      setBadges((prev) => {
        const next = { ...prev };
        if (value === null) delete next[id];
        else next[id] = value;
        return next;
      })
    );
    await backend.onPluginEvent(dispatchEvent);
    await backend.onPluginToast(showToast);
    // Catch up on whatever was published before this window was listening:
    // discovery finishing, badges set before it existed. The answer is newer
    // than any event that reached us before it, and events after it are
    // applied after it, so it simply replaces what is here.
    const state = await backend.pluginsState();
    applyChange(state);
    setBadges({ ...state.badges });
  });
}

export async function loadPluginList(): Promise<void> {
  const backend = await getBackend();
  setPluginList(await backend.pluginsList());
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  const backend = await getBackend();
  setPluginList(await backend.pluginsSetEnabled(id, enabled));
}

// The plugin's id once it is installed and on. Its buttons and views arrive
// through onPluginsChanged like any other plugin's.
export async function installPlugin(source: string): Promise<string> {
  const backend = await getBackend();
  const { id, plugins } = await backend.pluginsInstall(source);
  setPluginList(plugins);
  return id;
}

export async function removePlugin(id: string): Promise<void> {
  const backend = await getBackend();
  setPluginList(await backend.pluginsRemove(id));
}
