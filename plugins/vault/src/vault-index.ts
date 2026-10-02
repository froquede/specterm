// What a vault knows about its notes, and the questions asked of it: open a
// note by name, search every note's text, and list who links to a note.
//
// Pure on purpose — no backend, no signals. The store (index-store.ts) feeds
// it what the host read off disk and owns the lifecycle; everything here is
// testable in node (test/vault-index.mjs). Moved from src/lib/vault-index.ts.
//
// Links count only in the form the repo already writes and every renderer
// understands: a standard markdown link to a .md file, relative to the note or
// absolute. That is the same rule MarkdownPane follows when a link is clicked,
// so a backlink listed here is one you could also have followed from its source.

import type { NoteHeading, NoteLink } from "../../../src/lib/markdown";
import { normalize, equalPath, basename, dirname, sep } from "../../../src/lib/fspath";
export { isInside } from "../../../src/lib/fspath";
import { isMarkdownPath } from "../../../src/lib/file-kind";
import { os } from "../../../src/lib/platform";

// The parser is Specterm's (api.noteStructure), so a note's outline here is
// numbered exactly as its preview renders it. Set by whoever loads the index;
// the tests hand in the same function directly.
type Structure = (source: string) => { headings: NoteHeading[]; links: NoteLink[] };
let noteStructure: Structure = () => ({ headings: [], links: [] });
export function setNoteStructure(fn: Structure) {
  noteStructure = fn;
}

const WIN = os === "windows";

export interface NoteLinkOut {
  // Absolute path of the note the link points at (normalized).
  target: string;
  // 0-based source line of the link, for showing its context.
  line: number;
}

export interface Note {
  path: string;
  // Path relative to the vault root, with the platform separator.
  rel: string;
  name: string;
  mtimeMs: number;
  // null when the file was too big to index or couldn't be read: the note is
  // still listed by name, it just has no contents to search or links to give.
  text: string | null;
  headings: NoteHeading[];
  links: NoteLinkOut[];
}

// Collapse "." and ".." segments. Never climbs above the root of the path —
// "/../x" stays "/x", the way the filesystem itself would resolve it. Inputs are
// always absolute, so the first segment is the root ("" or "C:") and stays.
function collapse(p: string): string {
  const s = normalize(p);
  const parts = s.split(/[\\/]+/);
  const out: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(part);
  }
  const joined = out.join(sep);
  return joined || sep;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const ABSOLUTE = WIN ? /^(?:[A-Za-z]:[\\/]|[\\/]{2})/ : /^\//;

/**
 * The note an href in `fromPath` points at, or null when it isn't a link to a
 * markdown file (a web link, an anchor in the same note, an image).
 */
export function resolveNoteLink(fromPath: string, href: string): string | null {
  // A drive letter is not a scheme: "C:/notes/x.md" is a path.
  if (SCHEME.test(href) && !(WIN && /^[A-Za-z]:[\\/]/.test(href))) return null;
  let target = href.split(/[?#]/)[0];
  if (!target) return null;
  try {
    target = decodeURI(target);
  } catch {
    // A stray "%" — keep the href as written.
  }
  if (!isMarkdownPath(target)) return null;
  if (ABSOLUTE.test(target)) return collapse(target);
  return collapse(dirname(fromPath) + sep + target);
}

/** Parse a note's contents into what the index keeps. */
export function buildNote(
  root: string,
  path: string,
  mtimeMs: number,
  text: string | null
): Note {
  const rootN = normalize(root).replace(/[\\/]+$/, "");
  const p = normalize(path);
  const rel = p.slice(rootN.length).replace(/^[\\/]+/, "");
  if (text === null) {
    return { path: p, rel, name: basename(p), mtimeMs, text, headings: [], links: [] };
  }
  const { headings, links } = noteStructure(text);
  const out: NoteLinkOut[] = [];
  for (const link of links) {
    const target = resolveNoteLink(p, link.href);
    if (target) out.push({ target, line: link.line });
  }
  return { path: p, rel, name: basename(p), mtimeMs, text, headings, links: out };
}

// --- Open by name --------------------------------------------------------

// Subsequence match of `query` against `candidate` (both lowercase), scored so
// the matches people mean come first: characters that land on a word start or
// right after the previous match, and matches inside the file name rather
// than its folders. -1 when the query isn't a subsequence at all.
function fuzzyScore(query: string, candidate: string, nameStart: number): number {
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of query) {
    if (ch === " ") continue;
    const at = candidate.indexOf(ch, from);
    if (at < 0) return -1;
    score += 1;
    if (at === prev + 1) score += 5;
    const before = at > 0 ? candidate[at - 1] : "/";
    if (/[\\/ _.-]/.test(before)) score += 4;
    if (at >= nameStart) score += 2;
    prev = at;
    from = at + 1;
  }
  // Shorter paths win ties: "readme.md" before "docs/old/readme-draft.md".
  return score - candidate.length * 0.01;
}

export function findNotesByName(notes: Note[], query: string, limit = 50): Note[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return [...notes].sort((a, b) => a.rel.localeCompare(b.rel)).slice(0, limit);
  }
  const scored: { note: Note; score: number }[] = [];
  for (const note of notes) {
    const rel = note.rel.toLowerCase();
    const score = fuzzyScore(q, rel, rel.length - note.name.length);
    if (score >= 0) scored.push({ note, score });
  }
  scored.sort((a, b) => b.score - a.score || a.note.rel.localeCompare(b.note.rel));
  return scored.slice(0, limit).map((s) => s.note);
}

