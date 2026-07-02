import { createSignal, createEffect, onMount, onCleanup } from "solid-js";
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

export default function MarkdownPane(props: MarkdownPaneProps) {
  let contentRef!: HTMLDivElement;
  let searchInputRef!: HTMLInputElement;
  const [content, setContent] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [matchCount, setMatchCount] = createSignal(0);
  const [currentMatch, setCurrentMatch] = createSignal(0);

  // Store the original rendered HTML so we can re-highlight without re-rendering
  let renderedHtml = "";

  async function loadFile() {
    try {
      setError(null);
      const backend = await getBackend();
      const text = await backend.readTextFile(props.filePath);
      setContent(text);
    } catch (e) {
      setError(`Failed to read file: ${props.filePath}\n${e}`);
    }
  }

  onMount(() => {
    loadFile();
  });

  createEffect(async () => {
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
    if (matchesCmd(e) && e.key.toLowerCase() === "f") {
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
        <span class="markdown-filepath">{props.filePath}</span>
        <div class="markdown-toolbar-actions">
          <button
            class="markdown-toolbar-btn"
            onClick={() => (searchOpen() ? closeSearch() : openSearch())}
            title={`Search (${shortcutLabel("F")})`}
          >
            Search
          </button>
          <button class="markdown-toolbar-btn" onClick={loadFile}>
            Refresh
          </button>
        </div>
      </div>
      {searchOpen() && (
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
      {error() ? (
        <div class="markdown-error">{error()}</div>
      ) : (
        <div ref={contentRef} class="markdown-content" onClick={handleContentClick} />
      )}
    </div>
  );
}
