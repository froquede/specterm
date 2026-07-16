import {
  createSignal,
  createResource,
  createEffect,
  createMemo,
  For,
  Show,
  onMount,
  onCleanup,
} from "solid-js";
import { Portal } from "solid-js/web";
import { getBackend } from "../backends";
import type { FileEntry } from "../backends/types";
import { isAccelClick, os } from "../lib/platform";
import { join, dirname, normalize, equalPath } from "../lib/fspath";
import { favorites, toggleFavorite, favoriteByIndex } from "../stores/favorites";
import {
  startupPath,
  lastBrowsedPath,
  setLastBrowsedPath,
} from "../stores/settings";

const WIN = os === "windows";

// A "fav-N" token in the search box (full or partial, e.g. "fav-", "fav-2")
// is a cd command, not a name filter — used both to suppress filtering while
// it's being typed and to resolve it on Enter.
const FAV_TOKEN = /^fav-\d*$/i;

interface FileTreeProps {
  open: boolean;
  onOpenFile: (path: string, mode: "split" | "tab") => void;
  // Run `cd <path>` in the active terminal pane (favorite click / "fav-N" /
  // the "open terminal here" button).
  onCdPath: (path: string) => void;
  // Return focus to the grid/terminal (Esc on an already-empty filter).
  onDismiss?: () => void;
}

interface DirEntry extends FileEntry {
  path: string;
}

interface Crumb {
  label: string;
  path?: string; // navigate here; absent = current (non-clickable) segment
  drives?: boolean; // "This PC" — open the drive list instead
}

async function listDir(dirPath: string): Promise<DirEntry[]> {
  const backend = await getBackend();
  const entries = await backend.readDir(dirPath);

  return entries
    .map((e) => ({
      ...e,
      path: join(dirPath, e.name),
    }))
    .sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });
}

// True when `p` is `h` itself or a descendant of it (separator-aware,
// case-insensitive on Windows). Used to collapse the home prefix to "~".
function underHome(p: string, h: string): boolean {
  const hn = normalize(h).replace(/[\\/]+$/, "");
  if (!hn) return false;
  const pn = normalize(p);
  if (equalPath(pn, hn)) return true;
  const boundary = pn.charAt(hn.length);
  return (
    (boundary === "\\" || boundary === "/") &&
    equalPath(pn.slice(0, hn.length), hn)
  );
}

