import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Show,
  onCleanup,
  onMount,
} from "solid-js";
import IconRefresh from "lucide-solid/icons/refresh-cw";
import IconX from "lucide-solid/icons/x";
import type { PluginPanelApi } from "../../../src/components/PluginView";
import { isMarkdownPath } from "../../../src/lib/file-kind";
import { isAccelClick } from "../../../src/lib/platform";
import { equalPath } from "../../../src/lib/fspath";
import { backlinksTo, searchNotes, type SearchHit } from "./vault-index";
import { vaults, currentVault, setSelectedVault, removeVault } from "./vaults";
import { vaultIndex, vaultIndexing, acquireVaultIndex, refreshVaultIndex } from "./index-store";

// Same stroke as the app's chrome icons (src/lib/icons.ts).
const ICON_STROKE = 1.75;

interface VaultPanelProps {
  api: PluginPanelApi;
  // The file in the active pane, or null when that pane isn't showing one.
  // Tracked: the outline and backlinks follow the pane you're in.
  activeFile: () => string | null;
}

// A matched line with the match itself highlighted. Built from text nodes, not
// innerHTML: the snippet is file contents, and nothing in a note gets to be
// markup in the panel.
function Snippet(props: { hit: SearchHit }) {
  return (
    <span class="vault-hit-text">
      {props.hit.snippet.slice(0, props.hit.start)}
      <mark>{props.hit.snippet.slice(props.hit.start, props.hit.end)}</mark>
      {props.hit.snippet.slice(props.hit.end)}
    </span>
  );
}

