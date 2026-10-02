// The vault index (plugins/vault/src/vault-index.ts) and the note parser it
// shares with the preview (noteStructure in src/lib/markdown.ts, which the
// plugin gets as api.noteStructure).
//
// What these pin is the contract the vault panel and quick open rely on: a link
// counts as a backlink exactly when MarkdownPane would follow it, the outline
// lists the headings the preview renders and in the same order, and search and
// open-by-name find what a reader means. No Electron, no DOM.
//
// POSIX paths throughout: the path rules are selected from the host OS, and the
// Windows variants of the same helpers are covered by the e2e suite on Windows.
//
// Run: node --experimental-strip-types test/vault-index.mjs
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

if (process.platform === "win32") {
  console.log("SKIP  vault-index unit checks are POSIX-path only");
  process.exit(0);
}

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

const lib = (name) =>
  import(pathToFileURL(path.join(root, "src", "lib", name)).href);
const vault = await import(
  pathToFileURL(path.join(root, "plugins", "vault", "src", "vault-index.ts")).href
);
const {
  setNoteStructure,
  buildNote,
  resolveNoteLink,
  findNotesByName,
  searchNotes,
  backlinksTo,
  isInside,
} = vault;
const { noteStructure } = await lib("markdown.ts");
setNoteStructure(noteStructure);

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- Link resolution ------------------------------------------------------

const from = "/vault/docs/guide.md";
const cases = [
  ["sibling", "intro.md", "/vault/docs/intro.md"],
  ["dot-relative", "./intro.md", "/vault/docs/intro.md"],
  ["parent", "../README.md", "/vault/README.md"],
  ["nested", "deep/x/y.md", "/vault/docs/deep/x/y.md"],
  ["fragment dropped", "intro.md#setup", "/vault/docs/intro.md"],
  ["query dropped", "intro.md?plain=1", "/vault/docs/intro.md"],
  ["percent-encoded space", "my%20note.md", "/vault/docs/my note.md"],
  ["absolute", "/other/x.md", "/other/x.md"],
  ["above root stays at root", "../../../x.md", "/x.md"],
  [".markdown extension", "a.markdown", "/vault/docs/a.markdown"],
  ["web link ignored", "https://example.com/a.md", null],
  ["mailto ignored", "mailto:a@b.c", null],
  ["same-note anchor ignored", "#section", null],
  ["image ignored", "img/shot.png", null],
  ["non-markdown file ignored", "script.sh", null],
];
for (const [name, href, want] of cases) {
  const got = resolveNoteLink(from, href);
  check(`link: ${name}`, got === want, `${href} -> ${got}, want ${want}`);
}

// --- Note structure -------------------------------------------------------

const source = [
  "# Title",
  "",
  "Intro with a [link](a.md) and [web](https://x.y).",
  "",
  "Setext heading",
  "--------------",
  "",
  "```md",
  "# not a heading",
  "[not a link](fake.md)",
  "```",
  "",
  "- item",
  "  ## Heading in a list",
  "",
  "### `code` and **bold**",
  "",
  "Two links on one line: [b](b.md) [c](sub/c.md#x).",
].join("\n");

const { headings, links } = noteStructure(source);
check(
  "outline: levels and order follow the renderer",
  eq(headings.map((h) => h.level), [1, 2, 2, 3]),
  JSON.stringify(headings)
);
check(
  "outline: text without markup",
  eq(headings.map((h) => h.text), ["Title", "Setext heading", "Heading in a list", "code and bold"]),
  JSON.stringify(headings.map((h) => h.text))
);
check("outline: fenced '#' is not a heading", !headings.some((h) => h.text.includes("not a heading")));
check(
  "links: fenced link not counted, web link kept raw",
  eq(links.map((l) => l.href), ["a.md", "https://x.y", "b.md", "sub/c.md#x"]),
  JSON.stringify(links)
);
check("links: line numbers", eq(links.map((l) => l.line), [2, 2, 17, 17]), JSON.stringify(links));

// --- Index ----------------------------------------------------------------

