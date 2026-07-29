// Recognizing a Claude Code session running in a pane.
//
// The goal is one string: the session id, which is what `claude --resume` takes.
// Getting it is less direct than it looks, and the two routes here are the two
// that actually work — both were arrived at by elimination:
//
//   - The `claude` process does NOT carry CLAUDE_CODE_SESSION_ID in its own
//     environment. It sets that variable for the processes it *spawns*, so the
//     obvious "read the env of the thing we found" returns nothing.
//   - It doesn't hold the transcript file open either, so the open-descriptor
//     route (which would be exact and free) finds nothing to read.
//
// What's left:
//
//   1. **Exact** — read CLAUDE_CODE_SESSION_ID off one of claude's own children.
//      Every tool call it makes is such a child, so in an active session this
//      answers within seconds. It's silent whenever claude happens to be idle,
//      which is why it can't be the only route.
//   2. **Heuristic** — the most recently modified transcript under the project
//      directory for this pane's cwd. Transcripts are named for their session
//      and live in a directory named for the project, so this is exact except
//      when two sessions run in the same directory at once, where it names the
//      more recently active one.
//
// The exact answer wins and, once found, is never replaced by a heuristic one.

import type { SessionMeta } from "../../types";
import { getBackend } from "../../backends";
import type { ProcessInfo } from "../../backends/types";

const PROVIDER = "claude";

// The variable claude exports into every process it spawns.
const SESSION_ENV = "CLAUDE_CODE_SESSION_ID";

// Where transcripts live, one directory per project, one file per session.
const TRANSCRIPT_EXT = ".jsonl";

// A transcript older than this belongs to a session that has been idle since
// before the pane's shell could plausibly have started it. Without the bound, a
// pane sitting at a bare prompt in a directory where claude ran last week would
// be "restored" into a week-old conversation.
const TRANSCRIPT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

// Ways of invoking the same binary that aren't a conversation, and so have no
// session to resume. Everything else — a bare `claude`, `claude --resume <id>`,
// `claude "do the thing"` — is one.
const NON_INTERACTIVE_SUBCOMMANDS = new Set([
  "mcp",
  "config",
  "update",
  "doctor",
  "install",
  "migrate-installer",
  "setup-token",
  "plugin",
]);
const NON_INTERACTIVE_FLAGS = new Set(["-p", "--print", "--chrome-native-host"]);

/** Does this process look like an interactive Claude Code session? */
function isClaude(proc: ProcessInfo): boolean {
  if (proc.comm !== "claude") return false;

  const args = (proc.args ?? "").trim();
  if (!args) return true; // no command line reported — assume the common case

  const rest = args.split(/\s+/).slice(1);
  if (rest.some((a) => NON_INTERACTIVE_FLAGS.has(a))) return false;
  // A subcommand, when there is one, is always the first token — so this can't
  // be confused by a value that follows a flag (`--resume <id>`).
  return !(rest[0] && NON_INTERACTIVE_SUBCOMMANDS.has(rest[0]));
}

/**
 * Is a Claude Code session running in this pane *right now*?
 *
 * Distinct from `detect` below, whose answer is deliberately sticky (a session
 * you just quit is still resumable). The attention heuristic needs the opposite
 * — the live fact — so a `make` running in a pane where claude was closed an
 * hour ago isn't mistaken for a turn ending. Free to ask: the caller already
 * has the process list.
 */
export function isRunning(descendants: ProcessInfo[]): boolean {
  return descendants.some(isClaude);
}

/**
 * How Claude Code names the directory holding a project's transcripts: the
 * absolute path with every separator turned into a dash, so /home/me/dev
 * becomes -home-me-dev.
 */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[/\\]/g, "-");
}

const uuidFile = new RegExp(
  `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\${TRANSCRIPT_EXT}$`,
  "i"
);

function meta(id: string): SessionMeta {
  return { provider: PROVIDER, id, resumeCommand: `claude --resume ${id}` };
}

// Route 1: the session id as claude itself reports it to its children.
//
// Only processes running *under* the claude we found are asked, never every
// process under the shell. That isn't a refinement — it's what makes the answer
// mean anything. The variable is inherited, so if Specterm itself was launched
// from a Claude Code terminal, every shell it spawns already carries the
// *launching* session's id, and any sibling process would happily report it.
// Claude overrides the variable for its own children, so descending through it
// is what distinguishes the session in this pane from the one that opened the
// app.
async function exactFromChildren(
  claudePid: number,
  descendants: ProcessInfo[]
): Promise<string | null> {
  const byParent = new Map<number, ProcessInfo[]>();
  for (const proc of descendants) {
    const siblings = byParent.get(proc.ppid);
    if (siblings) siblings.push(proc);
    else byParent.set(proc.ppid, [proc]);
  }

  const candidates: ProcessInfo[] = [];
  const queue = [claudePid];
  const seen = new Set(queue);
  while (queue.length) {
    for (const child of byParent.get(queue.shift()!) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      candidates.push(child);
      queue.push(child.pid);
    }
  }

  const backend = await getBackend();
  for (const child of candidates) {
    try {
      const env = await backend.readProcessEnv(child.pid, [SESSION_ENV]);
      const id = env[SESSION_ENV];
      if (id) return id;
    } catch (_) {
      // Process exited between the scan and the read — try the next one.
    }
  }
  return null;
}

// Route 2: the most recently touched transcript for this directory.
async function heuristicFromTranscripts(cwd: string): Promise<string | null> {
  if (!cwd) return null;
  try {
    const backend = await getBackend();
    const home = await backend.getHomePath();
    const dir = `${home}/.claude/projects/${projectDirName(cwd)}`;
    const entries = await backend.readDirStats(dir);

    const cutoff = Date.now() - TRANSCRIPT_MAX_AGE_MS;
    const newest = entries
      .filter((e) => !e.isDirectory && uuidFile.test(e.name))
      .filter((e) => e.mtimeMs >= cutoff)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];

    return newest ? newest.name.slice(0, -TRANSCRIPT_EXT.length) : null;
  } catch (_) {
    // No such project directory, or no filesystem access — nothing to resume.
    return null;
  }
}

/**
 * Inspect one pane's processes and report the session running in it, if any.
 *
 * `known` is what was already recorded for this pane: an exact id is kept as-is
 * (re-reading it every poll would be pure cost), and it stops a heuristic answer
 * from overwriting something better.
 */
export async function detect(
  descendants: ProcessInfo[],
  cwd: string,
  known: SessionMeta | undefined
): Promise<SessionMeta | undefined> {
  const claude = descendants.find(isClaude);
  if (!claude) {
    // Nothing running now. Keep whatever was recorded — the user may have just
    // quit claude, and the session is still resumable; that's the case where
    // remembering it is worth the most.
    return known;
  }

  if (known?.provider === PROVIDER && known.exact) return known;

  const exact = await exactFromChildren(claude.pid, descendants);
  if (exact) return { ...meta(exact), exact: true };

  if (known?.provider === PROVIDER) return known;

  // Claude's own directory, not the pane's. They're usually the same, but the
  // pane's copy is exactly wrong in the case that matters here: while a
  // full-screen program holds the screen no new prompt is drawn, so no OSC 7
  // arrives, and the shell's cached directory is whatever it was *before* the
  // `cd … && claude` that started this session. Looking up transcripts under
  // that stale path finds nothing.
  const guess = await heuristicFromTranscripts(claude.cwd || cwd);
  return guess ? meta(guess) : known;
}
