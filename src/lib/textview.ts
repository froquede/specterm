// Helpers for the read-only text/code viewer (components/TextPane.tsx).
//
// Performance is a first-class concern here — specterm is a fast terminal, not
// an IDE — so the rules are:
//   - highlight.js is **lazy-loaded** (dynamic import), so opening a text file
//     is the only thing that ever pulls it in; the terminal never pays for it.
//   - We only bundle highlight.js/lib/common (~35 mainstream languages), not the
//     full ~190-language build.
//   - Highlighting is skipped above HIGHLIGHT_BYTE_CAP and language
//     auto-detection (the expensive path) above AUTODETECT_BYTE_CAP — big files
//     render as plain, still-line-numbered text instead of janking.
//   - The gutter is a single text node (see TextPane), not one node per line.

// Files larger than this are shown truncated, with a banner — we never pull an
// unbounded blob into a DOM node.
export const VIEW_BYTE_CAP = 5 * 1024 * 1024; // 5 MB
// Above this we render plain (escaped) text: highlighting a huge file is the
// kind of main-thread stall this app exists to avoid.
export const HIGHLIGHT_BYTE_CAP = 512 * 1024; // 512 KB
// highlightAuto walks every registered grammar — only worth it on small files
// with no usable extension hint.
export const AUTODETECT_BYTE_CAP = 64 * 1024; // 64 KB

// Map file extensions / bare filenames to highlight.js language names. Only the
// cases where the extension differs from what hljs already aliases need to be
// here; anything hljs.getLanguage() recognizes directly still works below.
const EXT_LANG: Record<string, string> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript",
  py: "python", rb: "ruby", rs: "rust", go: "go", kt: "kotlin",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", cfg: "ini", conf: "ini",
  json: "json", jsonc: "json",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml",
  css: "css", scss: "scss", less: "less",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp",
  cs: "csharp", java: "java", php: "php", swift: "swift",
  sql: "sql", pl: "perl", lua: "lua", r: "r", dart: "dart",
  dockerfile: "dockerfile", makefile: "makefile", make: "makefile",
  env: "bash", gitignore: "bash", diff: "diff", patch: "diff",
};

// Bare filenames (no extension) worth recognizing on their own.
const NAME_LANG: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  ".env": "bash",
  ".gitignore": "bash",
  ".bashrc": "bash",
  ".zshrc": "bash",
};

// Every flavour of dotenv file: ".env", ".env.local", ".env.production",
// "env.example". Without this, the trailing segment is read as the extension
// (".env.local" → "local") and the file loses its hint entirely.
const ENV_FILE = /^\.?env(\..+)?$/;

// Line-comment token per resolved language. Languages with no line comment
// (json, xml, css, diff) are deliberately absent — see lineCommentToken.
const LANG_COMMENT: Record<string, string> = {
  bash: "#", python: "#", ruby: "#", perl: "#", r: "#",
  yaml: "#", ini: "#", dockerfile: "#", makefile: "#",
  javascript: "//", typescript: "//", c: "//", cpp: "//", csharp: "//",
  java: "//", go: "//", rust: "//", kotlin: "//", swift: "//", php: "//",
  dart: "//", scss: "//", less: "//",
  sql: "--", lua: "--",
};

function baseName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

/** Best-guess highlight.js language for a path, or null if we have no hint. */
export function languageHint(filePath: string): string | null {
  const name = baseName(filePath);
  const lower = name.toLowerCase();
  if (NAME_LANG[lower]) return NAME_LANG[lower];
  if (ENV_FILE.test(lower)) return "bash";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? lower.slice(dot + 1) : lower; // extensionless → match by name
  return EXT_LANG[ext] || null;
}

/**
 * Line-comment token for a path, or null when the language has none (or we
 * can't tell). Drives the editor's Mod-/ toggle; null leaves the shortcut
 * unbound rather than inserting a token the file's parser would choke on.
 */
export function lineCommentToken(filePath: string): string | null {
  const lang = languageHint(filePath);
  return lang ? (LANG_COMMENT[lang] ?? null) : null;
}

// Cheap binary sniff on the *decoded* string the backend hands back. A real
// binary either contains NUL bytes or, once UTF-8 decoding fails, a heavy dose
// of U+FFFD replacement characters. Sampling the head keeps this O(1)-ish.
export function looksBinary(text: string): boolean {
  const sample = text.slice(0, 8192);
  if (sample.includes("\u0000")) return true;
  let replacements = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample.charCodeAt(i) === 0xfffd) replacements++;
  }
  return sample.length > 0 && replacements / sample.length > 0.1;
}

let hljsPromise: Promise<typeof import("highlight.js/lib/common").default> | null = null;
function loadHljs() {
  if (!hljsPromise) {
    hljsPromise = import("highlight.js/lib/common").then((m) => m.default);
  }
  return hljsPromise;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export interface Highlighted {
  html: string; // safe HTML for the <code> element
  language: string; // resolved language label, or "plain"
}

// Produce highlighted HTML for the code body. Never throws; on any miss it
// falls back to escaped plain text so the file always renders.
export async function highlightCode(
  source: string,
  filePath: string
): Promise<Highlighted> {
  const bytes = source.length; // chars ≈ bytes for our cap purposes
  if (bytes > HIGHLIGHT_BYTE_CAP) {
    return { html: escapeHtml(source), language: "plain" };
  }

  let hljs;
  try {
    hljs = await loadHljs();
  } catch {
    return { html: escapeHtml(source), language: "plain" };
  }

  const hint = languageHint(filePath);
  try {
    if (hint && hljs.getLanguage(hint)) {
      const { value } = hljs.highlight(source, { language: hint, ignoreIllegals: true });
      return { html: value, language: hint };
    }
    if (bytes <= AUTODETECT_BYTE_CAP) {
      const res = hljs.highlightAuto(source);
      return { html: res.value, language: res.language || "plain" };
    }
  } catch {
    // fall through to plain
  }
  return { html: escapeHtml(source), language: "plain" };
}
