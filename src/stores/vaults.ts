import { createSignal } from "solid-js";
import { basename, normalize, equalPath, isInside } from "../lib/fspath";
import { publishStoreChange, registerStoreSync } from "../lib/store-sync";

// Vaults: folders of notes the app indexes, so a note can be opened by name,
// searched by its text and asked who links to it.
//
// Deliberately not favorites. A favorite is a jump target — ~/Downloads is a
// fine one — and costs nothing to keep. A vault is a commitment to read every
// markdown file under it, so it is its own explicit list, added from the file
// tree's menu and never inferred from anything else.
//
// The list is persisted and mirrored to every window, the same way favorites
// are. Which vault a window is looking at is that window's own business and is
// not synced.

const STORAGE_KEY = "specterm.vaults";

export interface Vault {
  path: string;
  label: string;
}

function load(): Vault[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v) => v && typeof v.path === "string")
      .map((v) => ({
        path: normalize(v.path as string),
        label:
          typeof v.label === "string" && v.label
            ? v.label
            : basename(v.path as string),
      }));
  } catch (_) {
    return [];
  }
}

function persist(list: Vault[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch (_) {
    // localStorage unavailable — the vault list just won't survive a restart.
  }
  publishStoreChange("vaults");
}

const [vaults, setVaultsSignal] = createSignal<Vault[]>(load());

// Told when a vault leaves the list (here or in another window), so whoever
// holds its index can drop it. The index lives in stores/vault-index, which is
// only loaded with the vault panel or quick open; it registers itself here
// rather than being imported, so the file tree doesn't pull it into the boot
// bundle just to show a menu item.
const removalListeners = new Set<() => void>();
export function onVaultsRemoved(cb: () => void): () => void {
  removalListeners.add(cb);
  return () => removalListeners.delete(cb);
}
const notifyRemoved = () => removalListeners.forEach((cb) => cb());

registerStoreSync("vaults", () => {
  setVaultsSignal(load());
  notifyRemoved();
});

function commit(list: Vault[]) {
  setVaultsSignal(list);
  persist(list);
}

export { vaults };

export function isVault(path: string): boolean {
  return vaults().some((v) => equalPath(v.path, path));
}

export function addVault(path: string) {
  const p = normalize(path).replace(/(.)[\\/]+$/, "$1");
  if (isVault(p)) return;
  commit([...vaults(), { path: p, label: basename(p) }]);
}

export function removeVault(path: string) {
  commit(vaults().filter((v) => !equalPath(v.path, path)));
  if (equalPath(selectedVault() ?? "", path)) setSelectedVault(null);
  notifyRemoved();
}

/** The vault a path lives in — the innermost one, when vaults are nested. */
export function vaultFor(path: string): Vault | undefined {
  let best: Vault | undefined;
  for (const v of vaults()) {
    if (isInside(path, v.path) && (!best || v.path.length > best.path.length)) {
      best = v;
    }
  }
  return best;
}

// The vault this window last chose explicitly (clicked in the panel, or just
// opened). The panel follows the active note when it lives in a vault, and
// falls back to this when it doesn't.
const [selectedVault, setSelectedVault] = createSignal<string | null>(null);
export { selectedVault, setSelectedVault };

/** Which vault the panel and quick open act on, given the active file. */
export function currentVault(activeFile: string | null): Vault | undefined {
  if (activeFile) {
    const owning = vaultFor(activeFile);
    if (owning) return owning;
  }
  const sel = selectedVault();
  if (sel) {
    const v = vaults().find((x) => equalPath(x.path, sel));
    if (v) return v;
  }
  return vaults()[0];
}

// --- Quick open ------------------------------------------------------------

const [quickOpenVisible, setQuickOpenVisible] = createSignal(false);
export { quickOpenVisible, setQuickOpenVisible };
