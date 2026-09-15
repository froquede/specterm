// Turning clipboard text into terminal input.
//
// A terminal has no notion of "a paste": bytes arrive and a newline among them
// means the same thing a newline from the Enter key means — submit the line.
// So a command that some other program wrapped across two rows arrives as two
// commands, and the first half runs on its own. That is the whole bug this
// module exists for. The usual example is a `sudo …` line suggested inside a
// chat pane: the program that printed it hard-wrapped it at its own width, the
// selection copies those breaks verbatim, and pasting runs half a command.
//
// Two things are done about it, in this order:
//
//   1. **Unwrap** breaks that are wrapping rather than authorship
//      (`joinWrappedLines`). Only the shape of the text can tell those apart,
//      so this is a heuristic and it refuses far more often than it fires.
//   2. **Bracket** whatever survives (`preparePaste`), so a program that asked
//      for bracketed paste is told these bytes came from a clipboard and not
//      from fingers. Shells then hold the text in the edit buffer instead of
//      running it, which is the safety net for every break rule 1 kept.
//
// Deliberately free of xterm and DOM imports: the rules below are the part
// worth testing, and this keeps them testable in plain node (see test/paste.mjs).

// How far short of the wrap column a wrapped row may fall and still read as a
// wrap. Wrapping breaks at spaces, so the word that didn't fit moves down
// whole and leaves a ragged right edge — one long word is the widest gap a
// single break can open.
const WRAP_SLACK = 12;

// Below this, a row's length says nothing. `cd /srv` and `npm test` are two
// deliberate commands whose rows are both short and both "uniform"; only once
// rows are long does uniformity stop being a coincidence and start being
// evidence that something wrapped them at a fixed column.
const MIN_WRAP_WIDTH = 40;

// How far below the pane's own width the wrap column may sit and still be
// this pane's. Two rows are "uniform" by definition, so on the commonest paste
// of all — exactly one wrapped command — the right edge alone proves nothing,
// and two long unrelated commands would join. The pane width is the missing
// half of the test: text wrapped by a program running *here* broke at this
// pane's column, minus whatever chrome that program draws around it (a chat
// pane's box borders and padding cost about four columns) and minus the word
// that didn't fit.
const COLS_SLACK = WRAP_SLACK + 4;

// Ceilings on what is even worth examining. One command wrapped at a terminal
// width is a handful of rows and a few hundred bytes; a paste far past either
// figure is a file, a log or a key, and the rules below can only ever decline
// it. Bailing early keeps a huge paste from paying for a linear sweep whose
// answer is already known — and pasting a large file into a shell is ordinary.
const MAX_JOINABLE_ROWS = 64;
const MAX_JOINABLE_BYTES = 64 * 1024;

// The deepest left margin a program wrapping its own output plausibly draws
// (a chat pane's bullet and padding). Past this, indentation is structure.
const MAX_MARGIN = 8;

