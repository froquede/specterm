// The text a terminal selection copies as.
//
// xterm copies a selection row by row: one line per row, except where it
// wrapped the text itself (`isWrapped`), which it joins back up. That is right
// for a shell and wrong for Claude Code, which lays out its own rows — a long
// command in `⏺ Bash(…)` or a paragraph of its reply arrives as several rows,
// each drawn with cursor moves, none of them flagged. Copy one and you get a
// line break at every row and the continuation indent in front of each, so a
// command pasted into a shell runs as several, and pasted anywhere else has to
// be patched up by hand.
//
// So the rows a program wrapped are joined back up too, using the rule that
// lib/link-target.ts uses to stitch a broken path, plus one for the commoner
// case: a word that didn't fit in the space left on the row moves to the next
// one whole. Two rows are a word wrap when the next row's first word would not
// have fitted after the last character of this one — had it fitted, the
// wrapper would have put it there, so the break was in the text.
//
// What keeps this away from everything that isn't a wrapper laying out rows is
// how the next row's indent was made. Claude Code moves the cursor to where the
// text starts (`ESC [ n G`), so the cells in front of it were never written. A
// shell, a log, `cat` on an indented file print spaces there. A row whose
// indent was printed is a line of its own, whatever the fit says — so a shell's
// output copies exactly as it did before this existed.
//
// DOM-free, like lib/link-target.ts, and tested the same way
// (test/selection-text.mjs). Keep it erasable TypeScript.

import type { IBuffer, IBufferCell, IBufferLine, Terminal } from "@xterm/xterm";
import { textSpan, wrapAfter } from "./link-target";

/** The part of a terminal this needs. */
type SelectionView = Pick<Terminal, "buffer" | "cols">;

/** A selection, as xterm reports it: end.x is exclusive. */
export interface SelectionRange {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

/** How row `y` hands over to row `y + 1`. Null: they're separate lines. */
export type RowBreak = "soft" | "hard" | "word" | null;

// A cell nothing was written to — skipped by a cursor move, or erased. Unlike
// link-target's isBlank, a printed space doesn't count: that difference is the
// whole signal (see the top of the file).
function unwritten(line: IBufferLine, x: number, cell: IBufferCell): boolean {
  if (!line.getCell(x, cell)) return true;
  return cell.getWidth() !== 0 && cell.getChars() === "";
}

/** How row `y` carries on in row `y + 1`, if it does. */
export function rowBreak(
  buf: IBuffer,
  cols: number,
  y: number,
  cell: IBufferCell
): RowBreak {
  const line = buf.getLine(y);
  const next = buf.getLine(y + 1);
  if (!line || !next) return null;
  if (next.isWrapped) return "soft";

  // Carries on indented, and the indent was skipped rather than printed.
  const below = textSpan(next, cell);
  if (!below || below.first === 0) return null;
  for (let x = 0; x < below.first; x++) {
    if (!unwritten(next, x, cell)) return null;
  }

  // Never further out than this row starts: a row that steps back out is the
  // next item of a list, not the rest of this one.
  const here = textSpan(line, cell);
  if (!here || below.first < here.first) return null;

  // A word broken at the edge (link-target's rule, which knows when a row only
  // looks like that).
  if (wrapAfter(buf, cols, y, cell) === "hard") return "hard";

  // A word that would have fitted after this row's last character (one cell of
  // space, then the word) would have been put there.
  const word = below.headEnd - below.first + 1;
  if (here.last + 1 + word <= cols - 1) return null;
  return "word";
}

// Where each break leaves the next row's text: the indent a program-drawn
// continuation starts with is layout, not text.
function indentAfter(buf: IBuffer, y: number, brk: RowBreak, cell: IBufferCell): number {
  if (brk !== "hard" && brk !== "word") return 0;
  const next = buf.getLine(y + 1);
  return (next && textSpan(next, cell)?.first) || 0;
}

/**
 * The text `range` copies as: xterm's own rows, with the rows a program wrapped
 * joined back into the lines they were. `newline` is what separates lines that
 * stay separate — "\r\n" on Windows, as xterm does.
 */
export function selectionText(
  term: SelectionView,
  range: SelectionRange,
  newline = "\n"
): string {
  const buf = term.buffer.active;
  const cell = buf.getNullCell();
  const { start, end } = range;

  // A selection that starts partway into a continuation row still leaves its
  // indent out.
  let indent = indentAfter(buf, start.y - 1, rowBreak(buf, term.cols, start.y - 1, cell), cell);
  let text = "";
  for (let y = start.y; y <= end.y; y++) {
    const line = buf.getLine(y);
    if (!line) break;
    const x0 = Math.max(y === start.y ? start.x : 0, indent);
    const x1 = y === end.y ? end.x : line.length;
    const brk = y < end.y ? rowBreak(buf, term.cols, y, cell) : null;
    // A row the terminal wrapped is full, so whatever ends it — spaces
    // included — is part of the line.
    text += x0 < x1 ? line.translateToString(brk !== "soft", x0, x1) : "";
    if (y < end.y) text += brk === "word" ? " " : brk === null ? newline : "";
    indent = indentAfter(buf, y, brk, cell);
  }
  // As xterm does: a non-breaking space copies as a space.
  return text.replace(/ /g, " ");
}