const V = "/vault";
const notes = [
  buildNote(V, "/vault/README.md", 1, "# Home\nSee [the guide](docs/guide.md).\n"),
  buildNote(V, "/vault/docs/guide.md", 1, "# Guide\nBack to [home](../README.md).\nDeploy steps: run the DEPLOY script.\n"),
  buildNote(V, "/vault/docs/deploy-process.md", 1, "# Deploy process\nSee [guide](guide.md#deploy) and [guide again](./guide.md).\n"),
  buildNote(V, "/vault/notes/big.md", 1, null),
];

check("note: rel path", notes[1].rel === "docs/guide.md", notes[1].rel);
check("note: name", notes[1].name === "guide.md");
check("note: unreadable note keeps its name", notes[3].name === "big.md" && notes[3].links.length === 0);

const back = backlinksTo(notes, "/vault/docs/guide.md");
check(
  "backlinks: every note linking in, not itself",
  eq(back.map((b) => b.note.rel), ["docs/deploy-process.md", "README.md"]),
  JSON.stringify(back.map((b) => b.note.rel))
);
check(
  "backlinks: two links on one line are one context",
  back[0]?.contexts.length === 1,
  JSON.stringify(back[0]?.contexts)
);
check(
  "backlinks: context is the linking line",
  back[1]?.contexts[0]?.text === "See [the guide](docs/guide.md).",
  JSON.stringify(back[1]?.contexts)
);
check("backlinks: none for an unlinked note", backlinksTo(notes, "/vault/notes/big.md").length === 0);

const byName = findNotesByName(notes, "dep");
check("open by name: matches the file name", byName[0]?.rel === "docs/deploy-process.md", JSON.stringify(byName.map((n) => n.rel)));
const fuzzy = findNotesByName(notes, "dprc");
check("open by name: subsequence match", fuzzy[0]?.rel === "docs/deploy-process.md", JSON.stringify(fuzzy.map((n) => n.rel)));
check("open by name: no match", findNotesByName(notes, "zzz").length === 0);
check("open by name: empty query lists everything", findNotesByName(notes, "").length === notes.length);

const found = searchNotes(notes, "deploy");
check(
  "search: case-insensitive, across notes",
  eq(found.map((r) => r.note.rel), ["docs/deploy-process.md", "docs/guide.md"]),
  JSON.stringify(found.map((r) => r.note.rel))
);
const guideHit = found.find((r) => r.note.rel === "docs/guide.md")?.hits[0];
check("search: one hit per line", found.find((r) => r.note.rel === "docs/guide.md")?.hits.length === 1);
check("search: line number", guideHit?.line === 2, JSON.stringify(guideHit));
check(
  "search: highlight range covers the match",
  guideHit && guideHit.snippet.slice(guideHit.start, guideHit.end).toLowerCase() === "deploy",
  JSON.stringify(guideHit)
);
check("search: regex characters are literal", searchNotes(notes, "](docs").length === 1);
check("search: '.' is not a wildcard", searchNotes(notes, "g.ide").length === 0);
check("search: by name for an unread note", searchNotes(notes, "big")[0]?.note.rel === "notes/big.md");
check("search: empty query", searchNotes(notes, "  ").length === 0);
const capped = searchNotes(notes, "e", { perNote: 1, total: 2 });
check("search: total cap", capped.reduce((n, r) => n + r.hits.length, 0) <= 2);

const longLine = "x".repeat(300) + " needle " + "y".repeat(300);
const long = searchNotes([buildNote(V, "/vault/l.md", 1, longLine)], "needle")[0].hits[0];
check("search: long line windowed around the match", long.snippet.length < 160 && long.snippet.startsWith("…") && long.snippet.endsWith("…"), long.snippet);
check("search: windowed highlight still on the match", long.snippet.slice(long.start, long.end) === "needle");

check("inside: child", isInside("/vault/docs/a.md", "/vault"));
check("inside: itself", isInside("/vault", "/vault/"));
check("inside: sibling prefix is not inside", !isInside("/vault2/a.md", "/vault"));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
