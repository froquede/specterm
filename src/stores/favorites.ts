import { createSignal } from "solid-js";

// Favorite directories the user pins from the file tree. Persisted to
// localStorage so they survive restarts. Order is meaningful: the first entry
// is "fav-1", the second "fav-2", etc. — typing that token in the sidebar
// search jumps straight to it.

const STORAGE_KEY = "specterm.favorites";

export interface Favorite {
  path: string;
  label: string;
}

function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return (i >= 0 ? trimmed.slice(i + 1) : trimmed) || "/";
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
        path: f.path as string,
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
  return favorites().some((f) => f.path === path);
}

export function addFavorite(path: string, label?: string) {
  if (isFavorite(path)) return;
  commit([...favorites(), { path, label: label || basename(path) }]);
}

export function removeFavorite(path: string) {
  commit(favorites().filter((f) => f.path !== path));
}

export function toggleFavorite(path: string, label?: string) {
  if (isFavorite(path)) removeFavorite(path);
  else addFavorite(path, label);
}

/** 1-based lookup matching the "fav-N" search token. */
export function favoriteByIndex(oneBased: number): Favorite | undefined {
  return favorites()[oneBased - 1];
}
