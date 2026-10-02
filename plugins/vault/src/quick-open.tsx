import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  onCleanup,
  onMount,
} from "solid-js";
import type { PluginPanelApi } from "../../../src/components/PluginView";
import { equalPath } from "../../../src/lib/fspath";
import { findNotesByName } from "./vault-index";
import { currentVault } from "./vaults";
import { vaultIndex, vaultIndexing, acquireVaultIndex, refreshVaultIndex } from "./index-store";

interface QuickOpenProps {
  api: PluginPanelApi;
  activeFile: () => string | null;
}

// Open a note by name: a fuzzy match over every note in the current vault,
// keyboard first. Enter opens beside the active pane, ⌘/Ctrl+Enter in a new
// tab — the same split-or-tab choice a click in the file tree makes.
export function QuickOpen(props: QuickOpenProps) {
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal(0);
  let inputEl: HTMLInputElement | undefined;
  let listEl: HTMLDivElement | undefined;

  const vault = createMemo(() => currentVault(props.activeFile()));

  const release = acquireVaultIndex(props.api.invoke);
  onCleanup(release);

  createEffect(() => {
    const v = vault();
    if (v) void refreshVaultIndex(v.path);
  });

  onMount(() => inputEl?.focus());

  const matches = createMemo(() => {
    const idx = vaultIndex();
    const v = vault();
    if (!idx || !v || !equalPath(idx.root, v.path)) return [];
    return findNotesByName(idx.notes, query());
  });

  // Keep the selection on a real row, and in view.
  createEffect(() => {
    const len = matches().length;
    if (selected() >= len) setSelected(len > 0 ? len - 1 : 0);
    listEl
      ?.querySelector<HTMLElement>(".quick-open-item.is-selected")
      ?.scrollIntoView({ block: "nearest" });
  });

  function choose(i: number, mode: "split" | "tab") {
    const note = matches()[i];
    if (!note) return;
    props.api.close();
    props.api.openFile(note.path, mode);
  }

  function onKeyDown(e: KeyboardEvent) {
    const len = matches().length;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.api.close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (len) setSelected((i) => (i + 1) % len);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (len) setSelected((i) => (i - 1 + len) % len);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(selected(), e.metaKey || e.ctrlKey ? "tab" : "split");
    }
  }

  const empty = () => {
    if (!vault()) return "No vault yet — right-click a folder in the file tree and choose Open as vault.";
    if (vaultIndexing() && matches().length === 0) return "Indexing…";
    return query() ? "No matching notes" : "This vault has no notes";
  };

  return (
    <div class="quick-open">
      <input
        ref={inputEl}
        class="quick-open-input"
        type="text"
        placeholder={vault() ? `Open a note in ${vault()!.label}…` : "Open a note…"}
        value={query()}
        onInput={(e) => {
          setQuery(e.currentTarget.value);
          setSelected(0);
        }}
        onKeyDown={onKeyDown}
      />
      <div class="quick-open-list" ref={listEl}>
        <For each={matches()}>
          {(note, i) => (
            <div
              class="quick-open-item"
              classList={{ "is-selected": i() === selected() }}
              onMouseEnter={() => setSelected(i())}
              onClick={(e) => choose(i(), e.metaKey || e.ctrlKey ? "tab" : "split")}
              title={note.path}
            >
              <span class="quick-open-name">{note.name}</span>
              <span class="quick-open-dir">{note.rel}</span>
            </div>
          )}
        </For>
        <Show when={matches().length === 0}>
          <div class="quick-open-empty">{empty()}</div>
        </Show>
      </div>
    </div>
  );
}
