// Finding the line a hovered cell belongs to (src/lib/link-target.ts).
//
// What gets underlined is decided on the line as it was written, so a path
// broken onto two rows has to be stitched back together first. The terminal
// flags its own wraps; a program that lays out its own rows (Claude Code) flags
// nothing, and its wraps have to be inferred. The cases come in pairs again:
// the breaks that must be joined, and the rows that merely meet at the edge.
//
// No Electron and no DOM: the buffer is a stand-in with the handful of members
// the code reads. A space in a row stands for a cell nothing was written to,
// which is how Claude Code leaves the gap between words — the code treats the
// two the same.
//
// Run: node --experimental-strip-types test/link-target.mjs
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// src/lib imports its siblings without an extension (`./path-links`), the way
// Vite resolves them. Node's ESM loader does not, so point relative,
// extensionless specifiers at the `.ts` file.
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

// A URL, not a bare path: on Windows the ESM loader reads "C:" as a scheme.
const { targetAt } = await import(
  pathToFileURL(path.join(root, "src", "lib", "link-target.ts")).href
);

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
};

/**
 * A terminal `cols` wide holding `rows`, each a string or `{ text, wrapped }`
 * for a row the terminal itself wrapped onto.
 */
function terminal(cols, rows) {
  const lines = rows.map((row) => {
    const { text, wrapped = false } = typeof row === "string" ? { text: row } : row;
    const chars = [...text];
    if (chars.length > cols) throw new Error(`row wider than ${cols}: ${text}`);
    return {
      isWrapped: wrapped,
      length: cols,
      getCell(x, cell) {
        if (x < 0 || x >= cols) return undefined;
        cell.chars = chars[x] ?? "";
        return cell;
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

const textAt = (term, col, row) => targetAt(term, col, row)?.text ?? null;
const expect = (name, term, col, row, want) => {
  const got = textAt(term, col, row);
  check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
};

// --- what Claude Code draws ----------------------------------------------
// Rows as a real Claude Code session (2.1.296) drew a reply in an 80-column
// pty: a word too long for the row broken at the last column, the rest carried
// on two cells in. Nothing here is flagged as wrapped.
const url =
  "https://github.com/froquede/specterm/pull/89/files#diff-3f2a9c0b1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d";
const file = "/Users/me/projects/specterm-demo/src/components/a_component_with_a_long_name_v2.tsx";
const reply = terminal(80, [
  "⏺ Link: https://github.com/froquede/specterm/pull/89/files#diff-3f2a9c0b1d2e3f4a",
  "  5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d e o arquivo /Users/me/projects/specterm-demo/sr",
  "  c/components/a_component_with_a_long_name_v2.tsx fim",
]);
expect("broken url, first row", reply, 20, 0, url);
expect("broken url, second row", reply, 10, 1, url);
expect("broken path, first row", reply, 60, 1, file);
expect("broken path, second row", reply, 10, 2, file);
expect("the indent isn't part of it", reply, 1, 1, null);
{
  const segments = targetAt(reply, 10, 1)?.segments ?? [];
  const want = [
    { y: 0, x0: 8, x1: 79 },
    { y: 1, x0: 2, x1: 31 },
  ];
  check(
    "underline skips the indent",
    JSON.stringify(segments) === JSON.stringify(want),
    JSON.stringify(segments)
  );
}

// The same text echoed in the prompt box, whose padding stops the text one
// cell short of the edge.
const prompt = terminal(80, [
  "  Link: https://github.com/froquede/specterm/pull/89/files#diff-3f2a9c0b1d2e3f4 ",
  "  a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d e o arquivo /Users/me/projects/specterm-demo/ ",
  "  src/components/a_component_with_a_long_name_v2.tsx fim                        ",
]);
expect("padded box, url", prompt, 10, 1, url);
expect("padded box, path", prompt, 10, 2, file);

// A word broken twice: the middle row is all word, edge to edge.
{
  const long = "/tmp/" + "segment/".repeat(6) + "end.txt";
  const term = terminal(30, ["⏺ " + long.slice(0, 28), "  " + long.slice(28, 56), "  " + long.slice(56)]);
  expect("three rows, from the middle", term, 10, 1, long);
  expect("three rows, from the last", term, 3, 2, long);
}

// --- what the terminal wrapped -------------------------------------------
{
  const long = "/tmp/" + "dir/".repeat(10) + "end.txt";
  const term = terminal(20, [long.slice(0, 20), { text: long.slice(20, 40), wrapped: true }, { text: long.slice(40), wrapped: true }]);
  expect("soft wrap, first row", term, 5, 0, long);
  expect("soft wrap, last row", term, 2, 2, long);
}

// --- what must stay apart ------------------------------------------------
// Prose word-wrapped so that a path ends exactly on the last column. The next
// row's first word is a new word, and gluing it on copies a path that doesn't
// exist.
{
  const row = "⏺ restart after editing /etc/hosts";
  const term = terminal(row.length, [row, "  and flush the cache"]);
  expect("word that fits exactly isn't glued", term, row.length - 3, 0, "/etc/hosts");
}
// The same with a longer path and a longer word after it: together still short
// enough to have fitted on a row, so the wrapper would never have broken them.
{
  const row = "⏺ the rules are all in /Users/me/projects/demo/src/lib/link-target.ts";
  const term = terminal(row.length, [row, "  because that is where the guessing lives"]);
  expect("longer path that fits exactly isn't glued", term, 30, 0, "/Users/me/projects/demo/src/lib/link-target.ts");
}
// Two paths listed one per row, the first reaching the edge: together long
// enough to have needed a break, but the second starts a path of its own.
{
  const a = "/Users/me/projects/demo/src/lib/link-target.ts";
  const b = "/Users/me/projects/demo/src/lib/terminal-links.ts";
  const row = "⏺ Changed " + a;
  const term = terminal(row.length, [row, "  " + b + " too"]);
  expect("a path listed under one at the edge stays apart", term, 20, 0, a);
  expect("a path listed under one at the edge stays apart, below", term, 10, 1, b);
}
// Indented URLs cut at the edge (less -S, vim nowrap): each row is its own.
{
  const a = "https://cdn.example.com/assets/" + "a".repeat(40);
  const b = "https://cdn.example.com/other/" + "b".repeat(40);
  const cols = 60;
  const term = terminal(cols, ["  " + a.slice(0, cols - 2), "  " + b.slice(0, cols - 2)]);
  expect("indented URLs cut at the edge stay apart", term, 10, 0, a.slice(0, cols - 2));
  expect("indented URLs cut at the edge stay apart, below", term, 10, 1, b.slice(0, cols - 2));
}
// A row that stops short of the edge ended where its line did.
{
  const term = terminal(40, ["⏺ wrote /tmp/out/a", "  b.txt and stopped"]);
  expect("row short of the edge isn't joined", term, 10, 0, "/tmp/out/a");
}
// Plain output whose lines fill the width exactly, one after another, without
// an indent: separate lines that only look like a break.
{
  const a = "https://example.com/aaaaaaaaaa";
  const b = "https://example.com/bbbbbbbbbb";
  const term = terminal(a.length, [a, b]);
  expect("unindented full rows stay apart", term, 5, 0, a);
  expect("unindented full rows stay apart, below", term, 5, 1, b);
}
// A blank row between them ends the line, whatever comes after.
{
  const term = terminal(20, ["⏺ /tmp/aaaaaaaaaaaaa", "", "  bbbbbbbbbbbbbbbbbb"]);
  expect("a blank row ends the line", term, 5, 0, "/tmp/aaaaaaaaaaaaa");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
