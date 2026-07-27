// Putting a resumed session back into a restored pane.
//
// When a snapshot with a `session` on it is hydrated, the pane it becomes is
// registered here. Later — once that pane has actually mounted, spawned a pty
// and its shell has drawn a prompt — the resume command is delivered.
//
// The two halves are split because they happen at very different times: panes
// are hydrated all at once at boot (or the instant a tab is reopened), while a
// pane in a background tab may not mount for minutes, if ever. A map keyed by
// pane id bridges that gap without the tab store having to hold on to anything.
//
// Whether the command is *executed* is the user's call (Settings → Session
// restore). The default types it and stops: a session id is a remembered fact,
// and by the time it's read back the session may have been deleted or the
// project moved. Typing puts the command on screen, where it can be read before
// Enter, instead of running something the user never asked for at startup.

import type { SessionMeta } from "../types";
import { sessionRestoreMode } from "../stores/settings";
import { writePty } from "./pty";

const pending = new Map<string, SessionMeta>();

export function registerPendingRestore(paneId: string, meta: SessionMeta) {
  pending.set(paneId, meta);
}

export function consumePendingRestore(paneId: string): SessionMeta | undefined {
  const meta = pending.get(paneId);
  pending.delete(paneId);
  return meta;
}

/** Drop a pane's pending restore without delivering it (the pane went away). */
export function cancelPendingRestore(paneId: string) {
  pending.delete(paneId);
}

// How long to wait after the shell's first output before writing. The command
// has to arrive after the prompt is drawn: send it earlier and the shell's line
// editor either swallows it or echoes it over the prompt it then prints. First
// output means the rc has run and the prompt is on screen; the extra beat covers
// prompt frameworks (powerlevel10k, starship) that paint asynchronously.
const AFTER_PROMPT_DELAY_MS = 250;

// Long enough for a slow rc, short enough that a shell which never says anything
// (rare, but a silent `sh` with an empty prompt exists) still gets the command
// rather than losing it forever.
const FIRST_OUTPUT_TIMEOUT_MS = 3000;

/**
 * Claim `paneId`'s pending resume command for `ptyId`.
 *
 * Returns a one-shot "the shell produced output" hook, or **null** — which is
 * the answer for every pane that wasn't restored, i.e. nearly all of them. The
 * caller wires the returned hook into its pty-output listener only when it isn't
 * null, so a normal pane's output path is exactly what it was before this
 * feature existed. Output is the hottest path in the app — every echoed
 * keystroke and every line of a build log goes through it — and this can only
 * ever matter once, so it has no business being checked there forever.
 *
 * The hook disarms itself after the first call.
 */
export function takePendingRestore(
  paneId: string,
  ptyId: number
): (() => void) | null {
  const mode = sessionRestoreMode();
  if (mode === "off") {
    // Still consume it: leaving the entry behind would deliver the command if
    // the setting were flipped on while this pane sat in a background tab.
    consumePendingRestore(paneId);
    return null;
  }

  const meta = consumePendingRestore(paneId);
  if (!meta) return null;

  let sent = false;
  const send = () => {
    if (sent) return;
    sent = true;
    // "run" submits with a carriage return — the byte a real Enter sends, and
    // the one ConPTY/PowerShell needs (a bare "\n" leaves the line sitting at
    // the prompt on Windows). "type" writes the command and nothing else.
    writePty(ptyId, mode === "run" ? `${meta.resumeCommand}\r` : meta.resumeCommand);
  };

  // A shell that never says anything (a silent `sh` with an empty prompt) would
  // otherwise never get the command.
  window.setTimeout(send, FIRST_OUTPUT_TIMEOUT_MS);

  let armed = true;
  return () => {
    if (!armed) return;
    armed = false;
    window.setTimeout(send, AFTER_PROMPT_DELAY_MS);
  };
}
