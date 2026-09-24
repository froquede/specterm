// Finding the file paths inside a line of terminal output.
//
// Output is prose with paths buried in it — a stack trace, `ls -l`, a compiler
// error, an agent telling you which file it touched. The path is the one part
// you want in your hands, and the only way to get it was a careful drag with
// the mouse, which is exactly the thing a terminal is worst at.
//
// So this file answers one question about a line of text: which spans of it are
// worth clicking? The answer feeds the link layer (lib/terminal-links.ts),
// which underlines those spans and copies one when it's clicked. URLs are found
// in the same pass — one scan decides where every clickable span starts and
// ends, so the two kinds can never disagree about a boundary.
//
// The rule everywhere below is *be reluctant*. A false positive underlines a
// word that isn't a path and copies noise when clicked; the cost is small but
// it's paid on every screen of output, so a candidate has to look like a path
// and not merely contain a slash. `24/7`, `and/or`, `08/09/2026` and `km/h` are
// the shapes that talked their way in first, and each one is why a rule below
// exists.
//
// Pure and DOM-free on purpose: this is where the guessing lives, so it is the
// part worth testing directly (test/path-links.mjs). Keep it erasable
// TypeScript — no enums, no parameter properties — since the test strips types
// with node rather than compiling.

/** A span of the line worth making clickable. `end` is exclusive. */
export interface PathMatch {
  start: number;
  end: number;
  text: string;
  // URLs are matched here too, so that one pass over the line finds everything
  // clickable and the two kinds can't disagree about where a span ends. The
  // kind only matters at activation: Ctrl/⌘+click opens a URL, and there is
  // nothing to open for a path.
  kind: "path" | "url";
}

// Characters a path may contain when it isn't quoted. Whitespace ends it (an
// unquoted path can't hold a space); quotes and backticks end it because they
// delimit it; brackets, parens, commas and semicolons end it because they are
// how prose and shells put a path *inside* something else, and swallowing the
// closer is how a link ends up one character too long. Globs (`*`, `?`) stay
// in — `src/**/*.ts` is a thing people copy.
const SEG =
  "[^\\s\"'`<>|(){}\\[\\],;" +
  // A TUI draws its frame in the same row as the text inside it: Claude Code,
  // lazygit and friends put box-drawing rules, arrows and bullets hard against
  // a path, and a non-breaking space where a layout needs a space that won't
  // break. None of them can be part of a path, and swallowing one makes the
  // copied path wrong in a way that only shows up when you paste it.
  "\\u00a0\\u2010-\\u2027\\u2190-\\u21ff\\u2500-\\u25ff" +
  // Curly quotes, which prose puts around a path the same way straight ones do.
  "\\u2018\\u2019\\u201c\\u201d]";

// The shapes we accept, tried in this order at each position.
const BRANCHES = [
  // \\server\share — a UNC path.
  `\\\\\\\\${SEG}+`,
  // C:\Users\… or C:/Users/… — a Windows path rooted at a drive.
  `[A-Za-z]:[\\\\/]${SEG}*`,
  // /etc/hosts, ~/notes, ./run.sh, ../pkg — anchored by its first character.
  `(?:~|\\.{1,2})?/${SEG}*`,
  // src\lib\foo.ts — Windows, relative. Matched everywhere, not just on
  // Windows: output is often quoting a machine that isn't this one.
  `[\\w@.+~-]+(?:\\\\${SEG}*)+`,
  // src/lib/foo.ts — POSIX, relative.
  `[\\w@.+~-]+(?:/${SEG}*)+`,
  // App.tsx:12:5 — a bare filename that a compiler pinned to a line. Without
  // the line number this would be every dotted word on screen, so the suffix
  // is required.
  `[\\w@.+-]+\\.[A-Za-z0-9]{1,10}:\\d+(?::\\d+)?`,
];

const CANDIDATE = new RegExp(BRANCHES.join("|"), "g");

// A URL. Matched first and claimed whole, because every one of them contains
// slashes and would otherwise be carved up into paths.
const URL_LIKE = /(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|www\.)[^\s"'`<>]+/g;

// A quoted run — how a path with a space in it arrives ("~/My Documents/a.md").
const QUOTED = /"([^"\n]{1,1024})"|'([^'\n]{1,1024})'/g;

