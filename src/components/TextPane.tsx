import { createSignal, onMount, onCleanup, Show } from "solid-js";
import { getBackend } from "../backends";
import { matchesCmd, shortcutLabel } from "../lib/platform";
import {
  highlightCode,
  looksBinary,
  VIEW_BYTE_CAP,
} from "../lib/textview";

interface TextPaneProps {
  filePath: string;
  // ⌘F only acts on the focused pane, so one keypress doesn't toggle find in
  // every open viewer at once.
  isActive?: boolean;
}

// Read-only viewer for any non-markdown text file. Syntax-highlighted (lazily —
// see lib/textview.ts), with a single-node line-number gutter, in-pane find, and
// binary/size guards so a stray click on a huge log or a binary never janks the
// terminal.
export default function TextPane(props: TextPaneProps) {
  let codeRef!: HTMLElement;
  let searchInputRef!: HTMLInputElement;

  const [error, setError] = createSignal<string | null>(null);
  const [language, setLanguage] = createSignal("plain");
  const [lineCount, setLineCount] = createSignal(0);
  const [truncated, setTruncated] = createSignal(false);

  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [matchCount, setMatchCount] = createSignal(0);
  const [currentMatch, setCurrentMatch] = createSignal(0);

  // The pristine highlighted HTML, kept so find can re-render before wrapping
  // matches (and restore on close) without re-reading or re-highlighting.
  let codeHtml = "";

  // "1\n2\n…\nN" as ONE text node — the gutter must not cost a node per line.
  const gutter = () => {
    const n = lineCount();
    if (n === 0) return "";
    let s = "1";
    for (let i = 2; i <= n; i++) s += "\n" + i;
    return s;
  };

  async function loadFile() {
    try {
      setError(null);
      const backend = await getBackend();
      let text = await backend.readTextFile(props.filePath);

      if (looksBinary(text)) {
        setError("Can't preview a binary file.");
        codeHtml = "";
        if (codeRef) codeRef.innerHTML = "";
        setLineCount(0);
        return;
      }

      const isTrunc = text.length > VIEW_BYTE_CAP;
      setTruncated(isTrunc);
      if (isTrunc) text = text.slice(0, VIEW_BYTE_CAP);

      const { html, language: lang } = await highlightCode(text, props.filePath);
      codeHtml = html;
      setLanguage(lang);
      // Trailing newline shouldn't add a phantom blank-numbered line.
      const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
      setLineCount(normalized === "" ? 1 : normalized.split("\n").length);
      if (codeRef) codeRef.innerHTML = codeHtml;

      // Re-apply an active search against the freshly loaded content.
      if (searchOpen() && searchQuery()) applyHighlights(searchQuery());
    } catch (e) {
      setError(`Failed to read file: ${props.filePath}\n${e}`);
    }
  }

  onMount(loadFile);

  function restoreCode() {
    if (codeRef) codeRef.innerHTML = codeHtml;
  }

  // Wrap query matches in the code body with <mark>, walking text nodes so we
  // never break the highlight spans. Content is capped, so this stays cheap.
  function applyHighlights(query: string) {
    restoreCode();
    if (!codeRef || !query) {
      setMatchCount(0);
      setCurrentMatch(0);
      return;
    }
    const walker = document.createTreeWalker(codeRef, NodeFilter.SHOW_TEXT, null);
    const targets: { node: Text; text: string }[] = [];
    let n: Text | null;
    while ((n = walker.nextNode() as Text | null)) {
      if (n.parentElement?.tagName === "MARK") continue;
      targets.push({ node: n, text: n.textContent || "" });
    }
    const lowerQuery = query.toLowerCase();
    const marks: HTMLElement[] = [];
    for (const { node, text } of targets) {
      const lower = text.toLowerCase();
      const idxs: number[] = [];
      let from = 0;
      for (;;) {
        const i = lower.indexOf(lowerQuery, from);
        if (i === -1) break;
        idxs.push(i);
        from = i + lowerQuery.length;
      }
      if (!idxs.length) continue;
      const parent = node.parentNode;
      if (!parent) continue;
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const i of idxs) {
        if (i > last) frag.appendChild(document.createTextNode(text.slice(last, i)));
        const mark = document.createElement("mark");
        mark.className = "search-highlight";
        mark.textContent = text.slice(i, i + query.length);
        frag.appendChild(mark);
        marks.push(mark);
        last = i + query.length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      parent.replaceChild(frag, node);
    }
    setMatchCount(marks.length);
    if (marks.length) {
      setCurrentMatch(1);
      scrollToMatch(0);
    } else {
      setCurrentMatch(0);
    }
  }

  function scrollToMatch(index: number) {
    const marks = codeRef?.querySelectorAll("mark.search-highlight");
    if (!marks || !marks.length) return;
    marks.forEach((m) => m.classList.remove("search-active"));
    const target = marks[index] as HTMLElement | undefined;
    if (target) {
      target.classList.add("search-active");
      target.scrollIntoView({ block: "center" });
    }
  }

  function navigateMatch(dir: 1 | -1) {
    const total = matchCount();
    if (!total) return;
    let next = currentMatch() + dir;
    if (next > total) next = 1;
    if (next < 1) next = total;
    setCurrentMatch(next);
    scrollToMatch(next - 1);
  }

  let searchTimer: number | null = null;
  function onSearchInput(value: string) {
    setSearchQuery(value);
    if (searchTimer) clearTimeout(searchTimer);
    if (!value) {
      restoreCode();
      setMatchCount(0);
      setCurrentMatch(0);
      return;
    }
    searchTimer = window.setTimeout(() => applyHighlights(value), 200);
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
    restoreCode();
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (!props.isActive) return;
    if (matchesCmd(e) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      e.stopPropagation();
      searchOpen() ? closeSearch() : openSearch();
    }
  }

  onMount(() => window.addEventListener("keydown", handleKeyDown, true));
  onCleanup(() => {
    window.removeEventListener("keydown", handleKeyDown, true);
    if (searchTimer) clearTimeout(searchTimer);
  });

  return (
    <div class="text-pane">
      <div class="text-toolbar">
        <span class="text-filepath">{props.filePath}</span>
        <div class="text-toolbar-actions">
          <Show when={language() !== "plain"}>
            <span class="text-lang">{language()}</span>
          </Show>
          <button
            class="text-toolbar-btn"
            onClick={() => (searchOpen() ? closeSearch() : openSearch())}
            title={`Find (${shortcutLabel("F")})`}
          >
            Find
          </button>
          <button class="text-toolbar-btn" onClick={loadFile}>
            Refresh
          </button>
        </div>
      </div>
      <Show when={searchOpen()}>
        <div class="text-search">
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Find in file..."
            value={searchQuery()}
            onInput={(e) => onSearchInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") closeSearch();
              else if (e.key === "Enter") {
                e.preventDefault();
                navigateMatch(e.shiftKey ? -1 : 1);
              }
            }}
          />
          <span class="text-search-count">
            {matchCount() > 0
              ? `${currentMatch()}/${matchCount()}`
              : searchQuery()
                ? "No results"
                : ""}
          </span>
          <button class="text-search-btn" onClick={() => navigateMatch(-1)}>▲</button>
          <button class="text-search-btn" onClick={() => navigateMatch(1)}>▼</button>
          <button class="text-search-btn" onClick={closeSearch}>×</button>
        </div>
      </Show>
      <Show when={truncated()}>
        <div class="text-truncated">
          File is larger than {Math.round(VIEW_BYTE_CAP / (1024 * 1024))} MB — showing
          the first part only.
        </div>
      </Show>
      <Show
        when={!error()}
        fallback={<div class="text-error">{error()}</div>}
      >
        <div class="text-body">
          <pre class="text-gutter" aria-hidden="true">{gutter()}</pre>
          <pre class="text-code"><code ref={codeRef} /></pre>
        </div>
      </Show>
    </div>
  );
}
