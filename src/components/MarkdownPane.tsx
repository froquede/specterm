import {
  createSignal,
  createEffect,
  onMount,
  onCleanup,
  untrack,
  Show,
} from "solid-js";
import type { EditorView } from "@codemirror/view";
import { getBackend } from "../backends";
import { renderMarkdown, renderMermaidBlocks } from "../lib/markdown";
import { matchesCmd, shortcutLabel, isAccelClick } from "../lib/platform";

interface MarkdownPaneProps {
  filePath: string;
  // Stable id of the pane this markdown view lives in. Used to carry an unsaved
  // buffer across a remount (e.g. a cross-tab pane move, which disposes and
  // recreates the component) so edits aren't silently re-read from disk.
  paneId?: string;
  // Whether this pane is the focused one. ⌘F only acts on the active pane so a
  // single keypress doesn't toggle search in every open markdown pane at once.
  isActive?: boolean;
  onOpenMarkdown?: (path: string, mode: "split" | "tab") => void;
}

// Unsaved editor buffers, keyed by pane id, kept across the component's remount.
// A markdown pane's state is component-local, so moving the pane between tabs
// (which recreates the component) would otherwise lose unsaved edits — this is
// the markdown analogue of the terminal registry that keeps PTYs alive across
// the same move. Entries live only while dirty: written on unmount-if-dirty,
// consumed on mount, cleared on save.
const unsavedBuffers = new Map<string, { content: string; savedText: string }>();

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

  // Store the original rendered HTML so we can re-highlight without re-rendering
  let renderedHtml = "";

  async function loadFile() {
    try {
      setError(null);
      const backend = await getBackend();
      const text = await backend.readTextFile(props.filePath);
      setSavedText(text);
      setContent(text);
      setDirty(false);
      // If the editor is open, replace its buffer with the reloaded text.
      if (editorView) {
        editorView.dispatch({
          changes: {
            from: 0,
            to: editorView.state.doc.length,
            insert: text,
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
      if (props.paneId) unsavedBuffers.delete(props.paneId);
    } catch (e) {
      setError(`Failed to save file: ${props.filePath}\n${e}`);
    }
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
    import("../lib/markdown-editor").then(({ createMarkdownEditor }) => {
      if (disposed || !editorRef) return;
      view = createMarkdownEditor({
        doc: initialDoc,
        parent: editorRef,
        onDocChanged: (v) => setDirty(v.state.doc.toString() !== savedText()),
        onSave: save,
      });
      editorView = view;
      view.focus();
    });
    onCleanup(() => {
      disposed = true;
      if (view) {
        // Carry the (possibly unsaved) buffer back so the reader previews it.
        setContent(view.state.doc.toString());
        view.destroy();
        editorView = null;
      }
    });
  });

  onMount(() => {
    // A pending unsaved buffer (this pane was moved between tabs while dirty)
    // wins over the on-disk copy — restore it instead of re-reading the file.
    const cached = props.paneId ? unsavedBuffers.get(props.paneId) : undefined;
    if (cached) {
      unsavedBuffers.delete(props.paneId!);
      setSavedText(cached.savedText);
      setContent(cached.content);
      setDirty(cached.content !== cached.savedText);
    } else {
      loadFile();
    }
  });

  // On unmount with unsaved edits, stash the buffer keyed by pane id so a
  // remount (cross-tab move) can restore it rather than losing the edits to a
  // disk re-read. Read the live editor if it's still up, else the carried-back
  // content() the editor effect's own cleanup leaves behind.
  onCleanup(() => {
    if (!props.paneId || !dirty()) return;
    const buffer = editorView ? editorView.state.doc.toString() : content();
    unsavedBuffers.set(props.paneId, { content: buffer, savedText: savedText() });
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
            {/* Refresh re-reads from disk, so it's read-mode only — in edit mode
                it would silently discard unsaved changes. */}
            <button class="markdown-toolbar-btn" onClick={loadFile}>
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
        <div ref={editorRef} class="markdown-editor" />
      </Show>
      <Show when={mode() === "read"}>
        <div ref={contentRef} class="markdown-content" onClick={handleContentClick} />
      </Show>
    </div>
  );
}
