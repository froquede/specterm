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
import { matchesCmd, shortcutLabel, isMac } from "../lib/platform";
import {
  highlightCode,
  lineCommentToken,
  looksBinary,
  VIEW_BYTE_CAP,
} from "../lib/textview";
import { IconChevronUp, IconChevronDown, IconX } from "../lib/icons";

interface TextPaneProps {
  filePath: string;
  // ⌘F only acts on the focused pane, so one keypress doesn't toggle find in
  // every open viewer at once.
  isActive?: boolean;
}

// Unsaved edits are auto-persisted as a "draft" in localStorage, keyed by file
// path — same deal as the markdown pane: a cross-tab pane move recreates the
// component, and a reload or app close drops it entirely, so without this the
// buffer would silently vanish. Written debounced while editing (and flushed on
// unmount), consulted on load, cleared on save.
const DRAFT_PREFIX = "specterm.textdraft:";
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

// Viewer/editor for any non-markdown text file. Reading is syntax-highlighted
// (lazily — see lib/textview.ts) with a single-node line-number gutter and
// in-pane find; editing swaps in CodeMirror (lazily too — see lib/text-editor.ts)
// with a Mod-/ comment toggle. Binary and over-cap files stay read-only.
export default function TextPane(props: TextPaneProps) {
  let codeRef!: HTMLElement;
  let searchInputRef!: HTMLInputElement;
  let editorRef!: HTMLDivElement;

  const [error, setError] = createSignal<string | null>(null);
  const [language, setLanguage] = createSignal("plain");
  const [lineCount, setLineCount] = createSignal(0);
  const [truncated, setTruncated] = createSignal(false);

  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [matchCount, setMatchCount] = createSignal(0);
  const [currentMatch, setCurrentMatch] = createSignal(0);

  // "read" = highlighted viewer (default); "edit" = CodeMirror.
  const [mode, setMode] = createSignal<"read" | "edit">("read");
  // The buffer. Runs ahead of savedText (what's on disk) while there are
  // unsaved edits; the difference is `dirty`.
  const [content, setContent] = createSignal("");
  const [savedText, setSavedText] = createSignal("");
  const [dirty, setDirty] = createSignal(false);

  // A truncated view holds only the head of the file, so saving it would throw
  // the rest away; a binary has nothing to edit. Both stay read-only.
  const canEdit = () => !error() && !truncated();

  // Live CodeMirror instance while in edit mode (null in read mode).
  let editorView: EditorView | null = null;

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

  // `force` re-reads from disk and discards any draft (the Refresh button); the
  // default honors a persisted draft so unsaved edits survive a move/reload.
  async function loadFile(force = false) {
    try {
      setError(null);
      const backend = await getBackend();
      let text = await backend.readTextFile(props.filePath);

      if (looksBinary(text)) {
        setError("Can't preview a binary file.");
        codeHtml = "";
        if (codeRef) codeRef.innerHTML = "";
        setContent("");
        setSavedText("");
        setDirty(false);
        setLineCount(0);
        return;
      }

      const isTrunc = text.length > VIEW_BYTE_CAP;
      setTruncated(isTrunc);
      if (isTrunc) text = text.slice(0, VIEW_BYTE_CAP);
      setSavedText(text);

      // Never restore a draft over a truncated file — it isn't editable, and
      // the draft would be a head-only copy of something bigger.
      const draft = force || isTrunc ? null : readDraft(props.filePath);
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
    if (!editorView || !canEdit()) return;
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
    if (!canEdit()) return;
    // Find highlights live in the read view's DOM; leaving them wrapped would
    // strand <mark> nodes in the HTML we restore on the way back.
    if (searchOpen()) closeSearch();
    setMode((m) => (m === "read" ? "edit" : "read"));
  }

  // Render the read view. Never touches disk — edit → read shows the live
  // buffer, unsaved changes and all.
  async function renderRead(text: string) {
    const { html, language: lang } = await highlightCode(text, props.filePath);
    codeHtml = html;
    setLanguage(lang);
    // Trailing newline shouldn't add a phantom blank-numbered line.
    const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
    setLineCount(normalized === "" ? 1 : normalized.split("\n").length);
    if (codeRef) codeRef.innerHTML = codeHtml;

    // Re-apply an active search against the freshly rendered content.
    if (searchOpen() && searchQuery()) applyHighlights(searchQuery());
  }

  createEffect(() => {
    const text = content();
    if (mode() !== "read" || error() || !codeRef) return;
    void renderRead(text);
  });

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
    import("../lib/text-editor").then(({ createTextEditor }) => {
      if (disposed || !editorRef) return;
      view = createTextEditor({
        doc: initialDoc,
        parent: editorRef,
        commentToken: lineCommentToken(props.filePath),
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
      if (view) {
        // Carry the (possibly unsaved) buffer back so the reader shows it.
        setContent(view.state.doc.toString());
        view.destroy();
        editorView = null;
      }
    });
  });

  onMount(() => {
    // loadFile() restores a persisted draft when there is one, so a pane moved
    // between tabs (or reopened after a reload/close) comes back with its
    // unsaved edits rather than the on-disk copy.
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
    if (!matchesCmd(e)) return;
    const key = e.key.toLowerCase();

    // ⌘E toggles read/edit from either mode.
    if (key === "e" && canEdit()) {
      e.preventDefault();
      e.stopPropagation();
      toggleMode();
      return;
    }
    // ⌘S saves — only meaningful while editing. (CodeMirror also binds the
    // bare Mod-s inside the editor; this is the app-wide spelling of it.)
    if (key === "s" && mode() === "edit") {
      e.preventDefault();
      e.stopPropagation();
      save();
      return;
    }
    // ⌘F toggles find — read mode only (the editor owns its own keys).
    if (key === "f" && mode() === "read") {
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

  // Mod-/ is bound inside CodeMirror, which spells it the platform-native way
  // (⌘ on macOS, plain Ctrl elsewhere) rather than through the app's
  // ⌘→Ctrl+Shift translation.
  const commentLabel = isMac ? "⌘/" : "Ctrl+/";

  return (
    <div class="text-pane">
      <div class="text-toolbar">
        <span class="text-filepath">
          {dirty() ? "● " : ""}
          {props.filePath}
        </span>
        <div class="text-toolbar-actions">
          <Show when={language() !== "plain" && mode() === "read"}>
            <span class="text-lang">{language()}</span>
          </Show>
          <Show when={mode() === "edit"}>
            <Show when={lineCommentToken(props.filePath)}>
              <span class="text-hint" title="Toggle comment on the selected lines">
                {commentLabel}
              </span>
            </Show>
            <button
              class="text-toolbar-btn"
              onClick={save}
              disabled={!dirty()}
              title={`Save (${shortcutLabel("S")})`}
            >
              Save
            </button>
          </Show>
          <Show when={canEdit()}>
            <button
              class="text-toolbar-btn"
              onClick={toggleMode}
              title={`${mode() === "read" ? "Edit" : "View"} (${shortcutLabel("E")})`}
            >
              {mode() === "read" ? "Edit" : "View"}
            </button>
          </Show>
          <Show when={mode() === "read"}>
            <button
              class="text-toolbar-btn"
              onClick={() => (searchOpen() ? closeSearch() : openSearch())}
              title={`Find (${shortcutLabel("F")})`}
            >
              Find
            </button>
            {/* Refresh re-reads from disk (discarding any draft), so it's
                read-mode only — in edit mode it would drop unsaved changes. */}
            <button class="text-toolbar-btn" onClick={() => loadFile(true)}>
              Refresh
            </button>
          </Show>
        </div>
      </div>
      <Show when={mode() === "read" && searchOpen()}>
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
          <button class="text-search-btn" title="Previous match" onClick={() => navigateMatch(-1)}>
            <IconChevronUp size={13} stroke-width={2} />
          </button>
          <button class="text-search-btn" title="Next match" onClick={() => navigateMatch(1)}>
            <IconChevronDown size={13} stroke-width={2} />
          </button>
          <button class="text-search-btn" title="Close (Esc)" onClick={closeSearch}>
            <IconX size={13} stroke-width={2} />
          </button>
        </div>
      </Show>
      <Show when={truncated()}>
        <div class="text-truncated">
          File is larger than {Math.round(VIEW_BYTE_CAP / (1024 * 1024))} MB — showing
          the first part only, and it can't be edited from here.
        </div>
      </Show>
      <Show when={!error()} fallback={<div class="text-error">{error()}</div>}>
        <Show when={mode() === "edit"}>
          <div ref={editorRef} class="text-editor" />
        </Show>
        <Show when={mode() === "read"}>
          <div class="text-body">
            <pre class="text-gutter" aria-hidden="true">{gutter()}</pre>
            <pre class="text-code"><code ref={codeRef} /></pre>
          </div>
        </Show>
      </Show>
    </div>
  );
}
