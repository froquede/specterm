import {
  createSignal,
  createResource,
  createEffect,
  createMemo,
  For,
  Show,
  onMount,
} from "solid-js";
import { getBackend } from "../backends";
import type { FileEntry } from "../backends/types";
import { isAccelClick } from "../lib/platform";
import { favorites, toggleFavorite, favoriteByIndex } from "../stores/favorites";

// A "fav-N" token in the search box (full or partial, e.g. "fav-", "fav-2")
// is a cd command, not a name filter — used both to suppress filtering while
// it's being typed and to resolve it on Enter.
const FAV_TOKEN = /^fav-\d*$/i;

interface FileTreeProps {
  open: boolean;
  width: number;
  onOpenFile: (path: string, mode: "split" | "tab") => void;
  // Run `cd <path>` in the active terminal pane (favorite click / "fav-N").
  onCdPath: (path: string) => void;
  // Return focus to the grid/terminal (Esc on an already-empty filter).
  onDismiss?: () => void;
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
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  let listEl: HTMLDivElement | undefined;
  const [entries, { refetch }] = createResource(currentPath, (path) =>
    path ? listDir(path) : Promise.resolve([])
  );

  // O(1) favorite lookups: a single derived Set instead of an O(n) array scan
  // per cell (each row queries it 3×, and it re-runs on every toggle).
  const favSet = createMemo(() => new Set(favorites().map((f) => f.path)));
  const isFav = (path: string) => favSet().has(path);

  onMount(async () => {
    const backend = await getBackend();
    const home = await backend.getHomePath();
    setCurrentPath(home);
  });

  function navigateTo(path: string) {
    setCurrentPath(path);
    setFilter("");
    setSelectedIndex(0);
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

  function activateEntry(entry: DirEntry, mode: "split" | "tab") {
    if (entry.isDirectory) {
      navigateTo(entry.path);
    } else if (entry.name.endsWith(".md")) {
      props.onOpenFile(entry.path, mode);
    }
  }

  function handleClick(entry: DirEntry, e: MouseEvent) {
    activateEntry(entry, isAccelClick(e) ? "tab" : "split");
  }

  // Memoized: filter runs once per (entries, filter) change instead of on each
  // of its call sites (For, ghost text, the selection effect, key handlers).
  const filteredEntries = createMemo<DirEntry[]>(() => {
    const all = entries() || [];
    const q = filter().trim();
    // While a "fav-N" command is being typed, don't filter the listing — it's
    // headed for the active terminal, not the tree, so leave the dir visible.
    if (!q || FAV_TOKEN.test(q)) return all;
    const lower = q.toLowerCase();
    return all.filter((e) => e.name.toLowerCase().includes(lower));
  });

  // Sugestão inline (ghost text): nome do item selecionado quando o filtro
  // é um prefixo dele — é a parte que o Tab completa.
  function ghostSuffix(): string {
    const sel = filteredEntries()[selectedIndex()];
    const q = filter();
    if (!sel || !q) return "";
    if (sel.name.toLowerCase().startsWith(q.toLowerCase())) {
      return sel.name.slice(q.length);
    }
    return "";
  }

  function handleFilterKeyDown(e: KeyboardEvent) {
    const list = filteredEntries();

    if (e.key === "Escape") {
      // Esc progressivo: 1º limpa o filtro (mantendo o foco pra refiltrar);
      // já vazio, 2º sai e devolve o foco ao grid/terminal.
      if (filter()) {
        setFilter("");
        setSelectedIndex(0);
      } else {
        (e.currentTarget as HTMLInputElement).blur();
        props.onDismiss?.();
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (list.length) setSelectedIndex((i) => (i + 1) % list.length);
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (list.length)
        setSelectedIndex((i) => (i - 1 + list.length) % list.length);
      return;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      if (!list.length) return;
      const sel = list[selectedIndex()];
      // 1º Tab completa o filtro com o nome do item selecionado;
      // se já estiver completo, avança para o próximo match.
      if (sel && filter().toLowerCase() === sel.name.toLowerCase()) {
        const next = e.shiftKey
          ? (selectedIndex() - 1 + list.length) % list.length
          : (selectedIndex() + 1) % list.length;
        setSelectedIndex(next);
        setFilter(list[next].name);
      } else if (sel) {
        setFilter(sel.name);
      }
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      // A "fav-N" token cds the active terminal instead of opening a tree row.
      const fav = resolveFavToken(filter());
      if (fav) {
        openFavorite(fav.path);
        (e.currentTarget as HTMLInputElement).blur();
        return;
      }
      const sel = list[selectedIndex()];
      if (sel) activateEntry(sel, e.metaKey || e.ctrlKey ? "tab" : "split");
      return;
    }
  }

  // Mantém o índice válido e o item selecionado visível ao filtrar/navegar.
  createEffect(() => {
    const len = filteredEntries().length;
    if (selectedIndex() >= len) setSelectedIndex(len > 0 ? len - 1 : 0);
    const node = listEl?.querySelector<HTMLElement>(".file-tree-entry.is-selected");
    node?.scrollIntoView({ block: "nearest" });
  });

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
          <Show when={currentPath()}>
            <button
              class="file-tree-fav-toggle"
              classList={{ active: isFav(currentPath()) }}
              title={
                isFav(currentPath())
                  ? "Remove this folder from favorites"
                  : "Favorite this folder"
              }
              onClick={() => toggleFavorite(currentPath())}
            >
              {isFav(currentPath()) ? "★" : "☆"}
            </button>
          </Show>
          <button class="file-tree-refresh" onClick={() => refetch()}>
            ↻
          </button>
        </div>
        <div class="file-tree-search">
          <div class="file-tree-search-field">
            <input
              type="text"
              placeholder="Filter…  (fav-1, fav-2, … + Enter to cd)"
              value={filter()}
              onInput={(e) => {
                setFilter(e.currentTarget.value);
                setSelectedIndex(0);
              }}
              onKeyDown={handleFilterKeyDown}
            />
            <Show when={ghostSuffix()}>
              <div class="file-tree-search-ghost" aria-hidden="true">
                <span class="ghost-typed">{filter()}</span>
                <span class="ghost-suffix">{ghostSuffix()}</span>
              </div>
            </Show>
          </div>
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
        <div class="file-tree-content" ref={listEl}>
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
              {(entry, index) => {
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
                    }${index() === selectedIndex() ? " is-selected" : ""}`}
                    onClick={(e) => isClickable && handleClick(entry, e)}
                    onMouseEnter={() => setSelectedIndex(index())}
                    title={entry.path}
                  >
                    <span class="file-tree-icon">
                      {entry.isDirectory ? "▸" : isMd ? "◆" : "·"}
                    </span>
                    <span class="file-tree-name">{entry.name}</span>
                    <Show when={entry.isDirectory}>
                      <button
                        class="file-tree-entry-fav"
                        classList={{ active: isFav(entry.path) }}
                        title={
                          isFav(entry.path)
                            ? "Remove from favorites"
                            : "Add to favorites"
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFavorite(entry.path);
                        }}
                      >
                        {isFav(entry.path) ? "★" : "☆"}
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
