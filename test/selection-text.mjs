// What a selection copies as (src/lib/selection-text.ts).
//
// Rows Claude Code laid out itself have to come back as the lines they were;
// rows anything else printed have to copy exactly as xterm copies them. The
// cases come in pairs: the wraps that must be joined, and the rows that only
// look like one.
//
// No Electron and no DOM: the buffer is a stand-in with the handful of members
// the code reads. In a row, a space stands for a cell nothing was written to —
// how Claude Code leaves its indent and the gaps between words — and `~` for a
// space that was printed, the way a shell indents.
//
// Run: node --experimental-strip-types test/selection-text.mjs
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// src/lib imports its siblings without an extension, the way Vite resolves them.
register(
  "data:text/javascript," +
    encodeURIComponent(`
      export async function resolve(specifier, context, next) {
        if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]s$/.test(specifier)) {
          try { return await next(specifier + ".ts", context); } catch {}
        }
        return next(specifier, context);
      }
    `)
);

const { selectionText } = await import(
  pathToFileURL(path.join(root, "src", "lib", "selection-text.ts")).href
);

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
};

/** A terminal `cols` wide holding `rows`, each a string or `{ text, wrapped }`. */
function terminal(cols, rows) {
  const lines = rows.map((row) => {
    const { text, wrapped = false } = typeof row === "string" ? { text: row } : row;
    const chars = [...text].map((c) => (c === " " ? "" : c === "~" ? " " : c));
    if (chars.length > cols) throw new Error(`row wider than ${cols}: ${text}`);
    const at = (x) => chars[x] ?? "";
    return {
      isWrapped: wrapped,
      length: cols,
      getCell(x, cell) {
        if (x < 0 || x >= cols) return undefined;
        cell.chars = at(x);
        return cell;
      },
      // xterm's: an unwritten cell reads as a space, and trimming drops only
      // unwritten cells — a printed space at the end of a row stays.
      translateToString(trimRight, start = 0, end = cols) {
        let s = "";
        let kept = 0;
        for (let x = start; x < end; x++) {
          s += at(x) || " ";
          if (at(x)) kept = s.length;
        }
        return trimRight ? s.slice(0, kept) : s;
      },
    };
  });
  return {
    cols,
    buffer: {
      active: {
        length: lines.length,
        getLine: (y) => lines[y],
        getNullCell: () => ({
          chars: "",
          getChars() {
            return this.chars;
          },
          getWidth() {
            return 1;
          },
        }),
      },
    },
  };
}

// Everything from (x0, y0) to the end of the last row.
const all = (term, x0 = 0, y0 = 0) => ({
  start: { x: x0, y: y0 },
  end: { x: term.cols, y: term.buffer.active.length - 1 },
});
const expect = (name, term, range, want) => {
  const got = selectionText(term, range);
  check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
};

// --- what Claude Code draws ----------------------------------------------

const command =
  "gh pr view 95 --json body,files,commits,statusCheckRollup | head -80; gh pr diff 95 --color never";
// A long command in a tool call, wrapped between words.
const bash = terminal(64, [
  "⏺ Bash(gh pr view 95 --json body,files,commits,statusCheckRollup",
  "       | head -80; gh pr diff 95 --color never)",
]);
expect("word wrap joins with one space", bash, all(bash), "⏺ Bash(" + command + ")");
expect(
  "starting inside the command",
  bash,
  all(bash, 7),
  command + ")"
);
expect(
  "starting on the continuation row, in its indent",
  bash,
  all(bash, 0, 1),
  "| head -80; gh pr diff 95 --color never)"
);

// A path too long for a row, broken at the last column (link-target's rule).
const file = "/home/me/projects/specterm/src/components/a_component_with_a_long_name.tsx";
const broken = terminal(40, [
  "⏺ Read " + file.slice(0, 33),
  "  " + file.slice(33, 71),
  "  " + file.slice(71),
]);
expect("broken word joins with nothing", broken, all(broken), "⏺ Read " + file);

// A paragraph of reply, three rows.
const reply = terminal(40, [
  "⏺ The header button acts on a hand-kept",
  "  list of category ids, and Plugins was",
  "  never added to it.",
]);
expect(
  "a paragraph comes back as one line",
  reply,
  all(reply),
  "⏺ The header button acts on a hand-kept list of category ids, and Plugins was never added to it."
);

// A list: each item is a line of its own even when the one above is long.
const list = terminal(40, [
  "  - adds plugins to the list of category",
  "    ids, in render order",
  "  - nothing else",
]);
expect(
  "list items stay apart, wraps inside one join",
  list,
  all(list),
  "  - adds plugins to the list of category ids, in render order\n  - nothing else"
);

// A short line followed by one whose first word would have fitted after it.
const fits = terminal(40, ["⏺ First line.", "  second line of the same reply"]);
expect("a word that would have fitted means a real break", fits, all(fits), "⏺ First line.\n  second line of the same reply");

