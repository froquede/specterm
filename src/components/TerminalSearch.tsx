import { createSignal, onMount, onCleanup } from "solid-js";
import type { ISearchOptions } from "@xterm/addon-search";
import { getTerminalInstance } from "../lib/terminal-registry";
import { closeSearch } from "../stores/terminal-search";

// Match highlight colors (Tokyo Night): all matches in blue, the active one in
// orange so it stands out as you step through results.
const DECORATIONS: ISearchOptions["decorations"] = {
  matchBackground: "#3d59a1",
  matchBorder: "#7aa2f7",
  matchOverviewRuler: "#7aa2f7",
  activeMatchBackground: "#e0af68",
  activeMatchBorder: "#ff9e64",
  activeMatchColorOverviewRuler: "#ff9e64",
};

interface TerminalSearchProps {
  paneId: string;
}

export default function TerminalSearch(props: TerminalSearchProps) {
  const [query, setQuery] = createSignal("");
  const [caseSensitive, setCaseSensitive] = createSignal(false);
  // 1-based index of the active match and the total; {0,0} means no results.
  const [result, setResult] = createSignal({ index: 0, total: 0 });
  let inputRef!: HTMLInputElement;

  const addon = () => getTerminalInstance(props.paneId)?.searchAddon;

  const options = (incremental: boolean): ISearchOptions => ({
    caseSensitive: caseSensitive(),
    incremental,
    decorations: DECORATIONS,
  });

  // dir: +1 next, -1 previous. `incremental` keeps the current match while the
  // query is still being typed instead of jumping ahead on every keystroke.
  function find(dir: 1 | -1, incremental = false) {
    const a = addon();
    if (!a) return;
    const q = query();
    if (!q) {
      a.clearDecorations();
      setResult({ index: 0, total: 0 });
      return;
    }
    if (dir === 1) a.findNext(q, options(incremental));
    else a.findPrevious(q, options(false));
  }

  function close() {
    addon()?.clearDecorations();
    closeSearch();
    // Hand keyboard control back to the terminal we were searching.
    getTerminalInstance(props.paneId)?.term.focus();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter") {
      e.preventDefault();
      find(e.shiftKey ? -1 : 1);
    }
  }

  onMount(() => {
    const sub = addon()?.onDidChangeResults((r) => {
      setResult({
        index: r.resultIndex >= 0 ? r.resultIndex + 1 : 0,
        total: r.resultCount,
      });
    });
    // Pre-fill nothing, just take focus so the user can type immediately.
    inputRef.focus();
    onCleanup(() => {
      sub?.dispose();
      addon()?.clearDecorations();
    });
  });

  return (
    <div class="term-search">
      <input
        ref={inputRef}
        class="term-search-input"
        type="text"
        placeholder="Find"
        spellcheck={false}
        autocomplete="off"
        value={query()}
        onInput={(e) => {
          setQuery(e.currentTarget.value);
          find(1, true);
        }}
        onKeyDown={onKeyDown}
      />
      <span class="term-search-count">
        {query() ? `${result().index}/${result().total}` : ""}
      </span>
      {/* preventDefault on mousedown keeps focus in the input when clicking
          a control, so typing continues uninterrupted. */}
      <button
        class="term-search-btn"
        title="Previous match (⇧⏎)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => find(-1)}
      >
        ↑
      </button>
      <button
        class="term-search-btn"
        title="Next match (⏎)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => find(1)}
      >
        ↓
      </button>
      <button
        class={`term-search-btn ${caseSensitive() ? "term-search-btn-active" : ""}`}
        title="Match case"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setCaseSensitive((v) => !v);
          find(1);
        }}
      >
        Aa
      </button>
      <button
        class="term-search-btn"
        title="Close (Esc)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={close}
      >
        ×
      </button>
    </div>
  );
}