// --- Search text ---------------------------------------------------------

export interface SearchHit {
  line: number;
  // The line, trimmed to a window around the match.
  snippet: string;
  // Where the match sits inside `snippet`, for highlighting.
  start: number;
  end: number;
}

export interface SearchResult {
  note: Note;
  hits: SearchHit[];
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A window of the line around a match, so a long paragraph shows the part that
// matched rather than its first eighty characters.
function snippetOf(
  lineText: string,
  start: number,
  end: number
): Omit<SearchHit, "line"> {
  const RADIUS = 60;
  const from = Math.max(0, start - RADIUS);
  const to = Math.min(lineText.length, end + RADIUS);
  const lead = from > 0 ? "…" : "";
  const tail = to < lineText.length ? "…" : "";
  const raw = lineText.slice(from, to);
  const trimmed = raw.replace(/^\s+/, "");
  const cut = raw.length - trimmed.length;
  return {
    snippet: lead + trimmed.replace(/\s+$/, "") + tail,
    start: lead.length + start - from - cut,
    end: lead.length + end - from - cut,
  };
}

/**
 * Case-insensitive search of every note's text. Capped per note and overall:
 * a one-letter query in a big vault matches everything, and nobody reads past
 * the first screens of it.
 */
export function searchNotes(
  notes: Note[],
  query: string,
  opts: { perNote?: number; total?: number } = {}
): SearchResult[] {
  const q = query.trim();
  if (!q) return [];
  const perNote = opts.perNote ?? 5;
  const total = opts.total ?? 200;
  const re = new RegExp(escapeRegExp(q), "gi");
  const results: SearchResult[] = [];
  let count = 0;
  const ordered = [...notes].sort((a, b) => a.rel.localeCompare(b.rel));
  for (const note of ordered) {
    if (count >= total) break;
    const text = note.text;
    // A name match with no text match still counts: searching for a note by
    // what it's called shouldn't come back empty.
    const nameHit = note.name.toLowerCase().includes(q.toLowerCase());
    if (!text) {
      if (nameHit) results.push({ note, hits: [] });
      continue;
    }
    re.lastIndex = 0;
    const hits: SearchHit[] = [];
    let m: RegExpExecArray | null;
    let lineNo = 0;
    let lineStart = 0;
    while (hits.length < perNote && count < total && (m = re.exec(text))) {
      // Walk line starts forward to the match rather than splitting the
      // whole note: most notes match once or not at all.
      let nl = text.indexOf("\n", lineStart);
      while (nl !== -1 && nl < m.index) {
        lineNo++;
        lineStart = nl + 1;
        nl = text.indexOf("\n", lineStart);
      }
      const lineEnd = nl === -1 ? text.length : nl;
      const lineText = text.slice(lineStart, lineEnd).replace(/\r$/, "");
      const s = snippetOf(lineText, m.index - lineStart, m.index - lineStart + m[0].length);
      hits.push({ line: lineNo, ...s });
      count++;
      // One hit per line is enough to point at it.
      re.lastIndex = lineEnd + 1;
    }
    if (hits.length > 0 || nameHit) results.push({ note, hits });
  }
  return results;
}

// --- Backlinks -----------------------------------------------------------

export interface Backlink {
  note: Note;
  // The lines the links sit on, trimmed, one per distinct line.
  contexts: { line: number; text: string }[];
}

export function backlinksTo(notes: Note[], target: string): Backlink[] {
  const out: Backlink[] = [];
  for (const note of notes) {
    if (equalPath(note.path, target)) continue;
    const lines = new Set<number>();
    for (const link of note.links) {
      if (equalPath(link.target, target)) lines.add(link.line);
    }
    if (lines.size === 0) continue;
    const textLines = note.text ? note.text.split("\n") : [];
    const contexts = [...lines]
      .sort((a, b) => a - b)
      .map((line) => ({ line, text: (textLines[line] ?? "").trim() }));
    out.push({ note, contexts });
  }
  return out.sort((a, b) => a.note.rel.localeCompare(b.note.rel));
}