// A row that steps back out is the next item, not the rest of this one.
const outdent = terminal(30, ["    nested item that runs long", "  outer_item_with_long_name"]);
expect("outdented row stays apart", outdent, all(outdent), "    nested item that runs long\n  outer_item_with_long_name");

// A fenced code block in a Claude Code reply, 72 columns: wrap-ansi lays it
// out 70 wide two cells in (hard: true, trim: false). A word longer than the
// row is broken at the edge — once right before a `-`, once inside a URL's
// scheme — and a word that doesn't fit moves down whole, leaving the space
// before it printed at the end of the row. Whether a row's indent is skipped
// or printed (`~~`) depends on what the previous frame had there, so one
// command gets both.
const fenced =
  "! cd /tmp/claude-1000/-home-nexfar-Development/becc92ef-dbcc-42be-b1db-e712a8cd70ab/scratchpad/wt-ic-backfill" +
  " && NEXT_PUBLIC_GRAPHQL_URL=https://arriving-lemur-1090.ddn.hasura.app/graphql" +
  " npx tsx scripts/backfill-quotation-order-link.ts --pairs ../pares-tech-4326.csv --execute";
const block = (indents) => [
  "  !~cd~/tmp/claude-1000/-home-nexfar-Development/becc92ef-dbcc-42be-b1db",
  indents[0] + "-e712a8cd70ab/scratchpad/wt-ic-backfill~&&~NEXT_PUBLIC_GRAPHQL_URL=htt",
  indents[1] + "ps://arriving-lemur-1090.ddn.hasura.app/graphql~npx~tsx~",
  indents[2] + "scripts/backfill-quotation-order-link.ts~--pairs~",
  indents[3] + "../pares-tech-4326.csv~--execute",
];
// Rows as Claude Code 2.1.306 drew them (a real capture, replayed into xterm).
const tail = [
  "",
  "~~line 1 of the tail",
  "~~line~2~of~the~tail",
  "  line~3~of~the~tail",
  "  line~4~of~the~tail",
];
const captured = terminal(72, ["  Para gravar, rode:", "", ...block(["  ", "  ", "~~", "  "]), ...tail]);
const blockRange = (x0) => ({ start: { x: x0, y: 2 }, end: { x: 72, y: 6 } });
expect("a code block's long command copies as one line", captured, blockRange(2), fenced);
expect("the same, from inside it", captured, blockRange(4), fenced.slice(2));

// The rows of the paste on 20/10/2026: two of the four indents printed.
const pasted = terminal(72, block(["~~", "  ", "~~", "  "]));
expect("a code block with indents printed on some rows", pasted, all(pasted, 4), fenced.slice(2));

// Every indent of the command printed, as happens to a run of rows; the rows
// around it had theirs skipped.
const allPrinted = terminal(72, ["  Para gravar, rode:", "", ...block(["~~", "~~", "~~", "~~"]), ...tail]);
expect("a code block with every indent printed, among drawn rows", allPrinted, blockRange(2), fenced);

// Every indent skipped: the scheme broken as `htt|ps://` is not a URL starting
// the next row, and the printed space before a word that moved down is not
// doubled.
const skippedAll = terminal(72, block(["  ", "  ", "  ", "  "]));
expect("a code block with skipped indents copies as one line", skippedAll, all(skippedAll, 2), fenced);

// --- what a shell prints --------------------------------------------------

// Same shape, but the indent was printed: a shell's output, kept as it is.
const shell = terminal(60, [
  "src/components/SettingsPanel.tsx:153 warning: hand-kept list",
  "~~~~~~~consider_deriving_it_from_the_rendered_categories",
]);
expect(
  "printed indent is a line of its own",
  shell,
  all(shell),
  "src/components/SettingsPanel.tsx:153 warning: hand-kept list\n       consider_deriving_it_from_the_rendered_categories"
);

// An indented block a shell printed, rows reaching the edge: every indent is
// printed, so nothing vouches for any of them.
const printedBlock = terminal(30, [
  "~~first_line_of_an_indented_fi",
  "~~second_line_that_is_as_long_",
  "~~third",
]);
expect(
  "a printed indented block stays apart",
  printedBlock,
  all(printedBlock),
  "  first_line_of_an_indented_fi\n  second_line_that_is_as_long_\n  third"
);

// A line the terminal wrapped is joined, as xterm does — spaces at the edge kept.
const soft = terminal(10, ["echo one~~", { text: "two", wrapped: true }]);
expect("terminal wrap joins, edge spaces kept", soft, all(soft), "echo one  two");

// Plain output starting at column zero is never joined.
const plain = terminal(10, ["0123456789", "abcdefghij"]);
expect("full rows at column zero stay apart", plain, all(plain), "0123456789\nabcdefghij");

// A selection that ends partway into a row.
expect(
  "partial last row",
  reply,
  { start: { x: 2, y: 0 }, end: { x: 6, y: 1 } },
  "The header button acts on a hand-kept list"
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
