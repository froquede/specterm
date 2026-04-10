import { createSignal, createResource, For, Show, onMount } from "solid-js";
import { getBackend } from "../backends";
import type { FileEntry } from "../backends/types";

interface FileTreeProps {
  open: boolean;
  width: number;
  onOpenFile: (path: string, mode: "split" | "tab") => void;
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

  function navigateUp() {
    const current = currentPath();
    const parent = current.substring(0, current.lastIndexOf("/")) || "/";
    navigateTo(parent);
  }

  function handleClick(entry: DirEntry, e: MouseEvent) {
    if (entry.isDirectory) {
      navigateTo(entry.path);
    } else if (entry.name.endsWith(".md")) {
      const mode = e.ctrlKey ? "tab" : "split";
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
          <button class="file-tree-refresh" onClick={() => refetch()}>
            ↻
          </button>
        </div>
        <div class="file-tree-search">
          <input
            type="text"
            placeholder="Filter..."
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setFilter("");
                e.currentTarget.blur();
              }
            }}
          />
        </div>
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
