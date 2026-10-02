import { createSignal } from "solid-js";
import { getBackend, windowBoot } from "../backends";
import type {
  PluginBadge,
  PluginContribution,
  PluginInfo,
  PluginSidebarView,
  PluginsChanged,
} from "../backends/types";
import type { PluginViewKey } from "../types";
import { cmd } from "../lib/platform";
import {
  registerBindings,
  unregisterBindings,
  type BindingSpec,
} from "./keybindings";

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

// --- shortcuts ---------------------------------------------------------------

let registeredIds = new Set<string>();
let toggleViewImpl: (key: PluginViewKey) => void = () => {};

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
export function initPlugins(opts: { toggleView: (key: PluginViewKey) => void }) {
  if (initialized) return;
  initialized = true;
  toggleViewImpl = opts.toggleView;
  syncBindings(contributions());

  const applyChange = (change: PluginsChanged) => {
    // Most launches: the boot answer was right and nothing moves.
    if (JSON.stringify(change.contributions) !== JSON.stringify(contributions())) {
      setContributions(change.contributions);
      syncBindings(change.contributions);
    }
    setPluginList(change.plugins);
    // A plugin that went away takes its badge with it.
    const live = new Set(change.contributions.map((p) => p.id));
    setBadges((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => live.has(id))));
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
