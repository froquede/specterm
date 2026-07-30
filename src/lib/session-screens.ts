// The screen half of session restore.
//
// The layout snapshot (stores/history.ts) records what was open — tabs, splits,
// working directories, names. This records what was *on* it: each terminal's
// screen and scrollback, serialized as the escape sequences that reproduce it.
// Together they're the difference between reopening the same panes and finding
// the session as it was left, which is the thing a tmux user means by "restore".
//
// **Where this lives, and why not with the layout.** The layout stays in
// localStorage because it must be read *synchronously* at boot, before anything
// renders and therefore before the first shell spawns — the same reason the window
// kind is stamped into launch arguments instead of asked for over IPC. It is two
// kilobytes; that read is free.
//
// The screens are megabytes, and localStorage was the wrong home for them:
//
//   - It is synchronous, on the thread that draws the terminal. The read sat in
//     front of the first paint of every restored launch.
//   - Its quota is ~5MB for the whole origin, shared with settings, themes,
//     favourites, the closed-tab stack and markdown drafts — so screens could
//     never have a real budget, and the code had to cap them hard and shed
//     entries when a write was rejected.
//   - It bills UTF-16 code units, so a "2MB" string could cost 4MB of that shared
//     quota. A cap counted in characters was quietly wrong.
//
// So they go to a file, written by the main process (see the block in
// electron/main.cjs). That fixes all three: the write is off this thread, there is
// no shared quota, and bytes are bytes. It also means the read can be *lazy*, which
// is better than what it replaced rather than a compromise: nothing reads the file
// until a pane has mounted and asks for its own screen, so the read happens behind
// the first paint instead of in front of it. See screenFor below — that ordering was
// worth ~100ms of startup on a restored 8-tab session, measured.
//
// Capture is still synchronous and still happens at exactly one moment — the
// window going away — because that moment is `beforeunload`, where nothing
// asynchronous is guaranteed to finish. The cost of that is a hard kill losing the
// screens; the layout survives on its own debounce.

import type { SnapshotPane } from "../types";
import { getBackend } from "../backends";
import { serializeTerminalSync } from "./terminal-registry";

// Superseded by the file the main process now owns. Read once on the next launch
// after an upgrade, purely so an old blob doesn't sit in a 5MB quota forever.
const LEGACY_STORAGE_KEY = "specterm.session.screens";

// Ceilings, now that the storage isn't fighting us. The renderer's own
// serialization is already bounded by xterm's scrollback (1000 rows per pane), so
// in practice these are never reached — they exist so a pathological buffer can't
// spend unbounded time being serialized or fill someone's disk.
const MAX_PANE_CHARS = 2_000_000;
const MAX_TOTAL_CHARS = 24_000_000;

// Scrollback depths tried, in order, until one fits under MAX_PANE_CHARS. The
// first is xterm's whole buffer; the last is 0, which still serializes the
// viewport — the screen you were actually looking at, which is the part worth
// keeping if only part can be.
const SCROLLBACK_STEPS = [1000, 250, 60, 0];

export type ScreenStore = Record<string, string>;

// --- Capture ---------------------------------------------------------------

// Serialize one pane at the deepest scrollback that fits the per-pane budget.
// Returns "" when even the bare viewport is over it, which just means that pane
// restores empty.
function serializeCapped(paneId: string): string {
  for (const scrollback of SCROLLBACK_STEPS) {
    const text = serializeTerminalSync(paneId, scrollback);
    if (!text) return "";
    if (text.length <= MAX_PANE_CHARS) return text;
  }
  return "";
}

/**
 * Serialize the screens of `paneIds`, in order, until the total budget runs out.
 *
 * Order is the caller's priority, not the tree's: stores/tabs.ts passes the active
 * tab's panes first, so if the budget ever were reached it's the panes the user
 * was looking at that survive.
 */
