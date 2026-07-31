import { createSignal } from "solid-js";
import { getBackend, windowBoot } from "../backends";
import type { UnlistenFn } from "../backends";

// The three facts about *this window's* frame that more than one component now
// needs: whether we draw the minimise/maximise/close buttons ourselves, whether
// the window is maximised, and whether it is fullscreen.
//
// This used to live inside TabBar, which was fine while the tab bar was the only
// thing that drew them. It isn't any more: with the tab bar parked on the bottom
// edge the controls stay at the top, in a strip of their own (see TitleStrip),
// and two components asking the host the same three questions would mean two
// sets of IPC round trips and two subscriptions that can drift apart.
//
// `ownControls` is seeded synchronously from the boot flags rather than awaited.
// It decides whether a whole strip exists, so an awaited answer would lay the
// window out once without it and again a round trip later — a visible jump on
// every launch, on the one path this app spends its effort keeping still.

const [ownControls, setOwnControls] = createSignal(windowBoot().ownControls);
const [isFullscreen, setIsFullscreen] = createSignal(false);
const [isMaximized, setIsMaximized] = createSignal(false);

export { ownControls, isFullscreen, isMaximized };

let started = false;

/**
 * Subscribe to the host's window-state changes. Idempotent, and safe to call
 * from anywhere — only the first call does anything. Returns a teardown for the
 * subscriptions (the app's lifetime is the window's, so nothing calls it today).
 */
export async function initWindowChrome(): Promise<UnlistenFn> {
  if (started) return () => {};
  started = true;

  const backend = await getBackend();
  // Fullscreen and maximised are genuinely unknown until we ask — neither is in
  // the launch flags, and both can be true before the first paint (a window
  // restored maximised, a launch into a fullscreen space).
  setIsFullscreen(await backend.isFullscreen());
  setIsMaximized(await backend.isMaximized());
  // Correct the boot-flag guess if the host disagrees. It can: the flag says
  // what kind of frame this window was *created* with, and a window that
  // outlived a change to the setting keeps the frame it was born with.
  setOwnControls(await backend.drawsOwnWindowControls());

  let unlistenFullscreen: UnlistenFn | undefined;
  let unlistenMaximized: UnlistenFn | undefined;
  try {
    unlistenFullscreen = await backend.onFullscreenChange(setIsFullscreen);
    unlistenMaximized = await backend.onMaximizedChange(setIsMaximized);
  } catch (_) {
    // A backend without those signals — the icons still flip on our own
    // toggles, just not on OS-driven changes.
  }

  return () => {
    unlistenFullscreen?.();
    unlistenMaximized?.();
  };
}

/** Toggle the OS fullscreen state, keeping our mirror of it in step. */
export async function toggleFullscreen(): Promise<void> {
  const backend = await getBackend();
  const next = !(await backend.isFullscreen());
  await backend.setFullscreen(next);
  setIsFullscreen(next);
}

export async function minimizeWindow(): Promise<void> {
  (await getBackend()).minimizeWindow();
}

export async function toggleMaximizeWindow(): Promise<void> {
  setIsMaximized(await (await getBackend()).toggleMaximizeWindow());
}

export async function closeWindow(): Promise<void> {
  (await getBackend()).closeWindow();
}
