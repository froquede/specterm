import {
  createSignal,
  createResource,
  createEffect,
  For,
  Show,
  onMount,
} from "solid-js";
import { getBackend } from "../backends";
import type { FileEntry } from "../backends/types";
import { isAccelClick } from "../lib/platform";

interface FileTreeProps {
  open: boolean;
  width: number;
  onOpenFile: (path: string, mode: "split" | "tab") => void;
  // Devolve o foco ao grid/terminal (Esc com o filtro já vazio).
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

  function filteredEntries(): DirEntry[] {
    const all = entries() || [];
    const q = filter().toLowerCase();
    if (!q) return all;
    return all.filter((e) => e.name.toLowerCase().includes(q));
  }

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
          <button class="file-tree-refresh" onClick={() => refetch()}>
            ↻
          </button>
        </div>
        <div class="file-tree-search">
          <div class="file-tree-search-field">
            <input
              type="text"
              placeholder="Filter..."
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
                    {entry.name}
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