export default function FileTree(props: FileTreeProps) {
  const [currentPath, setCurrentPath] = createSignal("");
  const [drivesView, setDrivesView] = createSignal(false);
  const [home, setHome] = createSignal("");
  const [filter, setFilter] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  // Right-click context menu: the row it targets plus where to anchor it
  // (viewport coordinates, since it's portalled to <body>). Null = closed.
  const [menu, setMenu] = createSignal<{
    x: number;
    y: number;
    entry: DirEntry;
  } | null>(null);
  let listEl: HTMLDivElement | undefined;

  // Directory listing — skipped (falsy source) while the drive list is showing.
  const [entries, { refetch }] = createResource(
    () => (drivesView() ? "" : currentPath()),
    (path) => (path ? listDir(path) : Promise.resolve([]))
  );

  // Mounted volumes for the "This PC" view (Windows; [] elsewhere).
  const [drives, { refetch: refetchDrives }] = createResource(
    drivesView,
    (on) => (on ? getBackend().then((b) => b.listDrives()) : Promise.resolve([]))
  );

  // Unified row list so keyboard nav, selection, click and favoriting work the
  // same whether we're browsing a directory or the drive list. Drives present
  // as directories that navigate into their root.
  const rows = createMemo<DirEntry[]>(() => {
    if (drivesView()) {
      return (drives() || []).map((d) => ({
        name: d.name,
        isDirectory: true,
        path: d.path,
      }));
    }
    // Reading entries() while errored re-throws — guard on .error first.
    return entries.error ? [] : entries() || [];
  });

  // O(1) favorite lookups: a single derived Set instead of an O(n) array scan
  // per cell (each row queries it 3×, and it re-runs on every toggle).
  const favSet = createMemo(() => new Set(favorites().map((f) => normalize(f.path))));
  const isFav = (path: string) => favSet().has(normalize(path));

  onMount(async () => {
    const backend = await getBackend();
    const homePath = await backend.getHomePath();
    setHome(homePath);

    // Reopen where it makes sense: the last-browsed folder, else the configured
    // startup path, else home — each only if it's actually readable, so a stale
    // or deleted setting silently falls through to the next.
    for (const candidate of [lastBrowsedPath(), startupPath()]) {
      if (!candidate) continue;
      try {
        await backend.readDir(candidate);
        navigateTo(candidate);
        return;
      } catch {
        // unreadable — try the next candidate
      }
    }
    navigateTo(homePath);
  });

  function navigateTo(path: string) {
    const p = normalize(path);
    setDrivesView(false);
    setCurrentPath(p);
    setFilter("");
    setSelectedIndex(0);
    if (p) setLastBrowsedPath(p);
  }

  function enterDrives() {
    setDrivesView(true);
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
    if (drivesView()) return; // already at the top
    const parent = dirname(currentPath());
    if (!parent) {
      // No parent path: on Windows that means "above a drive root" → show the
      // volume list; on POSIX we're already at "/", so stay put.
      if (WIN) enterDrives();
      return;
    }
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

  // Right-click a row: select it and open the context menu at the pointer,
  // clamped so it never spills past the bottom/right window edge.
  function openMenu(entry: DirEntry, index: number, e: MouseEvent) {
    e.preventDefault();
    setSelectedIndex(index);
    const MENU_W = 220;
    const MENU_H = 220;
    const x = Math.max(4, Math.min(e.clientX, window.innerWidth - MENU_W));
    const y = Math.max(4, Math.min(e.clientY, window.innerHeight - MENU_H));
    setMenu({ x, y, entry });
  }

  const closeMenu = () => setMenu(null);

  async function copyText(text: string) {
    const backend = await getBackend();
    await backend.clipboardWriteText(text);
  }

  // Context-menu actions. Each closes the menu; "open terminal here" cds into a
  // directory itself, or into a file's containing folder.
  function revealEntry(entry: DirEntry) {
    getBackend().then((b) => b.revealInFileManager(entry.path, entry.isDirectory));
    closeMenu();
  }

  function cdToEntry(entry: DirEntry) {
    props.onCdPath(entry.isDirectory ? entry.path : dirname(entry.path));
    closeMenu();
  }

  function copyEntryPath(entry: DirEntry) {
    copyText(entry.path);
    closeMenu();
  }

  function copyEntryName(entry: DirEntry) {
    copyText(entry.name);
    closeMenu();
  }

  function toggleEntryFavorite(entry: DirEntry) {
    toggleFavorite(entry.path);
    closeMenu();
  }

  // While the menu is open, dismiss it on any outside interaction: a click or
  // right-click elsewhere, scrolling the list, resizing, or Escape. Listeners
  // are attached only while open and torn down on close/unmount.
  createEffect(() => {
    if (!menu()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    const onScroll = () => closeMenu();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onScroll, true);
    listEl?.addEventListener("scroll", onScroll, true);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onScroll, true);
      listEl?.removeEventListener("scroll", onScroll, true);
    });
  });

  // Memoized: filter runs once per (rows, filter) change instead of on each
  // of its call sites (For, ghost text, the selection effect, key handlers).
  const filteredEntries = createMemo<DirEntry[]>(() => {
    const all = rows();
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

    // With an empty filter, Backspace / Left go up a level — a quick keyboard
    // counterpart to clicking "..". Guarded on empty so normal editing is
    // unaffected.
    if (!filter() && (e.key === "Backspace" || e.key === "ArrowLeft")) {
      e.preventDefault();
      navigateUp();
      return;
    }

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

  // Clickable breadcrumb segments. A leading "This PC" crumb (Windows) opens the
  // drive list; the home prefix collapses to "~"; the last segment is the
  // current folder (rendered inert).
  const crumbs = createMemo<Crumb[]>(() => {
    const out: Crumb[] = [];
    if (WIN) out.push({ label: "This PC", drives: true });
    if (drivesView()) return out;

    const p = normalize(currentPath());
    if (!p) return out;

    let rest = p;
    let acc = "";
    const h = home();
    if (h && underHome(p, h)) {
      const hn = normalize(h).replace(/[\\/]+$/, "");
      out.push({ label: "~", path: hn });
      acc = hn;
      rest = p.slice(hn.length).replace(/^[\\/]+/, "");
    } else if (!WIN) {
      out.push({ label: "/", path: "/" });
      rest = p.replace(/^\/+/, "");
    }

    for (const part of rest ? rest.split(/[\\/]+/).filter(Boolean) : []) {
      acc = acc ? join(acc, part) : WIN ? part : "/" + part;
      out.push({ label: part, path: acc });
    }
    return out;
  });

  function onCrumb(c: Crumb, isLast: boolean) {
    if (isLast) return;
    if (c.drives) enterDrives();
    else if (c.path) navigateTo(c.path);
  }

  const loading = () => (drivesView() ? drives.loading : entries.loading);
  const headerPath = () => (drivesView() ? "This PC" : currentPath());

  return (
    <Show when={props.open}>
      <div class="file-tree">
        {/* Favourites first, then the filter, then the path — the breadcrumb is
            the heading for the listing right under it, so they sit together. */}
        <Show when={favorites().length > 0}>
          <div class="file-tree-favorites">
            <For each={favorites()}>
              {(fav, i) => (
                <div
                  class="file-tree-fav"
                  classList={{ active: equalPath(fav.path, currentPath()) }}
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
        <div class="file-tree-header">
          <div class="file-tree-crumbs" title={headerPath()}>
            <For each={crumbs()}>
              {(c, i) => {
                const isLast = () => i() === crumbs().length - 1;
                return (
                  <>
                    <Show when={i() > 0}>
                      <span class="file-tree-crumb-sep">{WIN ? "\\" : "/"}</span>
                    </Show>
                    <button
                      class="file-tree-crumb"
                      classList={{ current: isLast() }}
                      disabled={isLast()}
                      onClick={() => onCrumb(c, isLast())}
                    >
                      {c.label}
                    </button>
                  </>
                );
              }}
            </For>
          </div>
          <Show when={!drivesView() && currentPath()}>
            <button
              class="file-tree-cd-here"
              title="Open the active terminal here (cd)"
              onClick={() => props.onCdPath(currentPath())}
            >
              ⌁
            </button>
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
          <button
            class="file-tree-refresh"
            onClick={() => (drivesView() ? refetchDrives() : refetch())}
          >
            ↻
          </button>
        </div>
        <div class="file-tree-content" ref={listEl}>
          <Show when={!drivesView() && currentPath() && !filter()}>
            <div class="file-tree-entry file-tree-dir" onClick={navigateUp}>
              <span class="file-tree-icon">▴</span>
              ..
            </div>
          </Show>

          <Show
            when={!drivesView() && entries.error}
            fallback={
              <Show
                when={!loading()}
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
                        onContextMenu={(e) => openMenu(entry, index(), e)}
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
                    {filter()
                      ? "No matches"
                      : drivesView()
                        ? "No drives found"
                        : "Empty directory"}
                  </div>
                </Show>
              </Show>
            }
          >
            <div class="file-tree-empty">
              Can’t read this folder — you may not have permission.
              <div class="file-tree-error-up" onClick={navigateUp}>
                ← Go up
              </div>
            </div>
          </Show>
        </div>

        {/* Right-click context menu. Portalled to <body> so it escapes the
            sidebar's overflow clipping and can sit anywhere over the window. A
            full-viewport backdrop swallows the next click/right-click to
            dismiss it (and blocks it from reaching whatever is underneath). */}
        <Show when={menu()}>
          {(m) => (
            <Portal>
              <div
                class="file-tree-menu-backdrop"
                onClick={closeMenu}
                onContextMenu={(e) => {
                  e.preventDefault();
                  closeMenu();
                }}
              >
                <div
                  class="file-tree-context-menu"
                  style={{ left: `${m().x}px`, top: `${m().y}px` }}
                  onClick={(e) => e.stopPropagation()}
                  onContextMenu={(e) => e.stopPropagation()}
                >
                  <button
                    class="file-tree-menu-item"
                    data-action="reveal"
                    onClick={() => revealEntry(m().entry)}
                  >
                    {WIN
                      ? "Reveal in Explorer"
                      : os === "mac"
                        ? "Reveal in Finder"
                        : "Reveal in file manager"}
                  </button>
                  <button
                    class="file-tree-menu-item"
                    data-action="cd"
                    onClick={() => cdToEntry(m().entry)}
                  >
                    Open terminal here
                  </button>
                  <div class="file-tree-menu-sep" />
                  <button
                    class="file-tree-menu-item"
                    data-action="copy-path"
                    onClick={() => copyEntryPath(m().entry)}
                  >
                    Copy path
                  </button>
                  <button
                    class="file-tree-menu-item"
                    data-action="copy-name"
                    onClick={() => copyEntryName(m().entry)}
                  >
                    Copy name
                  </button>
                  <Show when={m().entry.isDirectory}>
                    <div class="file-tree-menu-sep" />
                    <button
                      class="file-tree-menu-item"
                      data-action="favorite"
                      onClick={() => toggleEntryFavorite(m().entry)}
                    >
                      {isFav(m().entry.path)
                        ? "Remove from favorites"
                        : "Add to favorites"}
                    </button>
                  </Show>
                </div>
              </div>
            </Portal>
          )}
        </Show>
      </div>
    </Show>
  );
}