export function VaultPanel(props: VaultPanelProps) {
  const [query, setQuery] = createSignal("");
  // Typed text is applied a beat later, so a fast typist in a big vault
  // doesn't run a full search per keystroke.
  const [appliedQuery, setAppliedQuery] = createSignal("");
  let queryTimer: ReturnType<typeof setTimeout> | null = null;
  let inputEl: HTMLInputElement | undefined;

  const vault = createMemo(() => currentVault(props.activeFile()));

  // The panel holds the index while it's mounted; see acquireVaultIndex.
  const release = acquireVaultIndex(props.api.invoke);
  onCleanup(() => {
    release();
    if (queryTimer) clearTimeout(queryTimer);
  });

  // Build (or catch up) the index whenever the panel lands on a vault, and
  // again when the active note changes — moving to another note is the moment
  // its backlinks are read, and a note just edited and saved should count. The
  // refresh only re-reads files whose mtime moved, and is throttled.
  createEffect(() => {
    props.activeFile();
    const v = vault();
    if (v) void refreshVaultIndex(v.path);
  });

  onMount(() => inputEl?.focus());

  // Only the index for the vault on screen counts: during a switch the old one
  // is still around for a moment.
  const notes = createMemo(() => {
    const idx = vaultIndex();
    const v = vault();
    return idx && v && equalPath(idx.root, v.path) ? idx.notes : [];
  });

  const results = createMemo(() => searchNotes(notes(), appliedQuery()));

  const activeMarkdown = createMemo(() => {
    const f = props.activeFile();
    return f && isMarkdownPath(f) ? f : null;
  });

  const backlinks = createMemo(() => {
    const f = activeMarkdown();
    return f ? backlinksTo(notes(), f) : [];
  });

  // The outline comes from the file itself rather than the index, so it works
  // for a note outside any vault too. Re-read when the active note changes.
  const [outline, { refetch: refetchOutline }] = createResource(
    activeMarkdown,
    async (path) => {
      const text = (await props.api.invoke("read-text-file", path)) as string;
      return props.api.noteStructure(text).headings;
    }
  );

  // Reading a resource while errored re-throws; an unreadable note just has
  // no outline.
  const headings = () => (outline.error ? [] : outline() ?? []);

  function onInput(value: string) {
    setQuery(value);
    if (queryTimer) clearTimeout(queryTimer);
    queryTimer = setTimeout(() => setAppliedQuery(value), 150);
  }

  function open(path: string, e: MouseEvent) {
    props.api.openFile(path, isAccelClick(e) ? "tab" : "split");
  }

  // Scroll the active preview to its Nth heading. The outline was parsed by the
  // same markdown-it that rendered the preview (api.noteStructure), so the
  // indices line up. A pane in edit mode has no rendered headings, and the
  // click does nothing.
  function goToHeading(i: number) {
    props.api.revealHeading(i);
  }

  function refresh() {
    const v = vault();
    if (v) void refreshVaultIndex(v.path, true);
    void refetchOutline();
  }

  const status = createMemo(() => {
    const idx = vaultIndex();
    if (vaultIndexing() && notes().length === 0) return "Indexing…";
    if (!idx) return "";
    const parts = [`${notes().length} notes`];
    if (idx.truncated) parts.push("listing stopped at its limit");
    else if (idx.partial) parts.push("some notes indexed by name only");
    return parts.join(" · ");
  });

  return (
    <div class="vault-panel">
      <div class="vault-panel-header">
        <span class="vault-panel-title">Vault</span>
        <Show when={vault()}>
          <button
            class="vault-icon-btn"
            title="Re-read the vault"
            aria-label="Re-read the vault"
            onClick={refresh}
          >
            <IconRefresh size={14} stroke-width={ICON_STROKE} />
          </button>
        </Show>
      </div>

      <Show
        when={vaults().length > 0}
        fallback={
          <div class="vault-empty">
            No vaults yet. Right-click a folder in the file tree and choose
            <strong> Open as vault</strong> to search its notes, open them by
            name and see what links to each one.
          </div>
        }
      >
        <div class="vault-list">
          <For each={vaults()}>
            {(v) => (
              <div
                class="vault-item"
                classList={{ active: equalPath(v.path, vault()?.path ?? "") }}
                title={v.path}
                onClick={() => setSelectedVault(v.path)}
              >
                <span class="vault-item-label">{v.label}</span>
                <button
                  class="vault-item-remove"
                  title="Remove from vaults"
                  aria-label={`Remove ${v.label} from vaults`}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeVault(v.path);
                  }}
                >
                  <IconX size={12} stroke-width={2.25} />
                </button>
              </div>
            )}
          </For>
        </div>

        <div class="vault-search">
          <input
            ref={inputEl}
            type="text"
            placeholder="Search notes…"
            value={query()}
            onInput={(e) => onInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query()) {
                e.stopPropagation();
                onInput("");
                setAppliedQuery("");
              }
            }}
          />
        </div>
        <div class="vault-status">{status()}</div>

        <div class="vault-scroll">
          <Show
            when={appliedQuery().trim()}
            fallback={
              <>
                <Show when={activeMarkdown()}>
                  <div class="vault-section">
                    <div class="vault-section-title">Outline</div>
                    <Show
                      when={headings().length > 0}
                      fallback={<div class="vault-muted">No headings</div>}
                    >
                      <For each={headings()}>
                        {(h, i) => (
                          <div
                            class="vault-outline-item"
                            style={{ "padding-left": `${(h.level - 1) * 12 + 8}px` }}
                            onClick={() => goToHeading(i())}
                            title={h.text}
                          >
                            {h.text}
                          </div>
                        )}
                      </For>
                    </Show>
                  </div>
                  <div class="vault-section">
                    <div class="vault-section-title">Backlinks</div>
                    <Show
                      when={backlinks().length > 0}
                      fallback={
                        <div class="vault-muted">
                          {vault() && notes().length > 0
                            ? "No notes link here"
                            : "Open a note inside a vault to see its backlinks"}
                        </div>
                      }
                    >
                      <For each={backlinks()}>
                        {(b) => (
                          <div class="vault-result">
                            <div
                              class="vault-result-name"
                              title={b.note.path}
                              onClick={(e) => open(b.note.path, e)}
                            >
                              {b.note.rel}
                            </div>
                            <For each={b.contexts}>
                              {(c) => (
                                <div
                                  class="vault-hit"
                                  onClick={(e) => open(b.note.path, e)}
                                >
                                  <span class="vault-hit-line">{c.line + 1}</span>
                                  <span class="vault-hit-text">{c.text}</span>
                                </div>
                              )}
                            </For>
                          </div>
                        )}
                      </For>
                    </Show>
                  </div>
                </Show>
                <Show when={!activeMarkdown()}>
                  <div class="vault-muted vault-hint">
                    Open a note to see its outline and backlinks.
                  </div>
                </Show>
              </>
            }
          >
            <Show
              when={results().length > 0}
              fallback={
                <div class="vault-muted">
                  {vaultIndexing() ? "Indexing…" : "No matches"}
                </div>
              }
            >
              <For each={results()}>
                {(r) => (
                  <div class="vault-result">
                    <div
                      class="vault-result-name"
                      title={r.note.path}
                      onClick={(e) => open(r.note.path, e)}
                    >
                      {r.note.rel}
                    </div>
                    <For each={r.hits}>
                      {(hit) => (
                        <div class="vault-hit" onClick={(e) => open(r.note.path, e)}>
                          <span class="vault-hit-line">{hit.line + 1}</span>
                          <Snippet hit={hit} />
                        </div>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  );
}
