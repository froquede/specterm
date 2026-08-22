import {
  createSignal,
  createEffect,
  onMount,
  onCleanup,
  untrack,
  Show,
} from "solid-js";
import { Portal } from "solid-js/web";
import type { EditorView } from "@codemirror/view";
import type * as MarkdownEditor from "../lib/markdown-editor";
import { getBackend } from "../backends";
import { renderMarkdown, renderMermaidBlocks } from "../lib/markdown";
import { matchesCmd, shortcutLabel, isAccelClick } from "../lib/platform";

interface MarkdownPaneProps {
  filePath: string;
  // Whether this pane is the focused one. ⌘F only acts on the active pane so a
  // single keypress doesn't toggle search in every open markdown pane at once.
  isActive?: boolean;
  onOpenMarkdown?: (path: string, mode: "split" | "tab") => void;
}

// Unsaved edits are auto-persisted as a "draft" in localStorage, keyed by file
// path. localStorage is synchronous and cheap for small text, so this costs
// effectively nothing — and it means unsaved work survives everything that would
// otherwise drop it: a cross-tab pane move (which recreates the component), a
// reload, or closing the app. The draft is written debounced while editing (and
// flushed on unmount), consulted on load, and cleared on save.
const DRAFT_PREFIX = "specterm.mddraft:";
const draftKey = (filePath: string) => DRAFT_PREFIX + filePath;
function readDraft(filePath: string): string | null {
  try {
    return localStorage.getItem(draftKey(filePath));
  } catch {
    return null;
  }
}
function writeDraft(filePath: string, content: string) {
  try {
    localStorage.setItem(draftKey(filePath), content);
  } catch {
    // localStorage full/unavailable — the edit just won't survive a hard close.
  }
}
function clearDraft(filePath: string) {
  try {
    localStorage.removeItem(draftKey(filePath));
  } catch {
    /* ignore */
  }
}