// Punctuation a sentence puts after a path, never part of the path itself.
const TRAILING = /[.,;:!?)\]}>'"…]+$/;

/**
 * Does this span read as a path, rather than as a word that happens to hold a
 * slash? Each early return is a shape we're confident about; anything that
 * reaches the end has to earn it with a file extension.
 */
export function plausiblePath(text: string): boolean {
  if (text.length < 2) return false;
  // Digits, separators and punctuation only: a date, a fraction, a ratio, a
  // clock time. Never a path worth linking.
  if (/^[\d/\\.:%-]+$/.test(text)) return false;
  // Rooted at a drive or a host — unambiguous.
  if (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith("\\\\")) return true;
  // A compiler's file:line — the suffix is what makes it unambiguous.
  if (/^[\w@.+-]+\.[A-Za-z0-9]{1,10}:\d+/.test(text)) return true;

  const separators = text.match(/[\\/]/g)?.length ?? 0;
  if (separators === 0) return false;
  // The author anchored it: it starts with /, ~/, ./ or ../.
  if (/^(?:~|\.{1,2})?[\\/]/.test(text)) return true;
  // Two or more separators is a directory chain, not an "and/or".
  if (separators >= 2) return true;
  // A trailing separator says directory out loud.
  if (/[\\/]$/.test(text)) return true;
  // One separator left: accept it only if the last segment has an extension,
  // which is what separates "src/main.rs" from "km/h".
  const base = text.split(/[\\/]/).pop() ?? "";
  return /\.[A-Za-z0-9]{1,10}$/.test(base.replace(/:\d+(?::\d+)?$/, ""));
}

/**
 * The extra bar a quoted run has to clear.
 *
 * Quotes are how a path with a space in it arrives, so the space rule that
 * ends every unquoted match is lifted here — and lifting it lets a whole
 * quoted sentence with a couple of slashes in it ("see /etc/hosts now") pass
 * as one path. What separates the two is where the space falls: a quoted path
 * starts *with* the path, so its first separator comes before its first space.
 */
function plausibleQuotedPath(text: string): boolean {
  const firstSeparator = text.search(/[\\/]/);
  if (firstSeparator === -1) return false;
  const firstSpace = text.search(/\s/);
  if (firstSpace !== -1 && firstSpace < firstSeparator) return false;
  return plausiblePath(text);
}

interface Span {
  start: number;
  end: number;
}

function overlaps(spans: Span[], start: number, end: number): boolean {
  return spans.some((s) => start < s.end && end > s.start);
}

/**
 * Every path-looking span in `line`, left to right and non-overlapping.
 *
 * Quoted runs are read first, so a path with a space in it survives whole; the
 * unquoted scan then skips whatever the quotes and the URLs already claimed.
 */
export function findPathLinks(line: string): PathMatch[] {
  if (!line) return [];

  const claimed: Span[] = [];
  const found: PathMatch[] = [];

  URL_LIKE.lastIndex = 0;
  for (let m = URL_LIKE.exec(line); m; m = URL_LIKE.exec(line)) {
    const text = m[0].replace(TRAILING, "");
    if (!text) continue;
    const start = m.index;
    const end = start + text.length;
    // The whole match is claimed, trimmed punctuation included, so the path
    // scan can't pick the tail of a URL back up as a relative path.
    claimed.push({ start, end: m.index + m[0].length });
    found.push({ start, end, text, kind: "url" });
  }

  QUOTED.lastIndex = 0;
  for (let m = QUOTED.exec(line); m; m = QUOTED.exec(line)) {
    const inner = m[1] ?? m[2] ?? "";
    if (!inner || !plausibleQuotedPath(inner)) continue;
    const start = m.index + 1;
    const end = start + inner.length;
    // Claimed only when it produced a link, so that the quotes an apostrophe
    // paired up by accident ("don't open '/etc/hosts'") don't hide the path
    // inside them from the unquoted scan below.
    claimed.push({ start: m.index, end: m.index + m[0].length });
    found.push({ start, end, text: inner, kind: "path" });
  }

  CANDIDATE.lastIndex = 0;
  for (let m = CANDIDATE.exec(line); m; m = CANDIDATE.exec(line)) {
    let text = m[0];
    let start = m.index;
    // Drop the sentence's punctuation, but keep a `:12:5` the compiler added:
    // the trim only ever eats characters at the very end, and a line number
    // ends in a digit.
    const trimmed = text.replace(TRAILING, "");
    if (trimmed !== text) {
      // Resume the scan where the trim ended, so the punctuation we dropped is
      // still eligible to start the next match. A match trimmed to nothing
      // would put lastIndex back where we started, so step past it instead.
      text = trimmed;
      CANDIDATE.lastIndex = text ? start + text.length : start + m[0].length;
    }
    let end = start + text.length;
    // `@src/lib/foo.ts` is how an agent writes a file mention. The path is the
    // part you want on the clipboard; the marker is that tool's syntax.
    if (text.startsWith("@") && text.length > 1) {
      text = text.slice(1);
      start += 1;
    }
    end = start + text.length;
    if (!text || !plausiblePath(text)) continue;
    if (overlaps(claimed, start, end)) continue;
    claimed.push({ start, end });
    found.push({ start, end, text, kind: "path" });
  }

  return found.sort((a, b) => a.start - b.start);
}

