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
import { detect as detectClaude } from "./claude";
import { sessionRestoreMode } from "../../stores/settings";

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

  // Two cheap ways out before touching the host at all:
  //
  //  - The user turned resumable sessions off, so nothing consumes what this
  //    would find. "Ignore them" means don't do the work, not do it and discard.
  //  - The window isn't visible. Sessions are identified so they can be written
  //    into a snapshot when a pane closes or the app quits, and neither happens
  //    while nobody is looking — a hidden window has no reason to keep walking
  //    process trees. Anything missed is picked up on the next visible tick, and
  //    the quit path re-polls explicitly.
  if (sessionRestoreMode() === "off") return;
  if (typeof document !== "undefined" && document.hidden) return;

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
  // A first pass shortly after boot catches the sessions that were already
  // running when the app opened, without competing with startup for the CPU.
  timer = window.setTimeout(function tick() {
    void pollOnce();
    timer = window.setTimeout(tick, POLL_INTERVAL_MS);
  }, 2_000);
}

export function stopSessionProviders() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

/** Run one pass now — used before capturing a snapshot on the way out. */
export function pollSessionsNow(): Promise<void> {
  return pollOnce();
}
