// Which link a buffer cell belongs to.
//
// A link is matched against the line as it was written, not against the row
// it happens to be drawn on: a path longer than the pane spans two rows or
// more, and the matcher has to see it whole. There are two ways a line ends up
// on several rows, and xterm only reports one of them.
//
// - The terminal wrapped it. Text written past the last column carries on in
//   the next row, which xterm flags `isWrapped`. A shell printing a long path
//   does this.
// - The program wrapped it. A TUI lays out its own rows and draws each one
//   with cursor moves, so nothing ever runs past the edge and nothing gets
//   flagged. Claude Code does this to every message: a word too long for the
//   row is broken at the last column and carries on two cells in, under the
//   text of the row above it.
//
// The second kind has to be inferred, and prose is where inferring goes wrong:
// a word that happens to end exactly at the last column looks the same as a
// word broken there, and gluing the next row's first word onto a path copies
// a path that doesn't exist. What tells them apart is the wrapper's own rule
// (wrap-ansi with `hard: true`, which is what Ink uses): it only breaks a word
// in the middle when the word is longer than a row. One that merely doesn't fit
// in the space left moves to the next row whole. So the two rows are joined only
// when the characters running into the edge and the ones the next row starts
// with are, together, too long to have fitted on a row. That still reads two
// words as one when the first fills nearly the whole row and the second is
// long too — rare enough to live with, where a short path landing on the last
// column is not.
//
// DOM-free on purpose, like lib/path-links.ts: this is guessing too, so it is
// tested against a stand-in buffer (test/link-target.mjs). Keep it erasable
// TypeScript — the test strips types with node rather than compiling.

import type { IBuffer, IBufferCell, IBufferLine, Terminal } from "@xterm/xterm";
import { findPathLinks } from "./path-links";

// How far the wrap walk will travel from the hovered row. A path can wrap once
// or twice; a run of rows longer than this is a paragraph, and rebuilding it on
// every redraw would cost more than the link is worth.
const MAX_WRAP_ROWS = 8;

// How much of the logical line around the hovered character is handed to the
// matcher. findPathLinks retries its patterns from every position of an
// unbroken run, so a soft-wrapped JWT or hex dump costs quadratically — ~50ms
// for 3,400 characters, on every refresh. A path longer than this on either
// side of the pointer is not one anybody clicks.
const MATCH_WINDOW = 256;

// How far short of the last column a row the program wrapped may stop. A box
// drawn with padding on its right (Claude Code's prompt) ends its text one
// cell in.
const EDGE_SLACK = 1;

interface MappedLine {
  // The logical line as a string, wrapped rows stitched back together.
  text: string;
  // Buffer coordinates of each character in `text`. Kept as a parallel array
  // rather than computed, because a wide char (CJK, an emoji) is two cells for
  // one character and a combining mark is two characters in one cell — so
  // string index and column drift apart the moment output isn't ASCII. It is
  // also what lets a continuation row's indent be left out of the text.
  cells: { y: number; x: number }[];
}

/** What the pointer is currently over, in buffer coordinates. */
export interface HoverTarget {
  text: string;
  kind: "path" | "url";
  // One entry per buffer row the span covers, so a wrapped path draws as two
  // underlines rather than one impossible rectangle.
  segments: { y: number; x0: number; x1: number }[];
}

/** The part of a terminal this needs: where its buffer is and how wide it is. */
type BufferView = Pick<Terminal, "buffer" | "cols">;

/**
 * An empty cell: never written (a TUI moves the cursor over the gap between
 * words rather than printing spaces) or holding whitespace. The second half of
 * a wide character is not empty — it belongs to the character before it.
 */
function isBlank(line: IBufferLine, x: number, cell: IBufferCell): boolean {
  if (!line.getCell(x, cell)) return true;
  if (cell.getWidth() === 0) return false;
  const chars = cell.getChars();
  return chars === "" || chars === " " || chars === " ";
}

/**
 * Where a row's text starts and ends, and the unbroken runs at either end of
 * it — the run a broken word would leave against the right edge, and the one
 * its remainder would start the next row with. Null for a blank row.
 */
function textSpan(
  line: IBufferLine,
  cell: IBufferCell
): { first: number; last: number; headEnd: number; tailStart: number } | null {
  let first = -1;
  let last = -1;
  let headEnd = -1;
  let tailStart = -1;
  for (let x = 0; x < line.length; x++) {
    if (isBlank(line, x, cell)) continue;
    if (first === -1) first = tailStart = x;
    else if (last !== x - 1) tailStart = x;
    if (tailStart === first) headEnd = x;
    last = x;
  }
  return first === -1 ? null : { first, last, headEnd, tailStart };
}