/** Where a matched path is being read from, for turning it into a real one. */
export interface PathContext {
  /** The pane's working directory — what a relative path is relative to. */
  cwd: string;
  /** The user's home directory, for a leading `~`. */
  home: string;
  /** Host path rules. Set from the OS, never guessed from the string. */
  windows: boolean;
}

// A compiler's line/column suffix. Part of the path for reading and for
// copying; not part of it for opening.
const LINE_SUFFIX = /:\d+(?::\d+)?$/;

/**
 * Turn a matched path into one the OS can open, or null when it can't be one.
 *
 * Three things happen: the `:12:5` a compiler appended comes off, a leading `~`
 * becomes the home directory, and anything still relative is resolved against
 * the directory the pane is in — which is the only reason a relative path in
 * output means anything at all.
 */
export function resolveMatchedPath(text: string, ctx: PathContext): string | null {
  let path = text.replace(LINE_SUFFIX, "");
  if (!path) return null;

  if (path === "~" || path.startsWith("~/") || (ctx.windows && path.startsWith("~\\"))) {
    if (!ctx.home) return null;
    const rest = path.slice(1).replace(/^[\\/]/, "");
    path = rest ? joinPath(ctx.home, rest, ctx.windows) : ctx.home;
    return path;
  }

  if (isAbsolutePath(path, ctx.windows)) return path;
  if (!ctx.cwd) return null;
  // A leading "./" is the author saying "here", which the join already says.
  return joinPath(ctx.cwd, path.replace(/^\.[\\/]+/, ""), ctx.windows);
}

/** The `:12:5` a compiler appended to `text`, or "" when there is none. */
export function lineSuffixOf(text: string): string {
  return text.match(LINE_SUFFIX)?.[0] ?? "";
}

/**
 * True for a match that means nothing without knowing where it was printed
 * from — `src/a.ts`, `./run.sh` — as opposed to one rooted at a drive, `/` or
 * `~`, which says where it is on its own.
 */
export function isRelativeMatch(text: string, windows: boolean): boolean {
  const path = text.replace(LINE_SUFFIX, "");
  if (!path || path === "~" || path.startsWith("~/") || path.startsWith("~\\")) return false;
  // Rooted at a separator: absolute somewhere, even when not on this host.
  if (/^[\\/]/.test(path)) return false;
  return !isAbsolutePath(path, windows);
}

