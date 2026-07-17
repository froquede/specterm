import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  drawSelection,
  highlightActiveLine,
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { history, defaultKeymap, historyKeymap } from "@codemirror/commands";
import {
  syntaxTree,
  syntaxHighlighting,
  defaultHighlightStyle,
  indentOnInput,
  bracketMatching,
} from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";

// Delimiter tokens ("#", "**", "`", "~~", "[", "]", ">") that the live-preview
// hides when the cursor is elsewhere and reveals when the cursor enters the
// styled node — the Obsidian-style "Live Preview" effect. ListMark is
// intentionally absent: bullets/numbers stay visible.
const HIDDEN_MARKS = new Set([
  "HeaderMark",
  "EmphasisMark",
  "StrikethroughMark",
  "QuoteMark",
  "LinkMark",
]);

// Node → CSS class applied to the whole styled span so it reads like the
// rendered output while you edit.
const CONTENT_CLASS: Record<string, string> = {
  StrongEmphasis: "cm-lp-strong",
  Emphasis: "cm-lp-em",
  Strikethrough: "cm-lp-strike",
  InlineCode: "cm-lp-code",
  ATXHeading1: "cm-lp-h1",
  ATXHeading2: "cm-lp-h2",
  ATXHeading3: "cm-lp-h3",
  ATXHeading4: "cm-lp-h4",
  ATXHeading5: "cm-lp-h5",
  ATXHeading6: "cm-lp-h6",
  SetextHeading1: "cm-lp-h1",
  SetextHeading2: "cm-lp-h2",
  Link: "cm-lp-link",
  Blockquote: "cm-lp-quote",
};

const hiddenDeco = Decoration.replace({});

// Any selection range touching [from, to]? A revealed node keeps its delimiters
// so you can edit the raw markdown; everything else hides them.
function selectionTouches(view: EditorView, from: number, to: number): boolean {
  for (const r of view.state.selection.ranges) {
    if (r.from <= to && r.to >= from) return true;
  }
  return false;
}

function buildDecorations(view: EditorView): DecorationSet {
  // Collect (position, decoration) pairs, then let Decoration.set sort them —
  // content marks and the delimiter hides they contain can share a start
  // position, which a RangeSetBuilder would reject.
  const ranges: { from: number; to: number; deco: Decoration }[] = [];
  const tree = syntaxTree(view.state);

  tree.iterate({
    enter: (node) => {
      const cls = CONTENT_CLASS[node.name];
      if (cls && node.to > node.from) {
        ranges.push({
          from: node.from,
          to: node.to,
          deco: Decoration.mark({ class: cls }),
        });
      }

      if (HIDDEN_MARKS.has(node.name)) {
        // Reveal a delimiter when the cursor is inside its enclosing styled
        // node (the heading line, the emphasis span, the link, …).
        const parent = node.node.parent;
        const pf = parent ? parent.from : node.from;
        const pt = parent ? parent.to : node.to;
        if (!selectionTouches(view, pf, pt) && node.to > node.from) {
          ranges.push({ from: node.from, to: node.to, deco: hiddenDeco });
        }
      }
    },
  });

  // Decoration.set sorts + validates ordering (including equal-start marks).
  return Decoration.set(
    ranges.map((r) => r.deco.range(r.from, r.to)),
    true
  );
}

// Recomputes on edits, cursor moves and viewport changes so delimiters hide/
// reveal as the caret moves.
const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);

// CodeMirror theme wired to the app's CSS variables so the editor matches the
// active terminal/reader theme (light or dark) with no per-theme config.
const appTheme = EditorView.theme({
  "&": {
    color: "var(--fg)",
    backgroundColor: "var(--bg)",
    height: "100%",
    fontSize: "calc(14px * var(--md-font-scale, 1))",
  },
  ".cm-scroller": {
    fontFamily:
      '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, monospace',
    lineHeight: "1.7",
    padding: "24px 32px",
    overflow: "auto",
  },
  ".cm-content": { caretColor: "var(--fg)" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--fg)" },
  ".cm-cursor": { borderLeftColor: "var(--fg)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--selection)",
  },
  ".cm-activeLine": { backgroundColor: "var(--bg-hover)" },
  "&.cm-focused": { outline: "none" },
  // Live-preview styling — mirrors the reader's element styles (markdown.css).
  ".cm-lp-strong": { fontWeight: "700", color: "var(--fg-bright)" },
  ".cm-lp-em": { fontStyle: "italic" },
  ".cm-lp-strike": { textDecoration: "line-through", color: "var(--fg-muted)" },
  ".cm-lp-code": {
    backgroundColor: "var(--bg-hover)",
    borderRadius: "3px",
    padding: "0.1em 0.3em",
  },
  ".cm-lp-link": { color: "var(--accent)" },
  ".cm-lp-quote": { color: "var(--fg-bright)", fontStyle: "italic" },
  ".cm-lp-h1": { fontSize: "1.9em", fontWeight: "700", color: "var(--fg)" },
  ".cm-lp-h2": { fontSize: "1.5em", fontWeight: "700", color: "var(--fg)" },
  ".cm-lp-h3": { fontSize: "1.25em", fontWeight: "700", color: "var(--fg)" },
  ".cm-lp-h4": { fontSize: "1.1em", fontWeight: "700", color: "var(--fg-bright)" },
  ".cm-lp-h5": { fontWeight: "700", color: "var(--fg-bright)" },
  ".cm-lp-h6": { fontWeight: "700", color: "var(--fg-muted)" },
});

interface EditorOptions {
  doc: string;
  parent: HTMLElement;
  // Fired on every document change so the pane can track the dirty state.
  onDocChanged: (view: EditorView) => void;
  // Fired on ⌘S / Ctrl+S. Return true to mark the keypress handled.
  onSave: () => void;
}

// Build the live-preview markdown editor. Kept here (not in the component) so the
// heavy CodeMirror wiring stays out of MarkdownPane. GFM (tables, strikethrough,
// task lists) comes from markdownLanguage as the parser base.
export function createMarkdownEditor(opts: EditorOptions): EditorView {
  const saveKeymap = keymap.of([
    {
      key: "Mod-s",
      run: () => {
        opts.onSave();
        return true;
      },
      preventDefault: true,
    },
  ]);

  const extensions: Extension[] = [
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    highlightActiveLine(),
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    livePreview,
    appTheme,
    EditorView.lineWrapping,
    saveKeymap,
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) opts.onDocChanged(u.view);
    }),
  ];

  return new EditorView({
    state: EditorState.create({ doc: opts.doc, extensions }),
    parent: opts.parent,
  });
}
