import { EditorState, type ChangeSpec, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  lineNumbers,
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type KeyBinding,
  type ViewUpdate,
} from "@codemirror/view";
import { history, defaultKeymap, historyKeymap } from "@codemirror/commands";

// Plain-text/code editor behind TextPane's edit mode. Deliberately *not* a
// second markdown editor: no language grammar, no live preview, no extra
// dependency. It is CodeMirror's core plus three things the read-only viewer
// can't do — typing, a comment toggle, and a save key.
//
// Like the markdown editor (and mermaid, and highlight.js) this module is
// dynamic-imported on the first switch to edit mode, so a terminal that never
// opens a file never pays for CodeMirror.

/**
 * Toggle the line comment on every line the selection touches, each line
 * independently: a commented line loses its token, an uncommented one gains it.
 * Blank lines are skipped — there is nothing to comment out.
 *
 * The token goes after the indentation, not at column 0, so toggling a nested
 * line back and forth doesn't reflow it.
 */
export function toggleLineComment(view: EditorView, token: string): boolean {
  const { state } = view;
  const changes: ChangeSpec[] = [];
  // Multi-cursor selections can land twice on the same line; edit it once.
  const seen = new Set<number>();

  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      const line = state.doc.line(n);
      const indent = line.text.length - line.text.trimStart().length;
      const body = line.text.slice(indent);
      if (body === "") continue;
      const at = line.from + indent;
      if (body.startsWith(token)) {
        // Take the single padding space back out with the token, so a round
        // trip returns the exact original line.
        const pad = body[token.length] === " " ? 1 : 0;
        changes.push({ from: at, to: at + token.length + pad });
      } else {
        changes.push({ from: at, insert: token + " " });
      }
    }
  }

  if (changes.length === 0) return true; // blank selection: swallow the key
  view.dispatch(
    state.update({ changes, scrollIntoView: true, userEvent: "input.comment" })
  );
  return true;
}

const commentedLine = Decoration.line({ class: "cm-commented" });

// Dim commented-out lines. This is the whole of our "syntax highlighting" in
// edit mode, and for the files people actually edit here (.env, .conf, .ini)
// it's the distinction that matters: which settings are live.
function commentDecorations(view: EditorView, token: string): DecorationSet {
  const ranges = [];
  // Visible ranges only — this reruns on every edit and scroll, and walking a
  // whole large file line by line is exactly the main-thread stall this app
  // exists to avoid.
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      if (line.text.trimStart().startsWith(token)) {
        ranges.push(commentedLine.range(line.from));
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(ranges, true);
}

function commentHighlighter(token: string) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = commentDecorations(view, token);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) {
          this.decorations = commentDecorations(u.view, token);
        }
      }
    },
    { decorations: (v) => v.decorations }
  );
}

// Wired to the app's CSS variables, so the editor recolors with the theme just
// like the read-only viewer it replaces. Metrics mirror `.text-body` /
// `.text-gutter` in styles/text.css so toggling modes doesn't shift the text.
const appTheme = EditorView.theme({
  "&": {
    color: "var(--fg)",
    backgroundColor: "var(--bg)",
    height: "100%",
    fontSize: "13px",
  },
  ".cm-scroller": {
    fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
    lineHeight: "1.5",
    overflow: "auto",
  },
  ".cm-content": { caretColor: "var(--fg)", padding: "8px 0" },
  ".cm-gutters": {
    backgroundColor: "var(--bg)",
    color: "var(--fg-faint)",
    borderRight: "1px solid var(--border)",
    paddingTop: "8px",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 12px" },
  ".cm-activeLineGutter": { backgroundColor: "var(--bg-hover)", color: "var(--fg-muted)" },
  ".cm-activeLine": { backgroundColor: "var(--bg-hover)" },
  ".cm-cursor": { borderLeftColor: "var(--fg)" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--fg)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--selection)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-commented": { color: "var(--fg-faint)", fontStyle: "italic" },
});

export interface TextEditorOptions {
  doc: string;
  parent: HTMLElement;
  // Line comment for Mod-/ (see lib/textview.ts). null leaves the key unbound.
  commentToken: string | null;
  // Fired on every document change so the pane can track the dirty state.
  onDocChanged: (view: EditorView) => void;
  // Fired on ⌘S / Ctrl+S.
  onSave: () => void;
}

export function createTextEditor(opts: TextEditorOptions): EditorView {
  const token = opts.commentToken;

  const bindings: KeyBinding[] = [
    {
      key: "Mod-s",
      run: () => {
        opts.onSave();
        return true;
      },
      preventDefault: true,
    },
  ];
  if (token) {
    bindings.push({
      key: "Mod-/",
      run: (view) => toggleLineComment(view, token),
      preventDefault: true,
    });
  }

  const extensions: Extension[] = [
    lineNumbers(),
    history(),
    drawSelection(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    appTheme,
    // Ahead of defaultKeymap so Mod-s is ours rather than the browser's.
    keymap.of(bindings),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) opts.onDocChanged(u.view);
    }),
  ];
  if (token) extensions.push(commentHighlighter(token));

  return new EditorView({
    state: EditorState.create({ doc: opts.doc, extensions }),
    parent: opts.parent,
  });
}