export default function MarkdownPane(props: MarkdownPaneProps) {
  let contentRef!: HTMLDivElement;
  let searchInputRef!: HTMLInputElement;
  let editorRef!: HTMLDivElement;
  const [content, setContent] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [matchCount, setMatchCount] = createSignal(0);
  const [currentMatch, setCurrentMatch] = createSignal(0);
  // "read" = rendered preview (default); "edit" = CodeMirror live-preview.
  const [mode, setMode] = createSignal<"read" | "edit">("read");
  // Text on disk (in memory). content() may run ahead of it with unsaved edits;
  // dirty is the difference.
  const [savedText, setSavedText] = createSignal("");
  const [dirty, setDirty] = createSignal(false);

  // Live CodeMirror instance while in edit mode (null in read mode).
  let editorView: EditorView | null = null;
  // The editor module, captured when the lazy chunk lands (see the effect
  // below). Its clipboard commands back both the editor's keys and the
  // right-click menu, so the menu doesn't need a static import of the 500 KB
  // CodeMirror bundle to call them.
  let editorApi: typeof MarkdownEditor | null = null;

  // Right-click menu over the editor: where, and whether there was a selection
  // under the cursor when it opened.
  const [menu, setMenu] = createSignal<{
    x: number;
    y: number;
    hasSelection: boolean;
  } | null>(null);

  function openEditorMenu(e: MouseEvent) {
    if (!editorView) return;
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      hasSelection: editorView.state.selection.ranges.some((r) => !r.empty),
    });
  }

  // Every item does its work on the live editor, then the menu goes away. The
  // buttons suppress mousedown so the click doesn't move the caret or drop the
  // selection the command is about to act on.
  function runMenuAction(action: (view: EditorView) => void) {
    const view = editorView;
    setMenu(null);
    if (view) action(view);
  }

  // Store the original rendered HTML so we can re-highlight without re-rendering
  let renderedHtml = "";

  // `force` re-reads from disk and discards any draft (the Refresh button); the
  // default honors a persisted draft so unsaved edits survive a move/reload.
  async function loadFile(force = false) {
    try {
      setError(null);
      const backend = await getBackend();
      const text = await backend.readTextFile(props.filePath);
      setSavedText(text);

      const draft = force ? null : readDraft(props.filePath);
      // A draft that already matches disk is stale (saved elsewhere) — drop it.
      if (draft !== null && draft === text) clearDraft(props.filePath);
      const initial = draft !== null && draft !== text ? draft : text;

      setContent(initial);
      setDirty(initial !== text);
      // If the editor is open, replace its buffer with the loaded content.
      if (editorView) {
        editorView.dispatch({
          changes: {
            from: 0,
            to: editorView.state.doc.length,
            insert: initial,
          },
        });
      }
    } catch (e) {
      setError(`Failed to read file: ${props.filePath}\n${e}`);
    }
  }

  async function save() {
    if (!editorView) return;
    const text = editorView.state.doc.toString();
    try {
      const backend = await getBackend();
      await backend.writeTextFile(props.filePath, text);
      setSavedText(text);
      setContent(text);
      setDirty(false);
      clearDraft(props.filePath);
    } catch (e) {
      setError(`Failed to save file: ${props.filePath}\n${e}`);
    }
  }

  // Persist the current buffer as a draft, debounced so keystrokes don't hammer
  // localStorage. A buffer that matches disk clears the draft instead.
  let draftTimer: number | null = null;
  function persistDraft(buffer: string) {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = window.setTimeout(() => {
      if (buffer === savedText()) clearDraft(props.filePath);
      else writeDraft(props.filePath, buffer);
    }, 400);
  }

  function toggleMode() {
    setMode((m) => (m === "read" ? "edit" : "read"));
  }

  // Mount/unmount CodeMirror as the mode toggles. content() is read untracked so
  // a save() (which updates content) doesn't tear down and rebuild the editor.
  //
  // CodeMirror is ~500 KB, so it's loaded lazily on the FIRST switch to edit
  // mode — a fast terminal must not pay for the editor at startup (mirrors the
  // lazy mermaid/highlight.js chunks). The doc is captured synchronously; the
  // view is created once the chunk resolves, unless the effect already cleaned
  // up (mode flipped back before the import landed).
  createEffect(() => {
    if (mode() !== "edit" || !editorRef) return;
    const initialDoc = untrack(content);
    let view: EditorView | null = null;
    let disposed = false;
    import("../lib/markdown-editor").then((mod) => {
      if (disposed || !editorRef) return;
      editorApi = mod;
      view = mod.createMarkdownEditor({
        doc: initialDoc,
        parent: editorRef,
        onDocChanged: (v) => {
          const buffer = v.state.doc.toString();
          setDirty(buffer !== savedText());
          persistDraft(buffer);
        },
        onSave: save,
      });
      editorView = view;
      view.focus();
    });
    onCleanup(() => {
      disposed = true;
      setMenu(null);
      if (view) {
        // Carry the (possibly unsaved) buffer back so the reader previews it.
        setContent(view.state.doc.toString());
        view.destroy();
        editorView = null;
      }
    });
  });

  onMount(() => {
    // loadFile() restores a persisted draft when there is one, so a pane moved
    // between tabs (or reopened after a reload/close) comes back with its unsaved
    // edits rather than the on-disk copy.
    loadFile();
  });

  // Flush the draft synchronously on unmount if still dirty, in case the debounce
  // hadn't fired (e.g. a fast cross-tab move right after a keystroke). Read the
  // live editor if it's up, else the buffer the editor effect's cleanup carried
  // back into content().
  onCleanup(() => {
    if (draftTimer) clearTimeout(draftTimer);
    if (!dirty()) return;
    const buffer = editorView ? editorView.state.doc.toString() : content();
    if (buffer !== savedText()) writeDraft(props.filePath, buffer);
  });

  createEffect(async () => {
    // Only the read view renders HTML; the editor owns the DOM in edit mode.
    if (mode() !== "read") return;
    const md = content();
    if (!md || !contentRef) return;

    renderedHtml = renderMarkdown(md);
    contentRef.innerHTML = renderedHtml;
    await renderMermaidBlocks(contentRef);

    // Re-apply search highlights if search is active
    const q = searchQuery();
    if (q && searchOpen()) {
      applyHighlights(q);
    }
  });

  function applyHighlights(query: string) {
    if (!contentRef || !query) {
      if (contentRef && renderedHtml) {
        contentRef.innerHTML = renderedHtml;
      }
      setMatchCount(0);
      setCurrentMatch(0);
      return;
    }

    // Walk text nodes and wrap matches
    const marks: HTMLElement[] = [];
    const walker = document.createTreeWalker(
      contentRef,
      NodeFilter.SHOW_TEXT,
      null
    );

    const textNodes: { node: Text; text: string }[] = [];
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      // Skip nodes inside mermaid SVGs and code blocks
      const parent = node.parentElement;
      if (
        parent?.closest(".mermaid") ||
        parent?.closest("svg") ||
        parent?.tagName === "MARK"
      )
        continue;
      textNodes.push({ node, text: node.textContent || "" });
    }

    const lowerQuery = query.toLowerCase();

    for (const { node: textNode, text } of textNodes) {
      const lowerText = text.toLowerCase();
      const indices: number[] = [];
      let searchFrom = 0;

      while (true) {
        const idx = lowerText.indexOf(lowerQuery, searchFrom);
        if (idx === -1) break;
        indices.push(idx);
        searchFrom = idx + lowerQuery.length;
      }

      if (indices.length === 0) continue;

      const parent = textNode.parentNode;
      if (!parent) continue;

      const frag = document.createDocumentFragment();
      let lastEnd = 0;

      for (const idx of indices) {
        // Text before match
        if (idx > lastEnd) {
          frag.appendChild(document.createTextNode(text.slice(lastEnd, idx)));
        }
        // The match
        const mark = document.createElement("mark");
        mark.className = "search-highlight";
        mark.textContent = text.slice(idx, idx + query.length);
        frag.appendChild(mark);
        marks.push(mark);
        lastEnd = idx + query.length;
      }

      // Text after last match
      if (lastEnd < text.length) {
        frag.appendChild(document.createTextNode(text.slice(lastEnd)));
      }

      parent.replaceChild(frag, textNode);
    }

    setMatchCount(marks.length);
    if (marks.length > 0) {
      setCurrentMatch(1);
      scrollToMatch(marks, 0);
    } else {
      setCurrentMatch(0);
    }
  }

  function scrollToMatch(marks: HTMLElement[] | null, index: number) {
    const allMarks = marks || contentRef?.querySelectorAll("mark.search-highlight");
    if (!allMarks || allMarks.length === 0) return;

    // Remove active class from all
    allMarks.forEach((m: Element) => m.classList.remove("search-active"));

    const target = allMarks[index] as HTMLElement;
    if (target) {
      target.classList.add("search-active");
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function navigateMatch(direction: 1 | -1) {
    const total = matchCount();
    if (total === 0) return;

    let next = currentMatch() + direction;
    if (next > total) next = 1;
    if (next < 1) next = total;
    setCurrentMatch(next);

    scrollToMatch(null, next - 1);
  }

  function openSearch() {
    setSearchOpen(true);
    requestAnimationFrame(() => searchInputRef?.focus());
  }

  function closeSearch() {
    setSearchOpen(false);
    setSearchQuery("");
    setMatchCount(0);
    setCurrentMatch(0);
    // Restore original HTML
    if (contentRef && renderedHtml) {
      contentRef.innerHTML = renderedHtml;
    }
  }

  // Debounced search
  let searchTimeout: number | null = null;

  function onSearchInput(value: string) {
    setSearchQuery(value);
    if (searchTimeout) clearTimeout(searchTimeout);

    if (!value) {
      // Restore immediately when cleared
      if (contentRef && renderedHtml) {
        contentRef.innerHTML = renderedHtml;
      }
      setMatchCount(0);
      setCurrentMatch(0);
      return;
    }

    searchTimeout = window.setTimeout(() => {
      // Re-render from original HTML before highlighting
      if (contentRef && renderedHtml) {
        contentRef.innerHTML = renderedHtml;
      }
      applyHighlights(value);
    }, 300);
  }

  function handleContentClick(e: MouseEvent) {
    const anchor = (e.target as HTMLElement).closest("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href");
    if (!href || !href.endsWith(".md")) return;

    e.preventDefault();

    // Resolve relative path against current file's directory
    const dir = props.filePath.substring(0, props.filePath.lastIndexOf("/"));
    const resolved = href.startsWith("/") ? href : dir + "/" + href;
    const mode = isAccelClick(e) ? "tab" : "split";
    props.onOpenMarkdown?.(resolved, mode);
  }

  function handleKeyDown(e: KeyboardEvent) {
    // Ignore when another pane is focused: the listener is global (window), so
    // without this guard every mounted markdown pane would react to one ⌘F.
    if (!props.isActive) return;
    // Escape dismisses the editor's right-click menu, like the file tree's.
    if (e.key === "Escape" && menu()) {
      e.preventDefault();
      e.stopPropagation();
      setMenu(null);
      editorView?.focus();
      return;
    }
    if (!matchesCmd(e)) return;
    const key = e.key.toLowerCase();

    // ⌘E toggles read/edit from either mode.
    if (key === "e") {
      e.preventDefault();
      e.stopPropagation();
      toggleMode();
      return;
    }
    // ⌘S saves — only meaningful while editing.
    if (key === "s" && mode() === "edit") {
      e.preventDefault();
      e.stopPropagation();
      save();
      return;
    }
    // ⌘F toggles find — read mode only (the editor handles its own keys).
    if (key === "f" && mode() === "read") {
      e.preventDefault();
      e.stopPropagation();
      if (searchOpen()) {
        closeSearch();
      } else {
        openSearch();
      }
    }
  }

  onMount(() => {
    window.addEventListener("keydown", handleKeyDown, true);
  });

  onCleanup(() => {
    window.removeEventListener("keydown", handleKeyDown, true);
    if (searchTimeout) clearTimeout(searchTimeout);
  });

  return (
    <div class="markdown-pane">
      <div class="markdown-toolbar">
        <span class="markdown-filepath">
          {dirty() ? "● " : ""}
          {props.filePath}
        </span>
        <div class="markdown-toolbar-actions">
          <Show when={mode() === "edit"}>
            <button
              class="markdown-toolbar-btn"
              onClick={save}
              disabled={!dirty()}
              title={`Save (${shortcutLabel("S")})`}
            >
              Save
            </button>
          </Show>
          <button
            class="markdown-toolbar-btn"
            onClick={toggleMode}
            title={`${mode() === "read" ? "Edit" : "Preview"} (${shortcutLabel("E")})`}
          >
            {mode() === "read" ? "Edit" : "Preview"}
          </button>
          <Show when={mode() === "read"}>
            <button
              class="markdown-toolbar-btn"
              onClick={() => (searchOpen() ? closeSearch() : openSearch())}
              title={`Search (${shortcutLabel("F")})`}
            >
              Search
            </button>
            {/* Refresh re-reads from disk (discarding any draft), so it's
                read-mode only — in edit mode it would drop unsaved changes. */}
            <button class="markdown-toolbar-btn" onClick={() => loadFile(true)}>
              Refresh
            </button>
          </Show>
        </div>
      </div>
      {mode() === "read" && searchOpen() && (
        <div class="markdown-search">
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Find in document..."
            value={searchQuery()}
            onInput={(e) => onSearchInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                closeSearch();
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (e.shiftKey) {
                  navigateMatch(-1);
                } else {
                  navigateMatch(1);
                }
              }
            }}
          />
          <span class="markdown-search-count">
            {matchCount() > 0
              ? `${currentMatch()}/${matchCount()}`
              : searchQuery()
                ? "No results"
                : ""}
          </span>
          <button class="markdown-search-btn" onClick={() => navigateMatch(-1)}>
            ▲
          </button>
          <button class="markdown-search-btn" onClick={() => navigateMatch(1)}>
            ▼
          </button>
          <button class="markdown-search-btn" onClick={closeSearch}>
            ×
          </button>
        </div>
      )}
      {error() && <div class="markdown-error">{error()}</div>}
      <Show when={mode() === "edit"}>
        <div
          ref={editorRef}
          class="markdown-editor"
          onContextMenu={openEditorMenu}
        />
      </Show>
      {/* Cut/copy/paste as a visible option, not just a chord. The app ships no
          native Edit menu (it would claim ⌘C/⌘V before the terminal sees them),
          so this menu — and the editor's own keymap — is how the clipboard
          reaches a markdown file. Portalled over a full-viewport backdrop, the
          same shape the file-tree menu uses. */}
      <Show when={menu()}>
        {(m) => (
          <Portal>
            <div
              class="md-menu-backdrop"
              onClick={() => setMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu(null);
              }}
            >
              <div
                class="md-context-menu"
                style={{ left: `${m().x}px`, top: `${m().y}px` }}
                onClick={(e) => e.stopPropagation()}
                onContextMenu={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.preventDefault()}
              >
                <button
                  class="md-menu-item"
                  disabled={!m().hasSelection}
                  onClick={() =>
                    runMenuAction((v) => editorApi?.cutFromEditor(v))
                  }
                >
                  Cut
                </button>
                <button
                  class="md-menu-item"
                  disabled={!m().hasSelection}
                  onClick={() =>
                    runMenuAction((v) => editorApi?.copyFromEditor(v))
                  }
                >
                  Copy
                </button>
                <button
                  class="md-menu-item"
                  onClick={() =>
                    runMenuAction((v) => editorApi?.pasteIntoEditor(v))
                  }
                >
                  Paste
                </button>
                <div class="md-menu-sep" />
                <button
                  class="md-menu-item"
                  onClick={() =>
                    runMenuAction((v) => editorApi?.selectAllInEditor(v))
                  }
                >
                  Select all
                </button>
              </div>
            </div>
          </Portal>
        )}
      </Show>
      <Show when={mode() === "read"}>
        <div ref={contentRef} class="markdown-content" onClick={handleContentClick} />
      </Show>
    </div>
  );
}