export function captureScreens(paneIds: string[]): ScreenStore {
  const screens: ScreenStore = {};
  let total = 0;
  for (const paneId of paneIds) {
    if (total >= MAX_TOTAL_CHARS) break;
    let text: string;
    try {
      text = serializeCapped(paneId);
    } catch (_) {
      // A pane torn down mid-capture (the window is closing around us) — skip it
      // rather than lose every screen after it in the list.
      continue;
    }
    if (!text || total + text.length > MAX_TOTAL_CHARS) continue;
    screens[paneId] = text;
    total += text.length;
  }
  return screens;
}

// --- Persistence -----------------------------------------------------------

/**
 * Hand the screens to the host to write.
 *
 * Fire-and-forget, and it has to be: the one caller runs as the window is being
 * torn down, where an awaited round trip has no guarantee of completing. The host
 * outlives the window and finishes the write on its own (and writes to a temp file
 * then renames, so a crash mid-write leaves the previous screens intact rather
 * than a truncated file).
 */
export function saveScreens(screens: ScreenStore) {
  void getBackend()
    .then((backend) => backend.writeScreens(screens))
    .catch(() => {
      /* No host-side screen storage (Tauri) — the layout still restores. */
    });
  // An upgrade from the version that kept screens in localStorage leaves a blob
  // that will never be read again, in a quota shared with settings and themes.
  clearLegacyScreens();
}

// The read, done once and shared. Deliberately *lazy*: it is not started at boot,
// it is started by the first pane that actually asks for its screen — which happens
// inside attachTerminal, after the terminal has been opened and its canvas exists,
// and after the shell has been spawned.
//
// That ordering is the whole point, and it was measured. Firing the read during
// hydration instead cost ~100ms of first paint on a restored 8-tab session: a
// couple of megabytes crossing IPC and being deserialized on the renderer's main
// thread, competing with the very frame the user is waiting for. Nothing needs it
// that early — each pane's replay is gated behind its own live output, so it can
// arrive late without anything landing out of order.
let pending: Promise<ScreenStore> | null = null;

function readFromHost(): Promise<ScreenStore> {
  return getBackend()
    .then((backend) => backend.readScreens())
    .then((source) =>
      source && typeof source === "object" ? (source as ScreenStore) : {}
    )
    .catch(() => ({}));
}

/**
 * One pane's saved screen, or "" when it has none.
 *
 * Validated here, on the one value being asked for, rather than by copying the
 * whole map up front — that copy was another couple of megabytes of string
 * allocation on the boot path, spent mostly on panes in background tabs that never
 * mount and never ask. Everything is untrusted: this round-tripped through a file
 * that may have been written by an older version or edited by hand, and it is about
 * to be written straight into a terminal.
 */
export function screenFor(key: string): Promise<string> {
  pending ??= readFromHost();
  return pending.then((map) => {
    const value = map[key];
    return typeof value === "string" && value.length <= MAX_PANE_CHARS ? value : "";
  });
}

export function clearScreens() {
  pending = null;
  void getBackend()
    .then((backend) => backend.writeScreens(null))
    .catch(() => {
      /* nothing to clear */
    });
  clearLegacyScreens();
}

function clearLegacyScreens() {
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch (_) {
    // Storage unavailable — a stale blob is harmless, nothing reads that key.
  }
}

/** The key naming a snapshot pane's screen, or "" when it has none. */
export function screenKeyOf(pane: SnapshotPane): string {
  return pane.kind === "terminal" ? (pane.screenKey ?? "") : "";
}

/**
 * A thunk that resolves this key's screen, or undefined when there is no key.
 *
 * A thunk rather than a promise so that *nothing* is read until a pane mounts and
 * calls it. Handing out a promise would start the read at hydration time, which is
 * exactly the cost this indirection exists to avoid.
 */
export function screenThunk(key: string): (() => Promise<string>) | undefined {
  return key ? () => screenFor(key) : undefined;
}