// A row ending in one of these broke because the author wanted it to: an
// explicit continuation, an operator waiting for its right-hand side, an open
// group. Shells already join these correctly, so joining them here would at
// best duplicate the shell and at worst change what runs.
const DELIBERATE_TAIL = /(?:\\|&&|\|\||[|;,&({[])$/;

// The same signal in word form — a row that ends where a shell block continues.
const DELIBERATE_TAIL_WORD = /(?:^|\s)(?:then|do|else|in)$/;

// A row that *starts* like the middle of something the author laid out: a
// block's closing or continuing keyword, a comment, a closing bracket.
const CONTINUES_BLOCK = /^(?:fi|done|esac|else|elif|then|do)\b|^[)\]}#]/;

// Anything a command line can't contain and still be one line of text. An
// escape sequence or a NUL in the clipboard means this isn't prose or a
// command — pass it through untouched rather than reasoning about its shape.
const CONTROL_CHAR = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

/**
 * Join rows that are one command wrapped, and leave every other multi-row
 * paste exactly as it came.
 *
 * The test is the right edge. A hard wrap emits rows that all end at very
 * nearly the same column — the column the wrapping program was working to —
 * followed by one shorter remainder. Text a person laid out across rows has no
 * reason to be that regular, and the rules above catch the shapes that could
 * be regular by accident.
 *
 * `cols` is the pasting pane's width, and passing it is what makes the
 * two-row case safe (see COLS_SLACK). Omitting it falls back to the width
 * floor alone, which is looser.
 *
 * Two breaks it cannot see. A wrap that landed mid-word (a URL or a path
 * longer than the remaining width) rejoins with a space where the wrap put
 * nothing. Text wrapped somewhere narrower than this pane — another pane,
 * another window — fails the `cols` test and pastes as it came. Both come out
 * visible, in the edit buffer, rather than half-executed.
 */
export function joinWrappedLines(text: string, cols?: number): string {
  // Nothing past this length can be one wrapped command, and pasting a whole
  // file into a shell is a real thing people do. Bail before the copy, the
  // split and the sweep below, all of which are linear in the clipboard and
  // all of which would be spent to reach the same answer.
  if (text.length > MAX_JOINABLE_BYTES) return text;

  const body = text.replace(/\r\n?/g, "\n");
  if (CONTROL_CHAR.test(body)) return text;

  // A trailing newline is the Enter the user copied along with the command, not
  // a break between two of them. Hold it aside so it doesn't count as a row,
  // and put it back at the end so a paste that used to run still runs.
  const trailing = /\n+$/.exec(body)?.[0] ?? "";
  const lines = (trailing ? body.slice(0, -trailing.length) : body).split("\n");
  if (lines.length < 2 || lines.length > MAX_JOINABLE_ROWS) return text;

  // A blank row is a paragraph break — nothing wraps into one.
  if (lines.some((line) => line.trim() === "")) return text;

  const rest = lines.slice(1);
  // Indentation is a shape someone chose — with one exception: a margin. A chat
  // pane lays its whole reply out a couple of columns in, so every row of a
  // wrapped command it printed starts with the same run of spaces, and a
  // selection dragged from the command's first character copies the first row
  // without it. So: every row after the first indented by exactly the same few
  // spaces, the first row either at that margin or with none at all. Anything
  // else — a deeper row, a tab, a ragged indent — is still a chosen shape.
  const margin = /^ */.exec(rest[0])?.[0].length ?? 0;
  if (margin > 0) {
    // A margin is only believable against the pane's width; without it, an
    // indented block that happens to be long would qualify.
    if (cols === undefined || margin > MAX_MARGIN) return text;
    const pad = " ".repeat(margin);
    if (rest.some((line) => !line.startsWith(pad) || /^\s/.test(line.slice(margin)))) {
      return text;
    }
    const firstIndent = /^\s*/.exec(lines[0])?.[0] ?? "";
    if (firstIndent !== "" && firstIndent !== pad) return text;
  } else if (rest.some((line) => /^\s/.test(line))) {
    return text;
  }
  if (rest.some((line) => CONTINUES_BLOCK.test(line.trim()))) return text;

  // Row widths as the pane drew them: the margin counts toward the column a
  // row reached, whether or not the selection copied it.
  const rows = lines.map((line) =>
    margin > 0 ? margin + line.trim().length : line.length
  );
  const heads = lines.slice(0, -1);
  if (
    heads.some((line) => {
      const end = line.trimEnd();
      return DELIBERATE_TAIL.test(end) || DELIBERATE_TAIL_WORD.test(end);
    })
  ) {
    return text;
  }

  // Every row but the last must sit at the wrap column, and the last must be
  // the remainder — shorter than the column it was wrapped to.
  //
  // Counted in a loop rather than `Math.max(...heads.map(…))`: spreading an
  // array into a call passes one argument per element, and a paste of a few
  // hundred thousand rows overflows the stack — a RangeError thrown out of the
  // paste handler, which is the one place that must never fail loudly.
  const headRows = rows.slice(0, -1);
  let width = 0;
  for (const row of headRows) if (row > width) width = row;
  if (width < MIN_WRAP_WIDTH) return text;
  if (headRows.some((row) => row < width - WRAP_SLACK)) return text;
  if (rows[rows.length - 1] > width) return text;
  if (cols !== undefined && (width > cols || width < cols - COLS_SLACK)) {
    return text;
  }

  return lines.map((line) => line.trim()).join(" ") + trailing;
}

// DEC 2004 — the markers a program that set bracketed-paste mode reads to tell
// pasted bytes from typed ones.
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * The bytes to write to the pty for a paste of `text`.
 *
 * `bracketed` is the foreground program's DEC 2004 mode (`term.modes
 * .bracketedPasteMode`), not a preference: a program that never asked for the
 * markers would read them as keystrokes.
 */
export function preparePaste(
  text: string,
  bracketed: boolean,
  cols?: number
): string {
  // Enter sends CR. A pasted LF has to look identical or a shell reading raw —
  // and every full-screen program — sees a stray linefeed where a submitted
  // line should be.
  const data = joinWrappedLines(text, cols).replace(/\r\n?|\n/g, "\r");
  if (!bracketed) return data;
  // Clipboard content that happens to contain the end marker would otherwise
  // close the bracket early and hand the remainder over as keystrokes.
  return PASTE_START + data.split(PASTE_END).join("") + PASTE_END;
}
