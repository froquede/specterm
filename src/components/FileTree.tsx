import { createSignal, createResource, For, Show, onMount } from "solid-js";
import { getBackend } from "../backends";
import type { FileEntry } from "../backends/types";
import { isAccelClick } from "../lib/platform";
import {
  favorites,
  isFavorite,
  toggleFavorite,
  favoriteByIndex,
} from "../stores/favorites";

interface FileTreeProps {
  open: boolean;
  width: number;
  onOpenFile: (path: string, mode: "split" | "tab") => void;
  // Run `cd <path>` in the active terminal pane.
  onCdPath: (path: string) => void;
}

interface DirEntry extends FileEntry {
  path: string;
}

async function listDir(dirPath: string): Promise<DirEntry[]> {
  const backend = await getBackend();
  const entries = await backend.readDir(dirPath);

  return entries
    .map((e) => ({
      ...e,
      path: dirPath + "/" + e.name,
    }))
    .sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });
}

export default function FileTree(props: FileTreeProps) {
  const [currentPath, setCurrentPath] = createSignal("");
  const [filter, setFilter] = createSignal("");
  const [entries, { refetch }] = createResource(currentPath, (path) =>
    path ? listDir(path) : Promise.resolve([])
  );

  onMount(async () => {
    const backend = await getBackend();
    const home = await backend.getHomePath();
    setCurrentPath(home);
  });

  function navigateTo(path: string) {
    setCurrentPath(path);
    setFilter("");
  }

  // Jump to a favorite: cd the active terminal there and browse it in the tree.
  function openFavorite(path: string) {
    props.onCdPath(path);
    navigateTo(path);
  }

  // "fav-N" in the search box resolves to the Nth favorite (1-based).
  function resolveFavToken(value: string) {
    const m = value.trim().match(/^fav-(\d+)$/i);
    if (!m) return undefined;
    return favoriteByIndex(parseInt(m[1], 10));
  }

  function navigateUp() {
    const current = currentPath();
    const parent = current.substring(0, current.lastIndexOf("/")) || "/";
    navigateTo(parent);
  }

  function handleClick(entry: DirEntry, e: MouseEvent) {
    if (entry.isDirectory) {
      navigateTo(entry.path);
    } else if (entry.name.endsWith(".md")) {
      const mode = isAccelClick(e) ? "tab" : "split";
      props.onOpenFile(entry.path, mode);
    }
  }

  function filteredEntries(): DirEntry[] {
    const all = entries() || [];
    const q = filter().toLowerCase();
    if (!q) return all;
    return all.filter((e) => e.name.toLowerCase().includes(q));
  }

  function displayPath(): string {
    const p = currentPath();
    const home = p.match(/^\/home\/[^/]+/)?.[0];
    if (home && p.startsWith(home)) {
      return "~" + p.slice(home.length);
    }
    return p;
  }

  return (
    <Show when={props.open}>
      <div class="file-tree" style={{ width: `${props.width}px` }}>
        <div class="file-tree-header">
          <span class="file-tree-path" title={currentPath()}>
            {displayPath()}
          </span>
          <button
            class="file-tree-fav-toggle"
            classList={{ active: isFavorite(currentPath()) }}
            title={
              isFavorite(currentPath())
                ? "Remove this folder from favorites"
                : "Favorite this folder"
            }
            onClick={() => toggleFavorite(currentPath())}
          >
            {isFavorite(currentPath()) ? "★" : "☆"}
          </button>
          <button class="file-tree-refresh" onClick={() => refetch()}>
            ↻
          </button>
        </div>
        <div class="file-tree-search">
          <input
            type="text"
            placeholder="Filter…  (fav-1, fav-2, … + Enter to cd)"
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setFilter("");
                e.currentTarget.blur();
              } else if (e.key === "Enter") {
                const fav = resolveFavToken(filter());
                if (fav) {
                  e.preventDefault();
                  openFavorite(fav.path);
                  e.currentTarget.blur();
                }
              }
            }}
          />
        </div>
        <Show when={favorites().length > 0}>
          <div class="file-tree-favorites">
            <For each={favorites()}>
              {(fav, i) => (
                <div
                  class="file-tree-fav"
                  classList={{ active: fav.path === currentPath() }}
                  title={fav.path}
                  onClick={() => openFavorite(fav.path)}
                >
                  <span class="file-tree-fav-index">fav-{i() + 1}</span>
                  <span class="file-tree-fav-label">{fav.label}</span>
                  <button
                    class="file-tree-fav-remove"
                    title="Remove favorite"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFavorite(fav.path);
                    }}
                  >
                    ✕
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
        <div class="file-tree-content">
          <Show when={!filter()}>
            <div class="file-tree-entry file-tree-dir" onClick={navigateUp}>
              <span class="file-tree-icon">▴</span>
              ..
            </div>
          </Show>

          <Show
            when={!entries.loading}
            fallback={<div class="file-tree-loading">Loading...</div>}
          >
            <For each={filteredEntries()}>
              {(entry) => {
                const isMd = !entry.isDirectory && entry.name.endsWith(".md");
                const isClickable = entry.isDirectory || isMd;

                return (
                  <div
                    class={`file-tree-entry ${
                      entry.isDirectory
                        ? "file-tree-dir"
                        : isMd
                          ? "file-tree-md"
                          : "file-tree-other"
                    }`}
                    onClick={(e) => isClickable && handleClick(entry, e)}
                    title={entry.path}
                  >
                    <span class="file-tree-icon">
                      {entry.isDirectory ? "▸" : isMd ? "◆" : "·"}
                    </span>
                    <span class="file-tree-name">{entry.name}</span>
                    <Show when={entry.isDirectory}>
                      <button
                        class="file-tree-entry-fav"
                        classList={{ active: isFavorite(entry.path) }}
                        title={
                          isFavorite(entry.path)
                            ? "Remove from favorites"
                            : "Add to favorites"
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFavorite(entry.path);
                        }}
                      >
                        {isFavorite(entry.path) ? "★" : "☆"}
                      </button>
                    </Show>
                  </div>
                );
              }}
            </For>
            <Show when={filteredEntries().length === 0}>
              <div class="file-tree-empty">
                {filter() ? "No matches" : "Empty directory"}
              </div>
            </Show>
          </Show>
        </div>
      </div>
    </Show>
  );
}
