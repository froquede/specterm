import { createSignal } from "solid-js";
import { basename, normalize, equalPath } from "../lib/fspath";

// Favorite directories the user pins from the file tree. Persisted to
// localStorage so they survive restarts. Order is meaningful: the first entry
// is "fav-1", the second "fav-2", etc. — typing that token in the sidebar
// search jumps straight to it.

const STORAGE_KEY = "specterm.favorites";

export interface Favorite {
  path: string;
  label: string;
}

function load(): Favorite[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((f) => f && typeof f.path === "string")
      .map((f) => ({
        // Normalize on load: older favorites were saved with "/" separators, so
        // on Windows they must be converted to "\" to match freshly-built paths.
        path: normalize(f.path as string),
        label:
          typeof f.label === "string" && f.label
            ? f.label
            : basename(f.path as string),
      }));
  } catch (_) {
    // Corrupt or unavailable storage — start empty.
    return [];
  }
}

function persist(list: Favorite[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch (_) {
    // localStorage unavailable — favorites just won't survive this session.
  }
}

const [favorites, setFavoritesSignal] = createSignal<Favorite[]>(load());

function commit(list: Favorite[]) {
  setFavoritesSignal(list);
  persist(list);
}

export { favorites };

export function isFavorite(path: string): boolean {
  return favorites().some((f) => equalPath(f.path, path));
}

export function addFavorite(path: string, label?: string) {
  const p = normalize(path);
  if (isFavorite(p)) return;
  commit([...favorites(), { path: p, label: label || basename(p) }]);
}

export function removeFavorite(path: string) {
  commit(favorites().filter((f) => !equalPath(f.path, path)));
}

export function toggleFavorite(path: string, label?: string) {
  if (isFavorite(path)) removeFavorite(path);
  else addFavorite(path, label);
}

/** 1-based lookup matching the "fav-N" search token. */
export function favoriteByIndex(oneBased: number): Favorite | undefined {
  return favorites()[oneBased - 1];
}
