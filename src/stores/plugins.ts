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

export interface PluginButton {
  pluginId: string;
  viewKey: PluginViewKey;
  icon: string;
  title: string;
}

export function pluginButtons(): PluginButton[] {
  return contributions().flatMap((p) =>
    p.tabBarButton
      ? [
          {
            pluginId: p.id,
            viewKey: viewKey(p.id, p.tabBarButton.view),
            icon: p.tabBarButton.icon,
            title: p.tabBarButton.title,
          },
        ]
      : []
  );
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
}) {
  if (initialized) return;
  initialized = true;
  toggleViewImpl = opts.toggleView;
  showViewImpl = opts.showView;
  isViewOpenImpl = opts.isViewOpen;
  syncBindings(contributions());

  const applyChange = (change: PluginsChanged) => {
    // Most launches: the boot answer was right and nothing moves.
    if (JSON.stringify(change.contributions) !== JSON.stringify(contributions())) {
      setContributions(change.contributions);
      syncBindings(change.contributions);
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
