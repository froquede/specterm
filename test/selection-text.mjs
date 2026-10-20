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
      // xterm's: an unwritten cell reads as a space.
      translateToString(trimRight, start = 0, end = cols) {
        let s = "";
        for (let x = start; x < end; x++) s += at(x) || " ";
        return trimRight ? s.replace(/\s+$/, "") : s;
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
