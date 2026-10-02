import { createSignal } from "solid-js";
import { getBackend } from "../backends";
import type { InboxEvent, InboxItem, InboxState } from "../backends/types";

// The Sprint Platform inbox, as this window sees it. The host polls and decides
// what is new (electron/inbox.cjs); this store keeps the latest answer and the
// one piece of per-window state the tab bar needs: the preview toast. It lives
// outside the panel because the badge and the toast exist while the panel is
// closed — that is the whole point of them.

const IDLE: InboxState = {
  status: "idle",
  unread: 0,
  items: [],
  me: null,
  baseUrl: "",
  error: null,
  checkedAt: null,
};

// How long a new message's preview stays under the icon.
export const TOAST_MS = 5000;

export interface InboxToast {
  item: InboxItem;
  // How many other messages arrived in the same poll.
  more: number;
}

export interface InboxLogin {
  phase: "waiting" | "done" | "expired" | "cancelled";
  userCode?: string;
  url?: string;
}

const [inboxState, setInboxState] = createSignal<InboxState>(IDLE);
const [inboxToast, setInboxToast] = createSignal<InboxToast | null>(null);
const [inboxLogin, setInboxLogin] = createSignal<InboxLogin | null>(null);
// The thread the panel should show next time it renders — set by a click on
// the toast, consumed by the panel.
const [pendingThread, setPendingThread] = createSignal<string | null>(null);

export { inboxState, inboxToast, inboxLogin, pendingThread, setPendingThread };

let subscription: Promise<void> | null = null;
let toastTimer: number | undefined;
let toastRemaining = TOAST_MS;
let toastStartedAt = 0;

function startToastTimer(ms: number) {
  window.clearTimeout(toastTimer);
  toastRemaining = ms;
  toastStartedAt = Date.now();
  toastTimer = window.setTimeout(() => setInboxToast(null), ms);
}

function showToast(items: InboxItem[]) {
  if (items.length === 0) return;
  // The newest one gets the preview; the rest are a count beside it.
  const newest = items.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
  setInboxToast({ item: newest, more: items.length - 1 });
  startToastTimer(TOAST_MS);
}

/** Hold the preview on screen while the pointer is over it. */
export function pauseInboxToast() {
  if (!inboxToast()) return;
  window.clearTimeout(toastTimer);
  toastRemaining = Math.max(0, toastRemaining - (Date.now() - toastStartedAt));
}

/** Let it run out again once the pointer leaves, with a little grace. */
export function resumeInboxToast() {
  if (!inboxToast()) return;
  startToastTimer(Math.max(toastRemaining, 1500));
}

export function dismissInboxToast() {
  window.clearTimeout(toastTimer);
  setInboxToast(null);
}

function applyEvent(event: InboxEvent) {
  if (event.type === "state") setInboxState(event.state);
  else if (event.type === "new") showToast(event.items);
  else if (event.type === "login") setInboxLogin(event.phase === "done" ? null : event);
}

/** Subscribe this window to the host's inbox poller (which it also starts). */
export function initInbox() {
  subscription ??= (async () => {
    const backend = await getBackend();
    await backend.onInboxEvent(applyEvent);
    setInboxState(await backend.inboxState());
  })();
  return subscription;
}

export async function refreshInbox() {
  const backend = await getBackend();
  setInboxState(await backend.inboxRefresh());
}

export async function signInToInbox() {
  const backend = await getBackend();
  const result = await backend.inboxLogin();
  if (!result.ok && result.error) setInboxLogin((prev) => prev ?? { phase: "expired" });
  return result;
}

export async function cancelInboxSignIn() {
  const backend = await getBackend();
  await backend.inboxLoginCancel();
}

export async function openInboxOnWeb(threadId?: string) {
  const backend = await getBackend();
  await backend.inboxOpenWeb(threadId);
}
