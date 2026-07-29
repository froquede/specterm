// Getting the exact answer out of Claude Code, by asking it to tell us.
//
// Claude Code fires a hook when it needs the user — `Notification` when it is
// blocked on a permission prompt, `Stop` when it has finished a turn. A hook is
// just a shell command, and it runs as a child of `claude`, which means its
// controlling terminal is the pty of the pane the session is in. So a hook that
// writes one escape sequence to /dev/tty delivers "this pane is waiting" to
// exactly the right pane, instantly, with no guessing and no correlation to do
// afterwards — the pane's own terminal is the channel.
//
// That is the whole trick. Everything below is bookkeeping around one line of
// shell, done carefully because the file being edited is the user's global
// Claude configuration and nothing here has any business disturbing the rest of
// it:
//
//   - The file is read, parsed, minimally amended and written back whole, so
//     unrelated settings survive untouched.
//   - Our two entries are recognized by the OSC they write (MARKER), never by
//     position, so installing twice is a no-op and removing takes ours and only
//     ours.
//   - A file that doesn't parse is left completely alone. Overwriting a config
//     someone hand-edited into a syntax error would lose real work.

import { getBackend } from "../backends";
import { os } from "./platform";

// The sequence the hooks write, and the substring that identifies an entry as
// ours. See registerAttentionHandler in lib/osc.ts for the reading end.
const MARKER = "1337;Attention;";

// `> /dev/tty` and not plain stdout: Claude captures a hook's stdout (it can
// carry structured control back into the session), so anything printed there
// never reaches the terminal. The redirect writes past the capture to the pane.
// The `|| true` keeps a session with no controlling terminal (`claude -p` in a
// pipeline, CI) from seeing a hook fail — there's simply no pane to flag.
function hookCommand(kind: "permission" | "idle"): string {
  return `printf '\\033]${MARKER}kind=${kind}\\007' > /dev/tty 2>/dev/null || true`;
}

// Claude's hooks config is `hooks.<Event>: [{ hooks: [{type, command}] }]`.
interface HookEntry {
  type?: string;
  command?: string;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
}
type HooksConfig = Record<string, HookGroup[]>;

// Which Claude event maps to which kind of waiting.
const EVENTS: Array<{ event: string; kind: "permission" | "idle" }> = [
  // Fired when Claude needs the user — the permission prompt, and the idle
  // nudge when a session has been left unanswered.
  { event: "Notification", kind: "permission" },
  // Fired when a turn is finished and the prompt is yours again.
  { event: "Stop", kind: "idle" },
];

/**
 * Can this platform run the hooks at all?
 *
 * The command writes to /dev/tty, which is a POSIX thing. Windows has no
 * equivalent a one-line hook can use (ConPTY gives no path to the console from
 * a child process), so the exact route is macOS/Linux only and the Settings
 * panel says so rather than installing something that silently does nothing.
 */
export const hooksSupported = os !== "windows";

async function settingsPath(): Promise<string> {
  const backend = await getBackend();
  const home = await backend.getHomePath();
  return `${home}/.claude/settings.json`;
}

function isOurs(group: HookGroup): boolean {
  return (group.hooks ?? []).some((h) => (h.command ?? "").includes(MARKER));
}

/** Are our hooks currently in the user's Claude settings? */
export async function hooksInstalled(): Promise<boolean> {
  try {
    const backend = await getBackend();
    const raw = await backend.readTextFile(await settingsPath());
    const parsed = JSON.parse(raw) as { hooks?: HooksConfig };
    const hooks = parsed?.hooks ?? {};
    // Both, not either: a half-installed pair would report the permission
    // prompt and never the end of a turn, which reads as the feature being
    // broken rather than as being half-installed.
    return EVENTS.every(({ event }) => (hooks[event] ?? []).some(isOurs));
  } catch (_) {
    // No file yet, or one we can't read/parse — nothing of ours is in it.
    return false;
  }
}

// Read the file into an object we can amend. A missing file is an empty config
// (we'll create it); a malformed one throws, and callers surface that rather
// than clobbering it.
async function readSettings(path: string): Promise<Record<string, unknown>> {
  const backend = await getBackend();
  let raw: string;
  try {
    raw = await backend.readTextFile(path);
  } catch (_) {
    return {};
  }
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("~/.claude/settings.json is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

async function writeSettings(
  path: string,
  settings: Record<string, unknown>
): Promise<void> {
  const backend = await getBackend();
  // Two-space indent and a trailing newline: this is a file people edit by
  // hand, and a rewrite shouldn't turn it into one line.
  await backend.writeTextFile(path, `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * Add the two hooks, leaving everything else in the file as it was.
 *
 * Idempotent: an entry of ours already present for an event is replaced rather
 * than duplicated, so re-running after an upgrade refreshes the command.
 */
export async function installHooks(): Promise<void> {
  if (!hooksSupported) {
    throw new Error("Claude hooks need /dev/tty — macOS and Linux only");
  }
  const path = await settingsPath();
  const settings = await readSettings(path);

  const hooks: HooksConfig =
    settings.hooks && typeof settings.hooks === "object"
      ? ({ ...(settings.hooks as HooksConfig) })
      : {};

  for (const { event, kind } of EVENTS) {
    const groups = Array.isArray(hooks[event]) ? [...hooks[event]] : [];
    hooks[event] = [
      ...groups.filter((g) => !isOurs(g)),
      { hooks: [{ type: "command", command: hookCommand(kind) }] },
    ];
  }

  settings.hooks = hooks;
  await writeSettings(path, settings);
}

/**
 * Take our two hooks back out, and only ours.
 *
 * An event left with no groups is deleted rather than left as an empty array,
 * so removing restores the file to the shape it had before.
 */
export async function removeHooks(): Promise<void> {
  const path = await settingsPath();
  const settings = await readSettings(path);
  if (!settings.hooks || typeof settings.hooks !== "object") return;

  const hooks: HooksConfig = { ...(settings.hooks as HooksConfig) };
  for (const { event } of EVENTS) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const kept = groups.filter((g) => !isOurs(g));
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }

  if (Object.keys(hooks).length) settings.hooks = hooks;
  else delete settings.hooks;
  await writeSettings(path, settings);
}
