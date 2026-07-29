// The session-provider poll.
//
// Providers answer "is there something resumable running in this pane, and how
// would you pick it back up?" — asked periodically, because the moment the
// answer is *needed* (a pane closing, the app quitting) is the moment the
// process is already going away. What's found is recorded on the terminal
// registry instance, where the snapshot code reads it.
//
// The cost is one process-table scan per tick, regardless of how many panes are
// open: the host walks the table once and answers for every pty in the same
// call. Panes that report nothing keep whatever they had — a session you just
// quit is still resumable, and that's precisely when remembering it pays.

import { getBackend } from "../../backends";
import {
  getPanePtyId,
  getTerminalCwd,
  getTerminalInstance,
  livePaneIds,
  setSessionMeta,
} from "../terminal-registry";
import { detect as detectClaude, isRunning as claudeIsRunning } from "./claude";
import { setPaneClaudeRunning, setProbeRequest } from "../claude-attention";
import { sessionRestoreMode, claudeAttentionMode } from "../../stores/settings";

// Slow on purpose. A session id doesn't change while a session runs, so this is
// only ever racing the user closing a pane seconds after starting something —
// and the exact route needs claude to have spawned a child anyway, which is a
// matter of the first tool call, not of poll frequency. Cheap enough to leave
// running, rare enough to never show up in a profile.
const POLL_INTERVAL_MS = 20_000;

let timer: number | null = null;
let running = false;

async function pollOnce() {
  // Overlapping ticks would double the process scan for nothing; a slow host
  // (a big process table, a loaded machine) just skips a beat.
  if (running) return;

  // One scan, two consumers, and each can be switched off independently:
  //
  //  - Resumable sessions want the session *id*, to write into a snapshot.
  //  - The attention heuristic (lib/claude-attention) wants only the live fact
  //    of whether a `claude` process is in the pane at all, to tell a Claude
  //    turn ending from any other command finishing.
  //
  // Either one alone is reason enough to walk the process table; neither means
  // don't walk it. "Off" means don't do the work, not do it and discard.
  const forRestore = sessionRestoreMode() !== "off";
  const forAttention = claudeAttentionMode() === "heuristic";
  if (!forRestore && !forAttention) return;

  // A hidden window is a cheap way out for the restore side: ids are written
  // into a snapshot when a pane closes or the app quits, and neither happens
  // while nobody is looking — anything missed is picked up on the next visible
  // tick, and the quit path re-polls explicitly. The attention side is the
  // exact opposite case, so it doesn't take this exit: a window nobody is
  // looking at is precisely where a waiting pane needs to be noticed, and the
  // flag has to be up before the user comes back to it.
  if (!forAttention && typeof document !== "undefined" && document.hidden) {
    return;
  }

  running = true;
  try {
    const paneIds = livePaneIds();
    if (paneIds.length === 0) return;

    // pty id -> pane id, so the host's answer can be routed back.
    const byPty = new Map<number, string>();
    for (const paneId of paneIds) {
      const ptyId = getPanePtyId(paneId);
      if (ptyId !== null) byPty.set(ptyId, paneId);
    }
    if (byPty.size === 0) return;

    const backend = await getBackend();
    const descendants = await backend.ptyDescendants([...byPty.keys()]);

    await Promise.all(
      [...byPty.entries()].map(async ([ptyId, paneId]) => {
        const procs = descendants[ptyId] ?? [];
        if (forAttention) setPaneClaudeRunning(paneId, claudeIsRunning(procs));
        if (!forRestore) return;
        const known = getTerminalInstance(paneId)?.sessionMeta;
        const found = await detectClaude(procs, getTerminalCwd(paneId), known);
        if (found !== known) setSessionMeta(paneId, found);
      })
    );
  } catch (_) {
    // The host couldn't answer (no process access, backend gone). Panes keep
    // whatever they had; nothing here is worth surfacing to the user.
  } finally {
    running = false;
  }
}

export function startSessionProviders() {
  if (timer !== null) return;
  // Let a pane that starts working like a Claude pane pull the next scan
  // forward, instead of waiting out the interval (see lib/claude-attention).
  setProbeRequest(() => void pollOnce());
  // A first pass shortly after boot catches the sessions that were already
  // running when the app opened, without competing with startup for the CPU.
  timer = window.setTimeout(function tick() {
    void pollOnce();
    timer = window.setTimeout(tick, POLL_INTERVAL_MS);
  }, 2_000);
}

export function stopSessionProviders() {
  setProbeRequest(null);
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

/** Run one pass now — used before capturing a snapshot on the way out. */
export function pollSessionsNow(): Promise<void> {
  return pollOnce();
}