/**
 * Whether buffer row `y` carries on in row `y + 1`, and how: "soft" when the
 * terminal wrapped it (the next row is whole, flagged by xterm), "hard" when
 * the program did (the edge's padding and the next row's indent aren't part of
 * the line). Null when the two rows are separate lines.
 */
function wrapAfter(
  buf: IBuffer,
  cols: number,
  y: number,
  cell: IBufferCell
): "soft" | "hard" | null {
  const next = buf.getLine(y + 1);
  const line = buf.getLine(y);
  if (!next || !line) return null;
  if (next.isWrapped) return "soft";

  // A broken word runs into the right edge.
  const here = textSpan(line, cell);
  if (!here || here.last < cols - 1 - EDGE_SLACK) return null;

  // And carries on indented: a wrapper that lays out its own rows keeps them
  // inside a margin. A row that starts at column zero is how plain output that
  // happened to fill the width exactly (`cat` on a file of 80-column lines)
  // follows its predecessor, and those are separate lines.
  const below = textSpan(next, cell);
  if (!below || below.first === 0) return null;

  // Too long to have fitted on the next row, so the wrapper had to break it.
  // Shorter, and it was two words that happened to meet at the edge.
  const run = here.last - here.tailStart + 1 + (below.headEnd - below.first + 1);
  return run > cols - below.first - EDGE_SLACK ? "hard" : null;
}

/**
 * Rebuild the logical line that passes through buffer row `rowIndex`, following
 * wraps of either kind in both directions, along with the map back to buffer
 * cells.
 */
function mapLogicalLine(term: BufferView, rowIndex: number): MappedLine | null {
  const buf = term.buffer.active;
  if (rowIndex < 0 || !buf.getLine(rowIndex)) return null;

  // One cell object, refilled per column. This runs while the pointer moves
  // across a pane, so a fresh object per cell would be a few hundred
  // allocations per row hovered.
  const cell = buf.getNullCell();

  // How each row in the line hands over to the next, indexed from `top`.
  const wraps: ("soft" | "hard")[] = [];
  let top = rowIndex;
  while (top > 0 && rowIndex - top < MAX_WRAP_ROWS) {
    const wrap = wrapAfter(buf, term.cols, top - 1, cell);
    if (!wrap) break;
    wraps.unshift(wrap);
    top--;
  }
  let bottom = rowIndex;
  while (bottom - rowIndex < MAX_WRAP_ROWS) {
    const wrap = wrapAfter(buf, term.cols, bottom, cell);
    if (!wrap) break;
    wraps.push(wrap);
    bottom++;
  }

  let text = "";
  const cells: { y: number; x: number }[] = [];
  for (let y = top; y <= bottom; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    // Where the program wrapped, its layout comes off: the indent the next
    // row starts with and whatever padding this one ends with are margins,
    // not part of the line.
    let x0 = 0;
    let x1 = line.length - 1;
    if (wraps[y - top - 1] === "hard" || wraps[y - top] === "hard") {
      const span = textSpan(line, cell);
      if (span && wraps[y - top - 1] === "hard") x0 = span.first;
      if (span && wraps[y - top] === "hard") x1 = span.last;
    }
    for (let x = x0; x <= x1; x++) {
      if (!line.getCell(x, cell)) continue;
      // Width 0 is the second half of a wide character — already accounted for
      // by the cell that owns it.
      if (cell.getWidth() === 0) continue;
      const chars = cell.getChars() || " ";
      for (let i = 0; i < chars.length; i++) cells.push({ y, x });
      text += chars;
    }
  }
  return { text, cells };
}

/** The link under buffer cell (col, row), or null. */
export function targetAt(term: BufferView, col: number, row: number): HoverTarget | null {
  const mapped = mapLogicalLine(term, row);
  if (!mapped) return null;

  const hovered = mapped.cells.findIndex((c) => c.y === row && c.x === col);
  if (hovered === -1) return null;
  const from = Math.max(0, hovered - MATCH_WINDOW);
  const text = mapped.text.slice(from, hovered + MATCH_WINDOW + 1);

  for (const match of findPathLinks(text)) {
    let hit = false;
    const segments: { y: number; x0: number; x1: number }[] = [];
    for (let i = from + match.start; i < from + match.end; i++) {
      const cell = mapped.cells[i];
      if (!cell) continue;
      if (cell.y === row && cell.x === col) hit = true;
      const last = segments[segments.length - 1];
      if (last && last.y === cell.y) last.x1 = Math.max(last.x1, cell.x);
      else segments.push({ y: cell.y, x0: cell.x, x1: cell.x });
    }
    if (hit && segments.length) {
      return { text: match.text, kind: match.kind, segments };
    }
  }
  return null;
}
