// Noticing, without being told, that Claude Code has stopped and is waiting.
//
// The exact answer comes from Claude itself (lib/claude-hooks.ts installs hooks
// that write an OSC into the pane). This file is the path that needs no setup,
// and it works from the one thing a terminal emulator always has: the shape of
// the output stream.
//
// A Claude Code session that is working is never silent. It repaints a spinner
// and a running token/elapsed counter continuously — several writes a second,
// for as long as it is thinking, streaming an answer, or running a tool. The
// two states where it wants you are both perfectly quiet: the turn ended, or a
// permission prompt is up and nothing moves until you answer. So:
//
//     sustained output  →  silence  =  it is waiting on you
//
// That is deliberately read off the *stream*, never off the screen. Matching
// Claude's footer text ("esc to interrupt" and friends) would be sharper and
// would also break on the next release that rewords it; this doesn't know or
// care what version is running.
//
// The cost of not reading the screen is that a long `npm run build` finishing
// in the same pane looks identical. Two things keep that rare: the pane must be
// one where a `claude` process was actually seen running (the session provider
// already scans for it, so this is free), and the busy period must have lasted
// long enough that a short command can't qualify.

import type { PaneId } from "../types";
import { markAttention, clearAttention } from "../stores/attention";
import { claudeAttentionMode } from "../stores/settings";

// Output closer together than this is one continuous burst. Comfortably longer
// than a spinner frame (Claude repaints every ~100-200ms) and shorter than any
// pause that would read as "it stopped".
const BURST_GAP_MS = 700;

// How long a burst has to last before it counts as "something was working
// here". A prompt redraw, a `cd`, a one-line command's output are all well
// under this; a Claude turn is always well over it.
const BUSY_MIN_MS = 1500;

// Silence after a busy burst before the pane is called waiting. Longer than the
// gap between two spinner frames by a wide margin, so a momentary stall inside
// a turn doesn't read as the end of one.
const QUIET_MS = 1200;

interface Watch {
  // When the current uninterrupted run of output started.
  burstStartedAt: number;
  lastOutputAt: number;
  // Has the current burst lasted BUSY_MIN_MS? Only a busy pane can go on to be
  // a waiting one — silence that was never preceded by work is just a prompt
  // sitting there.
  busy: boolean;
  quietTimer: number | null;
  // Was a `claude` process seen in this pane by the last provider poll? Kept
  // here rather than read on demand because the poll is the only thing that
  // knows, and it already has the answer (see lib/session-providers).
  claudeRunning: boolean;
}

const watches = new Map<PaneId, Watch>();

// Asking the session poll to look now, because a pane we don't know as a Claude
// pane just started working like one.
//
// The poll runs every 20s, which is plenty for what it was built for (a session
// id doesn't change) but leaves a gap here: a session started just after a tick
// would be invisible for its whole first turn — often the longest wait, and the
// one most worth flagging. Rather than run the process scan four times as often
// for every user forever, the burst itself asks for a look.
//
// Registered by lib/session-providers rather than imported from it, so the
// dependency stays one-way: the poll knows about this file, this file doesn't
// know about the poll.
let requestProbe: (() => void) | null = null;

// The scan is cheap but not free, and a pane that genuinely isn't Claude (a
// build, a log tail) would otherwise ask on every burst. One ask per window,
// shared across panes.
const PROBE_THROTTLE_MS = 3000;
let lastProbeAt = 0;

export function setProbeRequest(fn: (() => void) | null) {
  requestProbe = fn;
}

function probeIfUnknown(watch: Watch) {
  if (watch.claudeRunning || !requestProbe) return;
  const now = Date.now();
  if (now - lastProbeAt < PROBE_THROTTLE_MS) return;
  lastProbeAt = now;
  requestProbe();
}

function watchFor(paneId: PaneId): Watch {
  let watch = watches.get(paneId);
  if (!watch) {
    watch = {
      burstStartedAt: 0,
      lastOutputAt: 0,
      busy: false,
      quietTimer: null,
      claudeRunning: false,
    };
    watches.set(paneId, watch);
  }
  return watch;
}

function cancelQuietTimer(watch: Watch) {
  if (watch.quietTimer !== null) {
    clearTimeout(watch.quietTimer);
    watch.quietTimer = null;
  }
}

/**
 * Record that a `claude` process was (or wasn't) running in this pane.
 *
 * Called from the session-provider poll, which walks the process table for
 * other reasons anyway. Losing the process resets the burst state too: whatever
 * runs in the pane next starts from a clean slate rather than inheriting a
 * half-finished Claude turn.
 */
export function setPaneClaudeRunning(paneId: PaneId, running: boolean) {
  const watch = watchFor(paneId);
  if (watch.claudeRunning === running) return;
  watch.claudeRunning = running;
  if (!running) {
    cancelQuietTimer(watch);
    watch.busy = false;
  }
}

/** Called for every chunk of output a pane's shell produces. */
export function noteOutput(paneId: PaneId) {
  if (claudeAttentionMode() !== "heuristic") return;

  const watch = watchFor(paneId);
  const now = Date.now();

  // A long enough gap since the last write ends the previous burst and starts a
  // new one, so "how long has this been working" measures the current run of
  // activity rather than the whole time the pane has existed.
  if (now - watch.lastOutputAt > BURST_GAP_MS) {
    watch.burstStartedAt = now;
    watch.busy = false;
  }
  watch.lastOutputAt = now;

  if (!watch.busy && now - watch.burstStartedAt >= BUSY_MIN_MS) {
    watch.busy = true;
    // Something is working in here. If we don't already know this as a Claude
    // pane, this is the moment to find out — the quiet that would flag it is
    // still at least a second away.
    probeIfUnknown(watch);
    // It's producing output again, so whatever it was waiting for it isn't
    // waiting for now — a permission that was answered from the keyboard, or a
    // turn the user replied to. Drop a stale flag rather than leave the pane
    // marked while it visibly works.
    clearAttention(paneId);
  }

  cancelQuietTimer(watch);
  watch.quietTimer = window.setTimeout(() => {
    watch.quietTimer = null;
    if (!watch.busy || !watch.claudeRunning) return;
    // One flag per busy period: without this, a pane left alone would re-mark
    // every time the timer was re-armed by a stray write.
    watch.busy = false;
    markAttention(paneId, "idle");
  }, QUIET_MS);
}

/**
 * The user typed into this pane, which is the answer the pane was waiting for.
 * Clears the flag straight away instead of waiting for the pane to be focused —
 * you can type into a split without it becoming the active one.
 */
export function noteInput(paneId: PaneId) {
  clearAttention(paneId);
  const watch = watches.get(paneId);
  if (watch) watch.busy = false;
}

/** Drop a closed pane's state so the map doesn't outlive its panes. */
export function forgetPane(paneId: PaneId) {
  const watch = watches.get(paneId);
  if (!watch) return;
  cancelQuietTimer(watch);
  watches.delete(paneId);
}
