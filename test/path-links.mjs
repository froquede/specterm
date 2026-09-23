// The path matcher (src/lib/path-links.ts).
//
// This is the guess that decides what gets underlined in terminal output, so
// the cases worth pinning down come in pairs: the paths it must find, and the
// slash-carrying words it must leave alone. A miss costs a drag with the mouse;
// a false positive underlines prose on every screen of output.
//
// Pure functions, no Electron and no DOM. Type annotations are stripped by
// node, so path-links.ts must stay erasable TypeScript.
//
// Run: node --experimental-strip-types test/path-links.mjs
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
// A URL, not a bare path: on Windows the ESM loader reads "C:" as a scheme.
const { findPathLinks, resolveMatchedPath, opensInSpecterm } = await import(
  pathToFileURL(path.join(root, "src", "lib", "path-links.ts")).href
);

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const texts = (line) => findPathLinks(line).map((m) => m.text);
const eqList = (name, line, want) => {
  const got = texts(line);
  const ok = got.length === want.length && got.every((t, i) => t === want[i]);
  check(name, ok, ok ? "" : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
};

// --- the shapes it must find ---------------------------------------------
eqList("absolute posix", "wrote /home/lucas/notes/todo.md ok", ["/home/lucas/notes/todo.md"]);
eqList("home-relative", "cd ~/projects/specterm", ["~/projects/specterm"]);
eqList("dot-relative", "run ./scripts/build.sh now", ["./scripts/build.sh"]);
eqList("dot-dot-relative", "see ../pkg/index.ts", ["../pkg/index.ts"]);
eqList("bare relative with extension", "edit src/lib/foo.ts", ["src/lib/foo.ts"]);
eqList("directory chain without extension", "in node_modules/@xterm/xterm", ["node_modules/@xterm/xterm"]);
eqList("trailing separator is a directory", "cleared build/output/", ["build/output/"]);
eqList("line and column suffix", "at src/lib/foo.ts:12:3", ["src/lib/foo.ts:12:3"]);
eqList("bare filename pinned to a line", "App.tsx:12:5 unused var", ["App.tsx:12:5"]);
eqList("windows drive", "open C:\\Users\\lucas\\a.txt", ["C:\\Users\\lucas\\a.txt"]);
eqList("windows relative", "open src\\lib\\foo.ts", ["src\\lib\\foo.ts"]);
eqList("unc share", "mounted \\\\server\\share\\logs", ["\\\\server\\share\\logs"]);
eqList("glob survives", "matched src/**/*.ts today", ["src/**/*.ts"]);
eqList("two on one line", "ls -l /tmp/a.log /tmp/b.log", ["/tmp/a.log", "/tmp/b.log"]);

// --- what it must not swallow --------------------------------------------
eqList("sentence period", "wrote /etc/hosts.", ["/etc/hosts"]);
eqList("parenthesised", "look (src/main.rs) here", ["src/main.rs"]);
eqList("comma-separated list", "src/a.ts, src/b.ts", ["src/a.ts", "src/b.ts"]);
eqList("closing quote", "path is 'src/a.ts'", ["src/a.ts"]);

// A path with a space only survives because it was quoted; the quotes are not
// part of what lands on the clipboard.
eqList("quoted path with a space", 'open "~/My Documents/notes.md" now', ["~/My Documents/notes.md"]);

// An apostrophe pairs with the next quote on the line; the path between them
// has to survive that accident.
eqList("apostrophe before a quoted path", "don't open '/etc/hosts' yet", ["/etc/hosts"]);
eqList("prose inside quotes", 'it said "see /etc/hosts now"', ["/etc/hosts"]);

// --- how a TUI draws it --------------------------------------------------
// A frame rule, a bullet or a non-breaking space sits hard against the path in
// programs like Claude Code; none of them belongs on the clipboard.
eqList("box rule after a path", "\u2502 src/lib/foo.ts \u2502", ["src/lib/foo.ts"]);
eqList("box rule with no gap", "\u2502src/lib/foo.ts\u2502", ["src/lib/foo.ts"]);
eqList("bullet before a path", "\u2022 src/lib/foo.ts", ["src/lib/foo.ts"]);
eqList("non-breaking space", "Read\u00a0src/lib/foo.ts\u00a0(42 lines)", ["src/lib/foo.ts"]);
eqList("agent file mention drops the @", "see @src/lib/foo.ts", ["src/lib/foo.ts"]);
eqList("curly quotes", "\u201csrc/lib/foo.ts\u201d", ["src/lib/foo.ts"]);
eqList("ellipsis after a path", "wrote src/lib/foo.ts\u2026", ["src/lib/foo.ts"]);

// --- the refusals ---------------------------------------------------------
eqList("ratio", "available 24/7 for you", []);
eqList("conjunction", "pass a flag and/or a file", []);
eqList("date", "due 08/09/2026 sharp", []);
eqList("unit", "at 80 km/h", []);
eqList("clock", "started 12:30 today", []);
eqList("initialism", "heavy I/O load", []);
eqList("bare filename without a line", "check package.json", []);
// URLs come out of the same pass, tagged as URLs — one scan decides where
// every clickable span on the line starts and ends.
eqList("url matched whole", "see https://example.com/a/b now", ["https://example.com/a/b"]);
eqList("www url", "see www.example.com/a/b now", ["www.example.com/a/b"]);
eqList("url trailing period", "see https://example.com/a.", ["https://example.com/a"]);
check(
  "url is tagged as a url",
  findPathLinks("see https://example.com/a/b")[0]?.kind === "url"
);
check("path is tagged as a path", findPathLinks("see /etc/hosts")[0]?.kind === "path");
// A URL is claimed whole, so its tail never comes back as a relative path.
eqList("no path inside a url", "https://example.com/src/lib/foo.ts", ["https://example.com/src/lib/foo.ts"]);
eqList("fraction", "3/4 done", []);

// --- ranges point at the right characters --------------------------------
{
  const line = "wrote /etc/hosts. ok";
  const [m] = findPathLinks(line);
  check(
    "range covers exactly the path",
    m && line.slice(m.start, m.end) === "/etc/hosts",
    m ? `got ${JSON.stringify(line.slice(m.start, m.end))}` : "no match"
  );
}
{
  const line = 'open "~/My Documents/a.md"';
  const [m] = findPathLinks(line);
  check(
    "quoted range excludes the quotes",
    m && line.slice(m.start, m.end) === "~/My Documents/a.md",
    m ? `got ${JSON.stringify(line.slice(m.start, m.end))}` : "no match"
  );
}

// A line of nothing but punctuation used to be able to stall the scanner: the
// trim ate the whole match and the loop restarted in the same place.
{
  const started = Date.now();
  findPathLinks("... ,,, ;;; ))) ".repeat(40));
  check("punctuation soup terminates", Date.now() - started < 1000);
}

// --- turning a match into a path the OS can open -------------------------
// What Ctrl/⌘+click needs: the compiler's line number off, `~` expanded, and a
// relative path resolved against the pane's own directory.
{
  const posix = { cwd: "/home/u/proj", home: "/home/u", windows: false };
  const eqPath = (name, got, want) =>
    check(name, got === want, got === want ? "" : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

  eqPath("line suffix comes off", resolveMatchedPath("src/a.ts:12:5", posix), "/home/u/proj/src/a.ts");
  eqPath("relative resolves against the pane", resolveMatchedPath("src/a.ts", posix), "/home/u/proj/src/a.ts");
  eqPath("absolute is left alone", resolveMatchedPath("/etc/hosts", posix), "/etc/hosts");
  eqPath("tilde expands", resolveMatchedPath("~/notes/a.md", posix), "/home/u/notes/a.md");
  eqPath("bare tilde is home", resolveMatchedPath("~", posix), "/home/u");
  eqPath("dot-relative loses its ./", resolveMatchedPath("./run.sh", posix), "/home/u/proj/run.sh");
  eqPath("dot-dot-relative is left for the OS", resolveMatchedPath("../pkg/a.ts", posix), "/home/u/proj/../pkg/a.ts");
  eqPath(
    "no cwd, no relative path",
    resolveMatchedPath("src/a.ts", { cwd: "", home: "/home/u", windows: false }),
    null
  );

  const win = { cwd: "C:\\work", home: "C:\\Users\\u", windows: true };
  eqPath("windows drive is absolute", resolveMatchedPath("C:\\Users\\u\\a.txt", win), "C:\\Users\\u\\a.txt");
  eqPath("windows relative joins with a backslash", resolveMatchedPath("src\\a.ts", win), "C:\\work\\src\\a.ts");
  eqPath("unc is absolute", resolveMatchedPath("\\\\server\\share\\a.txt", win), "\\\\server\\share\\a.txt");
}

// --- what opens in a pane, and what the OS gets --------------------------
// The line between "Specterm shows this itself" and "hand it to the OS". Being
// wrong in the first direction means a PDF rendered as mojibake; in the second,
// a README leaving the app to open somewhere else.
{
  const inApp = (p) => check(`in a pane: ${p}`, opensInSpecterm(p) === true);
  const toOs = (p) => check(`to the OS: ${p}`, opensInSpecterm(p) === false);

  inApp("/home/u/notes.md");
  inApp("docs/README.md");
  inApp("src/lib/foo.ts");
  inApp("/etc/hosts.conf");
  inApp("assets/logo.png");
  inApp("Makefile");
  inApp("/home/u/proj/.gitignore");
  inApp("C:\\work\\notes.MD");

  toOs("/home/u/report.pdf");
  toOs("/home/u/sheet.xlsx");
  toOs("/usr/bin/node");
  toOs("/home/u/archive.tar.gz");
  toOs("/home/u/.ssh/known_hosts");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