// Characters that end a path when walking left from a match in the haystack:
// whatever quotes it, or puts it inside something else.
const PATH_STOP = /[\s"'`<>|(){}[\],;=]/;

/**
 * Absolute paths in `haystack` that end in the relative path `relative`, newest
 * (last) first.
 *
 * The haystack is a stretch of a Claude Code transcript. An agent names the
 * file it wrote relative to wherever it happens to be thinking from
 * ("ux-specs/nf/handoff.html"), which is often neither the pane's directory nor
 * anything under it — but the tool call that wrote the file carried the full
 * path, and that is still in the transcript. The transcript is JSON, so a
 * Windows separator arrives escaped (`\\`) and is matched as such.
 */
export function absolutePathsEndingWith(
  haystack: string,
  relative: string,
  windows: boolean
): string[] {
  const rel = relative.replace(LINE_SUFFIX, "").replace(/^\.[\\/]+/, "");
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  // A `..` climbs out of somewhere we don't know; no suffix can stand for it.
  if (!haystack || !parts.length || parts.includes("..")) return [];

  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tail = new RegExp(
    parts.map(escape).join("(?:/|\\\\{1,2})"),
    // Windows filesystems ignore case, and so does the way people type them.
    windows ? "gi" : "g"
  );

  const found: string[] = [];
  for (let m = tail.exec(haystack); m; m = tail.exec(haystack)) {
    const end = m.index + m[0].length;
    // The match has to be the whole last segment: not "a.html" inside
    // "a.html.bak". A JSON escape (`\n`, `\"`) right after it still ends it.
    const next = haystack[end];
    if (next && !PATH_STOP.test(next) && !(next === "\\" && /[nrt"]/.test(haystack[end + 1] ?? ""))) {
      continue;
    }
    // …and the whole first segment: a separator right before it.
    if (!/[\\/]/.test(haystack[m.index - 1] ?? "")) continue;
    let start = m.index - 1;
    while (start > 0 && !PATH_STOP.test(haystack[start - 1])) start--;
    let path = haystack.slice(start, end).replace(/\\\\/g, "\\").replace(/\\\//g, "/");
    if (windows) path = path.replace(/\//g, "\\");
    if (!isAbsolutePath(path, windows)) continue;
    found.push(path);
  }
  return [...new Set(found.reverse())];
}

/** True when `path` needs no directory to be understood. */
export function isAbsolutePath(path: string, windows: boolean): boolean {
  if (windows) return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
  return path.startsWith("/");
}

function joinPath(dir: string, rest: string, windows: boolean): string {
  const sep = windows ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${sep}${rest}`;
}

// File types Specterm shows itself: markdown gets the rendered preview, images
// the viewer, and the rest the read-only syntax-highlighted reader. Anything
// not in here — a PDF, a spreadsheet, a binary — belongs to whatever
// application the OS gives it, which is what a modifier-click falls back to.
//
// Extension-only, deliberately: this decides where a click goes, and reading
// the file to find out would put a disk round trip inside a click.
const VIEWABLE_EXTENSIONS = new Set([
  // markdown and plain prose
  "md", "markdown", "txt", "text", "log", "rst", "adoc",
  // data and config
  "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
  "properties", "csv", "tsv", "xml", "plist", "lock",
  // web
  "html", "htm", "css", "scss", "sass", "less", "svelte", "vue", "astro",
  // code
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "py", "rb", "go", "rs",
  "java", "kt", "kts", "scala", "clj", "ex", "exs", "erl", "hs", "ml", "c", "h",
  "cc", "cpp", "hpp", "cs", "php", "swift", "m", "mm", "dart", "lua", "pl",
  "r", "jl", "sql", "graphql", "gql", "proto", "sh", "bash", "zsh", "fish",
  "ps1", "bat", "cmd", "patch", "diff",
  // images
  "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "avif",
]);

// Files that carry their type in their name instead of an extension.
const VIEWABLE_NAMES = new Set([
  "makefile", "dockerfile", "readme", "license", "licence", "changelog",
  "gemfile", "rakefile", "procfile", "brewfile", "justfile", "vagrantfile",
  ".gitignore", ".gitattributes", ".editorconfig", ".env", ".npmrc", ".nvmrc",
  ".prettierrc", ".eslintrc", ".bashrc", ".zshrc", ".profile",
]);

/** True when Specterm has a viewer for this file, so it can open in a pane. */
export function opensInSpecterm(path: string): boolean {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (!name) return false;
  if (VIEWABLE_NAMES.has(name)) return true;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false; // no extension, or a dotfile we don't know
  return VIEWABLE_EXTENSIONS.has(name.slice(dot + 1));
}
