// Platform-aware path helpers for the renderer.
//
// The renderer is sandboxed (contextIsolation on, no nodeIntegration), so Node's
// `path` module isn't available — these are pure, synchronous reimplementations
// of just the pieces the file tree needs. Behavior is selected from the host OS
// (see lib/platform.ts), NOT from the shape of the input string, so a stray
// forward slash on Windows doesn't flip us into POSIX mode.
//
// Windows quirks handled here:
//   - separators are backslashes, but fs.readdir tolerates mixed `/` and `\`
//   - drive roots ("C:\") are the top of a volume; there's no single "/" above
//     them — going up from a drive root means "show the drive list"
//   - the filesystem is case-insensitive, so path equality must be too

import { os } from "./platform";

const WIN = os === "windows";

/** Native path separator for the host OS. */
export const sep = WIN ? "\\" : "/";

/** Matches a Windows drive root: "C:", "C:\", "C:/". */
const WIN_ROOT = /^[A-Za-z]:[\\/]?$/;

/** Collapse mixed separators to the platform separator (Windows only). */
export function normalize(p: string): string {
  if (!p) return p;
  if (WIN) {
    let out = p.replace(/\//g, "\\");
    // Bare drive letter "C:" → "C:\" so it reads as a root, not a relative ref.
    if (/^[A-Za-z]:$/.test(out)) out += "\\";
    return out;
  }
  return p;
}

/** True when `p` is a filesystem root we can't navigate above. */
export function isRoot(p: string): boolean {
  return WIN ? WIN_ROOT.test(p) : p === "/";
}

/**
 * Join a directory and a child name with the platform separator, avoiding a
 * doubled separator when `dir` already ends in one (e.g. a drive root "C:\").
 */
export function join(dir: string, name: string): string {
  if (!dir) return name;
  const trimmed = dir.replace(/[\\/]+$/, "");
  // A bare drive ("C:") needs its separator restored before appending.
  if (WIN && /^[A-Za-z]:$/.test(trimmed)) return `${trimmed}\\${name}`;
  return `${trimmed}${sep}${name}`;
}

/**
 * The parent directory of `p`. Returns "" as a sentinel meaning "there is no
 * parent to navigate to" — on Windows that's the cue to show the drive list;
 * on POSIX it means we're already at "/".
 */
export function dirname(p: string): string {
  if (!p || isRoot(p)) return "";
  const trimmed = p.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (i < 0) return "";
  if (i === 0) return WIN ? "" : "/"; // "/foo" → "/"
  const parent = trimmed.slice(0, i);
  // "C:\foo" → "C:" — normalize back to a real root "C:\".
  if (WIN && /^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  return parent;
}

/** The final path segment (separator-aware). */
export function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return (i >= 0 ? trimmed.slice(i + 1) : trimmed) || sep;
}

/** Path equality — case-insensitive on Windows, separator-insensitive. */
export function equalPath(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  return WIN ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/**
 * Build a shell command that changes the working directory to `path`, escaped
 * for the host OS's default shell. Windows terminals default to PowerShell
 * (pwsh/powershell), where the bash `cd 'x'\''y'` escaping is wrong.
 */
// Characters a shell passes through untouched, so a path made only of these
// needs no quoting at all. Deliberately conservative — anything outside this set
// (spaces, quotes, globs, $, &, parentheses…) sends the path down the quoted
// path below.
const BARE_PATH = /^[A-Za-z0-9_@%+=:,.\\/-]+$/;

/**
 * Render a path for insertion into a prompt line the user is still typing — a
 * dropped image handed to whatever is running in the pane. Unlike shellQuoteCd
 * this builds no command, and it quotes only when it has to.
 *
 * The restraint is the point: what usually reads that line is not a shell but a
 * program prompting inside one (Claude Code, say, which attaches an image when
 * it sees its path). Those read the raw characters, so a path wrapped in quotes
 * it didn't ask for is a path it may not recognize. Quoting is kept for the
 * paths a shell would genuinely mangle.
 */
export function shellQuotePath(path: string): string {
  if (BARE_PATH.test(path)) return path;
  // PowerShell doubles an embedded single quote; POSIX shells end the quoted
  // run, escape the quote, and open a new one.
  return WIN
    ? `'${path.replace(/'/g, "''")}'`
    : `'${path.replace(/'/g, "'\\''")}'`;
}

export function shellQuoteCd(path: string): string {
  if (WIN) {
    // PowerShell escapes a single quote by doubling it; -LiteralPath avoids
    // glob/[] interpretation of the path.
    return `Set-Location -LiteralPath '${path.replace(/'/g, "''")}'`;
  }
  return `cd '${path.replace(/'/g, "'\\''")}'`;
}
