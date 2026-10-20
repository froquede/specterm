// Keeping a selection on the text it was made on while the program redraws.
//
// xterm pins a selection to buffer rows. That is right for a shell, whose
// output scrolls by moving rows into the scrollback — the rows carry the text
// with them, and the selection with it. It is wrong for a program that scrolls
// by redrawing: Claude Code scrolling its transcript, less, vim. The rows stay
// where they are and new text is painted into them, so the highlight stays put
// on the screen while the text it was on slides out from under it, and ⌘C
// copies whatever is under the highlight now.
//
// So the selected rows are remembered as text, and after each write the
// selection is moved to wherever that text went: the nearest offset at which
// the rows read the same again. Rows pushed off the edge of the buffer are left
// out of the match and the highlight is clipped to what is still there. When
// the text can't be found at all — scrolled away, or rewritten — the highlight
// comes down, but the selection isn't forgotten: ⌘C still copies it, and it
// comes back up if the text scrolls back into view. Typing, or making a new
// selection, is what lets it go.
//
// The copy text is taken when the selection is made (lib/selection-text.ts),
// not when ⌘C is pressed, for the same reason: by then the rows may hold
// something else.

import type { Terminal } from "@xterm/xterm";
import { selectionText } from "./selection-text";

// A selection taller than this is left to xterm alone — select-all over a long
// scrollback, mostly. Remembering it would mean copying it on every change of
// the drag, and nobody expects one that size to follow a redraw.
const MAX_FOLLOW_ROWS = 400;

// How little of the selection may be left to recognize it by. Below this, the
// rows still on screen ("}", a blank, a lone "-") read the same at too many
// offsets for the match to mean anything.
const MIN_MATCH_CHARS = 8;

interface Remembered {
  // Buffer row and column the selection starts at. The row can go negative, or
  // past the end of the buffer, while the text is partly out of it.
  x: number;
  y: number;
  // Its length in cells, the way term.select counts it.
  length: number;
  // The text of each row it covers, as they read when it was made.
  rows: string[];
  // What it copies as.
  text: string;
  // Whether the highlight is down because the text is nowhere to be seen.
  hidden: boolean;
}

export interface SelectionFollow {
  /** What the current selection copies as; null when there is none. */
  text(): string | null;
  dispose(): void;
}

/**
 * Keep `term`'s selection on its text across redraws. `isTyping` tells input
 * the user typed apart from the mouse and focus reports a program asked for,
 * which arrive down the same channel and mustn't let go of the selection.
 */
export function installSelectionFollow(
  term: Terminal,
  copyText: (term: Terminal) => string,
  isTyping: (data: string) => boolean
): SelectionFollow {
  let remembered: Remembered | null = null;
  // Set while we move or drop the selection ourselves, so the change it fires
  // isn't mistaken for the user's.
  let ours = false;
  let frame: number | null = null;

  const rowText = (y: number) =>
    term.buffer.active.getLine(y)?.translateToString(true) ?? "";

  function remember() {
    const range = term.getSelectionPosition();
    if (!range || range.end.y - range.start.y + 1 > MAX_FOLLOW_ROWS) {
      remembered = null;
      return;
    }
    const rows: string[] = [];
    for (let y = range.start.y; y <= range.end.y; y++) rows.push(rowText(y));
    remembered = {
      x: range.start.x,
      y: range.start.y,
      length: (range.end.y - range.start.y) * term.cols + range.end.x - range.start.x,
      rows,
      text: copyText(term),
      hidden: false,
    };
  }

  function apply(fn: () => void) {
    ours = true;
    try {
      fn();
    } finally {
      ours = false;
    }
  }

  // Do the remembered rows read the same starting at buffer row `top`? Rows
  // outside the buffer are skipped, but enough has to be left to tell.
  function readsSameAt(sel: Remembered, top: number, cache: Map<number, string>): boolean {
    const length = term.buffer.active.length;
    let matched = 0;
    let total = 0;
    for (let i = 0; i < sel.rows.length; i++) {
      const want = sel.rows[i];
      total += want.trim().length;
      const y = top + i;
      if (y < 0 || y >= length) continue;
      let have = cache.get(y);
      if (have === undefined) {
        have = rowText(y);
        cache.set(y, have);
      }
      if (have !== want) return false;
      matched += want.trim().length;
    }
    return matched >= Math.min(MIN_MATCH_CHARS, total) && matched > 0;
  }

  function follow() {
    frame = null;
    const sel = remembered;
    if (!sel) return;
    const buf = term.buffer.active;
    const cache = new Map<number, string>();
    if (!sel.hidden && readsSameAt(sel, sel.y, cache)) return;

    // Nearest offset first: a redraw moves text a few rows, and the same text
    // further away (a command repeated in the transcript) is the wrong one. The
    // search covers the screen and a screen's worth above it, which is where a
    // redraw can put anything.
    const lo = buf.baseY - term.rows - sel.rows.length;
    const hi = buf.baseY + term.rows;
    let found: number | null = null;
    for (let d = 0; found === null; d++) {
      const up = sel.y - d;
      const down = sel.y + d;
      if (up < lo && down > hi) break;
      if (down <= hi && down >= lo && readsSameAt(sel, down, cache)) found = down;
      else if (d > 0 && up >= lo && up <= hi && readsSameAt(sel, up, cache)) found = up;
    }

    if (found === null) {
      if (!sel.hidden) apply(() => term.clearSelection());
      sel.hidden = true;
      return;
    }

    sel.y = found;
    sel.hidden = false;
    // Clip to the buffer: term.select can't start above row 0 or run past the
    // last row.
    const cols = term.cols;
    const from = Math.max(0, sel.y * cols + sel.x);
    const to = Math.min(buf.length * cols, sel.y * cols + sel.x + sel.length);
    if (to <= from) return;
    apply(() => term.select(from % cols, Math.floor(from / cols), to - from));
  }

  const subs = [
    term.onSelectionChange(() => {
      if (ours) return;
      if (term.hasSelection()) remember();
      else remembered = null;
    }),
    term.onWriteParsed(() => {
      if (remembered && frame === null) frame = requestAnimationFrame(follow);
    }),
    // A resize reflows the rows, so the remembered ones no longer describe
    // anything: from here the selection is xterm's alone.
    term.onResize(() => {
      remembered = null;
    }),
    term.onData((data) => {
      if (remembered?.hidden && isTyping(data)) remembered = null;
    }),
  ];

  return {
    text() {
      if (remembered) return remembered.text;
      return term.hasSelection() ? copyText(term) : null;
    },
    dispose() {
      if (frame !== null) cancelAnimationFrame(frame);
      for (const sub of subs) sub.dispose();
    },
  };
}
