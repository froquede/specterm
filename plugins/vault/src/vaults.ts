import { createRoot, createSignal } from "solid-js";
import { basename, normalize, equalPath, isInside } from "../../../src/lib/fspath";

// Vaults: folders of notes the plugin indexes, so a note can be opened by name,
// searched by its text and asked who links to it.
//
// Deliberately not favorites. A favorite is a jump target — ~/Downloads is a
// fine one — and costs nothing to keep. A vault is a commitment to read every
// markdown file under it, so it is its own explicit list, added from the file
// tree's menu and never inferred from anything else.
//
// The list lives in the plugin's storage (api.storage), which Specterm keeps
// the same in every window. Which vault a window is looking at is that window's
// own business and is not stored. Moved from src/stores/vaults.ts.
//
// This module is shared by the renderer module and the panel (one bundle,
// one copy in the window), so the file tree's menu and the panel agree.

export interface Vault {
  path: string;
  label: string;
}

export interface VaultStorage {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  onChange(cb: (key: string, value: unknown) => void): () => void;
}

function parse(value: unknown): Vault[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v) => v && typeof v.path === "string")
    .map((v) => ({
      path: normalize(v.path as string),
      label: typeof v.label === "string" && v.label ? v.label : basename(v.path as string),
    }));
}

const state = createRoot(() => {
  const [vaults, setVaults] = createSignal<Vault[]>([]);
  // The vault this window last chose explicitly (clicked in the panel, or
  // just opened). The panel follows the active note when it lives in a vault,
  // and falls back to this when it doesn't.
  const [selectedVault, setSelectedVault] = createSignal<string | null>(null);
  return { vaults, setVaults, selectedVault, setSelectedVault };
});

export const { vaults, selectedVault, setSelectedVault } = state;

let storage: VaultStorage | null = null;
const changeListeners = new Set<() => void>();

/** Told when the list changes, here or in another window. */
export function onVaultsChanged(cb: () => void): () => void {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}
const notify = () => changeListeners.forEach((cb) => cb());

/**
 * Read the list from the plugin's storage and follow it. Called by the
 * renderer module and by each mounted view. Their storages are the same store,
 * but each one's subscriptions end with its owner (Specterm drops a view's on
 * unmount), so the list follows whichever attacher is still around.
 */
const attachers: VaultStorage[] = [];
let unsubscribe: (() => void) | null = null;

function follow(next: VaultStorage | null) {
  unsubscribe?.();
  unsubscribe = null;
  storage = next;
  if (!next) return;
  state.setVaults(parse(next.get("vaults")));
  unsubscribe = next.onChange((key, value) => {
    if (key !== "vaults") return;
    state.setVaults(parse(value));
    notify();
  });
}

export function attachStorage(next: VaultStorage): () => void {
  attachers.push(next);
  if (!storage) follow(next);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    attachers.splice(attachers.indexOf(next), 1);
    if (storage === next) follow(attachers[0] ?? null);
  };
}

function commit(list: Vault[]) {
  state.setVaults(list);
  storage?.set("vaults", list);
  notify();
}

export function isVault(path: string): boolean {
  return state.vaults().some((v) => equalPath(v.path, path));
}

export function addVault(path: string) {
  const p = normalize(path).replace(/(.)[\\/]+$/, "$1");
  if (isVault(p)) return;
  commit([...state.vaults(), { path: p, label: basename(p) }]);
}

export function removeVault(path: string) {
  commit(state.vaults().filter((v) => !equalPath(v.path, path)));
  if (equalPath(state.selectedVault() ?? "", path)) state.setSelectedVault(null);
}

/** The vault a path lives in — the innermost one, when vaults are nested. */
export function vaultFor(path: string): Vault | undefined {
  let best: Vault | undefined;
  for (const v of state.vaults()) {
    if (isInside(path, v.path) && (!best || v.path.length > best.path.length)) best = v;
  }
  return best;
}

/** Which vault the panel and quick open act on, given the active file. */
export function currentVault(activeFile: string | null): Vault | undefined {
  if (activeFile) {
    const owning = vaultFor(activeFile);
    if (owning) return owning;
  }
  const sel = state.selectedVault();
  if (sel) {
    const v = state.vaults().find((x) => equalPath(x.path, sel));
    if (v) return v;
  }
  return state.vaults()[0];
}
