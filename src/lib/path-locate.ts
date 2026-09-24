// Finding the file a relative path in terminal output is talking about.
//
// A relative path only means something relative to the directory it was
// printed from, and that is often not the pane's. An agent names the file it
// just wrote relative to the repo it was working in ("ux-specs/nf/a.html"
// under prd-docs/), a build tool relative to its package, a test runner
// relative to its root. Joining any of those onto the pane's directory gives a
// path that doesn't exist, which made the link useless in exactly the output
// that has the most of them.
//
// So a relative path is looked for, cheapest and surest first:
//   1. the pane's directory — what it means most of the time;
//   2. the Claude Code transcript for the pane, where the tool call that wrote
//      the file recorded the full path (see session-providers/claude.ts);
//   3. the directories above the pane's — output from a subdirectory's tool;
//   4. a shallow walk below the pane's directory and its parent — a sibling
//      repo, a package in a monorepo.
// Every candidate is stat'd before it is believed: a path the transcript
// mentions may have been moved since, and the walk only guesses.

import { getBackend } from "../backends";
import { transcriptPath } from "./session-providers/claude";
import {
  absolutePathsEndingWith,
  isRelativeMatch,
  lineSuffixOf,
  resolveMatchedPath,
} from "./path-links";

// Transcript tail read looking for the full path. Same bound the diagram
// detector uses: the last several turns, off the end of a file that can be
// tens of megabytes.
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;

// How many directories above the pane's are tried.
const MAX_ANCESTORS = 4;

// How deep the walk goes below the pane's directory, and below its parent.
const WALK_DEPTH_CWD = 3;
const WALK_DEPTH_PARENT = 2;

// Ceilings on the walk. It runs inside a click, so it gives up long before
// anybody would notice it thinking; a path it can't find in this much of the
// tree is copied as printed.
const WALK_MAX_DIRS = 300;
const WALK_BUDGET_MS = 1000;

// Directories no printed path is ever relative to, and which are big enough
// to eat the whole budget. Hidden directories are skipped as well.
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", "target", "vendor", "coverage",
  "__pycache__", "venv", "bower_components",
]);

export interface LocateContext {
  cwd: string;
  // The pane's Claude Code session, when it has one. Without it the newest
  // transcript for the directory is used.
  sessionId?: string;
  windows: boolean;
}

// The user's home directory, for expanding a leading `~`. Asked for once and
// kept: it can't change while the app is running, and a click shouldn't wait on
// a round trip to find out what it already knows.
let homePath: Promise<string> | null = null;
export function homeDir(): Promise<string> {
  homePath ??= getBackend()
    .then((backend) => backend.getHomePath())
    .catch(() => "");
  return homePath;
}

function join(dir: string, rest: string, windows: boolean): string {
  const sep = windows ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${sep}${rest.replace(/^[\\/]+/, "")}`;
}

function parentOf(dir: string): string | null {
  const trimmed = dir.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut <= 0) return null;
  // "C:\Users" climbs to "C:\", not to "C:".
  const parent = trimmed.slice(0, cut);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

async function exists(path: string): Promise<boolean> {
  try {
    const backend = await getBackend();
    return (await backend.statPath(path)).exists;
  } catch {
    return false;
  }
}

/**
 * The absolute path a printed path stands for, or null when it can't be found.
 *
 * An absolute or `~` path is returned resolved and unchecked — it already says
 * where it is. A relative one is only returned once something exists there.
 * The `:12:5` a compiler appended is not part of the answer.
 */
export async function locatePath(text: string, ctx: LocateContext): Promise<string | null> {
  const home = await homeDir();
  const direct = resolveMatchedPath(text, { cwd: ctx.cwd, home, windows: ctx.windows });
  if (!isRelativeMatch(text, ctx.windows)) return direct;
  const found = await findRelative(text, direct, ctx);
  // The pane's directory arrives with forward slashes on Windows (OSC 7 is a
  // URL), and the printed part may have either; what gets pasted should read
  // like a Windows path.
  return found && ctx.windows ? found.replace(/\//g, "\\") : found;
}

async function findRelative(
  text: string,
  direct: string | null,
  ctx: LocateContext
): Promise<string | null> {
  if (!ctx.cwd) return null;
  // A pane sitting on a network share: even a stat connects to the host (see
  // isNetworkSharePath in electron/main.cjs), so nothing is looked for.
  if (ctx.windows && /^[\\/]{2}/.test(ctx.cwd)) return null;
  if (direct && (await exists(direct))) return direct;

  const rel = text.slice(0, text.length - lineSuffixOf(text).length).replace(/^\.[\\/]+/, "");
  // `../x` is relative to one directory only, and the join already tried it.
  if (/^\.\.[\\/]/.test(rel)) return null;
  const tried = new Set(direct ? [direct] : []);
  const attempt = async (candidate: string) => {
    if (tried.has(candidate)) return false;
    tried.add(candidate);
    return exists(candidate);
  };

  for (const candidate of await fromTranscript(rel, ctx)) {
    if (await attempt(candidate)) return candidate;
  }

  let dir: string | null = ctx.cwd;
  for (let i = 0; i < MAX_ANCESTORS && dir; i++) {
    dir = parentOf(dir);
    const candidate = dir && join(dir, rel, ctx.windows);
    if (candidate && (await attempt(candidate))) return candidate;
  }

  return walk(rel, ctx, attempt);
}

async function fromTranscript(rel: string, ctx: LocateContext): Promise<string[]> {
  try {
    const path = await transcriptPath(ctx.cwd, ctx.sessionId);
    if (!path) return [];
    const backend = await getBackend();
    const tail = await backend.readFileTail(path, TRANSCRIPT_TAIL_BYTES);
    return absolutePathsEndingWith(tail, rel, ctx.windows);
  } catch {
    // Not a Claude pane, or no transcript to read — the other routes remain.
    return [];
  }
}

/**
 * Breadth-first below the pane's directory, then below its parent, looking for
 * a directory that holds the path's first segment. Only a directory that does
 * costs a stat; the rest cost the listing the walk needed anyway.
 */
async function walk(
  rel: string,
  ctx: LocateContext,
  attempt: (candidate: string) => Promise<boolean>
): Promise<string | null> {
  const first = rel.split(/[\\/]+/)[0];
  if (!first) return null;
  const same = ctx.windows
    ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
    : (a: string, b: string) => a === b;
  const backend = await getBackend();
  const deadline = Date.now() + WALK_BUDGET_MS;
  const listed = new Set<string>();
  let budget = WALK_MAX_DIRS;

  const roots: [string, number][] = [[ctx.cwd, WALK_DEPTH_CWD]];
  const parent = parentOf(ctx.cwd);
  if (parent) roots.push([parent, WALK_DEPTH_PARENT]);

  for (const [root, depth] of roots) {
    let level = [root];
    for (let d = 0; d <= depth && level.length; d++) {
      const next: string[] = [];
      for (const dir of level) {
        // The parent's walk passes back through the pane's own directory.
        if (listed.has(dir)) continue;
        if (budget-- <= 0 || Date.now() > deadline) return null;
        listed.add(dir);
        let entries;
        try {
          entries = await backend.readDir(dir);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (same(entry.name, first)) {
            const candidate = join(dir, rel, ctx.windows);
            if (await attempt(candidate)) return candidate;
          }
          if (
            entry.isDirectory &&
            !entry.name.startsWith(".") &&
            !SKIP_DIRS.has(entry.name)
          ) {
            next.push(join(dir, entry.name, ctx.windows));
          }
        }
      }
      level = next;
    }
  }
  return null;
}
