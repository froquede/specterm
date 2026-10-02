import { createEffect, createMemo, createSignal, For, on, onMount, Show } from "solid-js";
import { IconArrowLeft, IconRefresh, IconReveal, ICON_SIZE, ICON_STROKE } from "../lib/icons";
import { IconBot, IconSend, IconLogIn } from "../lib/icons-lazy";
import { getBackend } from "../backends";
import type { InboxMessage, InboxThreadSummary } from "../backends/types";
import { renderMarkdown } from "../lib/markdown";
import { isMac } from "../lib/platform";
import {
  inboxState,
  inboxLogin,
  pendingThread,
  setPendingThread,
  refreshInbox,
  signInToInbox,
  cancelInboxSignIn,
  openInboxOnWeb,
} from "../stores/inbox";
import "../styles/inbox-panel.css";

// The Sprint Platform's message channel (nf-sprint-planner's /mensagens): the
// thread list, one thread read in full, and a reply box. Opening a thread marks
// it read on the platform, exactly as the web page does — the host re-polls
// right after, so the badge drops with it.

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === now.toDateString()) return time;
  const day = date.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit" });
  return `${day} ${time}`;
}

function openLink(url: string) {
  void getBackend().then((b) => b.openExternal(url));
}

export default function InboxPanel() {
  const [threads, setThreads] = createSignal<InboxThreadSummary[] | null>(null);
  const [threadsError, setThreadsError] = createSignal<string | null>(null);
  const [openThread, setOpenThread] = createSignal<string | null>(null);
  const [messages, setMessages] = createSignal<InboxMessage[] | null>(null);
  const [threadError, setThreadError] = createSignal<string | null>(null);
  // Messages that were unread when the thread was opened: they start expanded
  // and keep their marker, though the platform marks them read on that open.
  const [freshIds, setFreshIds] = createSignal<Set<string>>(new Set());
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [reply, setReply] = createSignal("");
  const [decision, setDecision] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  const [sendError, setSendError] = createSignal<string | null>(null);
  const [signingIn, setSigningIn] = createSignal(false);
  const [signInError, setSignInError] = createSignal<string | null>(null);

  const ready = () => inboxState().status === "ok";
  const signedOut = () => {
    const s = inboxState().status;
    return s === "signed-out" || s === "unauthorized";
  };
  const me = () => inboxState().me?.clickupUserId ?? null;

  async function loadThreads() {
    if (!ready()) return;
    const backend = await getBackend();
    const res = await backend.inboxThreads();
    if (res.ok) {
      setThreads(res.data);
      setThreadsError(null);
    } else {
      setThreadsError(res.error);
    }
  }

  async function loadThread(threadId: string, opts: { reset?: boolean } = {}) {
    if (opts.reset) {
      setMessages(null);
      setThreadError(null);
      setExpanded(new Set<string>());
      const unread = inboxState().items.filter((i) => i.threadId === threadId);
      setFreshIds(new Set(unread.map((i) => i.id)));
    }
    const backend = await getBackend();
    const res = await backend.inboxThread(threadId);
    if (openThread() !== threadId) return; // navigated away meanwhile
    if (!res.ok) {
      setThreadError(res.error);
      return;
    }
    setThreadError(null);
    setMessages(res.data);
  }

  function showThread(threadId: string) {
    setOpenThread(threadId);
    setReply("");
    setDecision(false);
    setSendError(null);
    void loadThread(threadId, { reset: true });
  }

  function backToList() {
    setOpenThread(null);
    setMessages(null);
    void loadThreads();
  }

  // A click on the new-message preview names the thread to land on.
  createEffect(() => {
    const target = pendingThread();
    if (!target || !ready()) return;
    setPendingThread(null);
    showThread(target);
  });

  // Something changed in the unread set (a new message, or one read
  // elsewhere): the list's counts are stale, and an open thread that just got
  // a message should show it — reading it is what marks it read.
  const unreadSignature = createMemo(() =>
    inboxState()
      .items.map((i) => i.id)
      .join(",")
  );
  createEffect(
    on([unreadSignature, ready], ([, isReady]) => {
      if (!isReady) return;
      void loadThreads();
      const current = openThread();
      if (current && inboxState().items.some((i) => i.threadId === current)) {
        const unread = inboxState().items.filter((i) => i.threadId === current);
        setFreshIds((prev) => new Set([...prev, ...unread.map((i) => i.id)]));
        void loadThread(current);
      }
    })
  );

  onMount(() => void refreshInbox());

  const summary = () => threads()?.find((t) => t.threadId === openThread()) ?? null;

  function threadTitle(t: InboxThreadSummary): string {
    const others = t.participantes
      .filter((p) => p.clickupUserId !== me())
      .map((p) => p.name.split(" ")[0])
      .join(", ");
    return [t.taskLabel, others].filter(Boolean).join(" · ") || "Conversation";
  }

  const openTitle = () => {
    const s = summary();
    if (s) return threadTitle(s);
    const msgs = messages();
    return msgs?.[0]?.taskLabel ?? msgs?.[0]?.from.name ?? "Conversation";
  };

  const hasTask = () => {
    const msgs = messages();
    return !!(summary()?.taskId ?? msgs?.find((m) => m.taskId)?.taskId);
  };

  // The last few messages (and anything that arrived unread) open by default;
  // older ones start as their one-line summary. A click flips either way, so
  // `expanded` holds the messages whose state differs from that default.
  const OPEN_BY_DEFAULT = 3;
  const isExpanded = (m: InboxMessage, index: number) => {
    const msgs = messages() ?? [];
    const byDefault = index >= msgs.length - OPEN_BY_DEFAULT || freshIds().has(m.id);
    return byDefault !== expanded().has(m.id);
  };

  // The whole message block toggles — except a click on a link, which goes to
  // the browser, and the end of a drag that selected text to copy.
  function onMessageClick(e: MouseEvent, id: string) {
    const anchor = (e.target as HTMLElement).closest("a");
    if (anchor) {
      e.preventDefault();
      const href = anchor.getAttribute("href");
      if (href && /^https?:/i.test(href)) openLink(href);
      return;
    }
    if (window.getSelection()?.toString()) return;
    toggleExpanded(id);
  }

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function sendReply(e?: Event) {
    e?.preventDefault();
    const body = reply().trim();
    const msgs = messages();
    const last = msgs?.[msgs.length - 1];
    const threadId = openThread();
    if (!body || !last || !threadId || sending()) return;
    setSending(true);
    setSendError(null);
    const backend = await getBackend();
    const res = await backend.inboxSend({
      corpo: body,
      respondeA: last.id,
      decisao: decision() && hasTask(),
    });
    setSending(false);
    if (!res.ok) {
      setSendError(res.error);
      return;
    }
    setReply("");
    setDecision(false);
    void loadThread(threadId);
  }

  async function signIn() {
    setSigningIn(true);
    setSignInError(null);
    const res = await signInToInbox();
    setSigningIn(false);
    if (!res.ok && res.error !== "Cancelled") setSignInError(res.error ?? "Sign-in failed");
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && openThread()) {
      e.stopPropagation();
      backToList();
    }
  }

  return (
    <div class="inbox-panel" role="complementary" aria-label="Inbox" onKeyDown={onKeyDown}>
      <div class="inbox-panel-header">
        <Show
          when={openThread()}
          fallback={<span class="inbox-panel-title">Inbox</span>}
        >
          <button class="inbox-icon-btn" title="Back to conversations" onClick={backToList}>
            <IconArrowLeft size={ICON_SIZE} stroke-width={ICON_STROKE} />
          </button>
          <span class="inbox-panel-title inbox-panel-title-thread">{openTitle()}</span>
        </Show>
        <span class="inbox-panel-actions">
          <button
            class="inbox-icon-btn"
            title="Open in the Sprint Platform"
            onClick={() => void openInboxOnWeb(openThread() ?? undefined)}
          >
            <IconReveal size={ICON_SIZE} stroke-width={ICON_STROKE} />
          </button>
          <button
            class="inbox-icon-btn"
            title="Refresh"
            onClick={() => {
              void refreshInbox();
              const current = openThread();
              if (current) void loadThread(current);
              else void loadThreads();
            }}
          >
            <IconRefresh size={ICON_SIZE} stroke-width={ICON_STROKE} />
          </button>
        </span>
      </div>

      <div class="inbox-panel-scroll">
        <Show when={inboxState().status === "idle"}>
          <div class="inbox-empty">Connecting to the Sprint Platform…</div>
        </Show>

        {/* Not signed in (no token file) or the token was refused. Signing in
            is the device flow /planning-login runs: a code, approved on the
            platform's /cli-auth page in the browser. The platform's ClickUp
            login drops the user on its home page rather than back on that
            page, so a first-time login needs the page opened a second time —
            the waiting state says so and offers the link. */}
        <Show when={signedOut()}>
          <div class="inbox-signin">
            <Show
              when={inboxLogin()?.phase === "waiting"}
              fallback={
                <>
                  <p class="inbox-signin-title">
                    {inboxState().status === "unauthorized"
                      ? "Your Sprint Platform session has expired"
                      : "Connect to the Sprint Platform"}
                  </p>
                  <p>
                    Sign in to read and answer your team's messages here, and get
                    a heads-up in the tab bar when a new one arrives.
                  </p>
                  <button
                    class="inbox-primary-btn"
                    disabled={signingIn()}
                    onClick={() => void signIn()}
                  >
                    <IconLogIn size={ICON_SIZE} stroke-width={ICON_STROKE} />
                    Sign in with the browser
                  </button>
                  <Show when={signInError()}>
                    <p class="inbox-error">{signInError()}</p>
                  </Show>
                  <p class="inbox-hint">
                    Same login as <code>/planning-login</code>: signing in here
                    signs in the Claude skills too, and the other way round.
                  </p>
                </>
              }
            >
              <p class="inbox-signin-title">Finish signing in in your browser</p>
              <ol class="inbox-signin-steps">
                <li>If the platform asks, log in with ClickUp.</li>
                <li>
                  Check that the page shows this code, then click{" "}
                  <strong>Autorizar</strong>:
                  <span class="inbox-code">{inboxLogin()?.userCode}</span>
                </li>
              </ol>
              <p class="inbox-hint">
                Landed on the platform's home page after logging in? Open the
                approval page again.
              </p>
              <span class="inbox-row-actions">
                <button
                  class="inbox-primary-btn"
                  onClick={() => openLink(inboxLogin()?.url ?? "")}
                >
                  <IconReveal size={ICON_SIZE} stroke-width={ICON_STROKE} />
                  Open approval page
                </button>
                <button class="inbox-link-btn" onClick={() => void cancelInboxSignIn()}>
                  Cancel
                </button>
              </span>
              <p class="inbox-hint inbox-waiting">Waiting for approval…</p>
            </Show>
          </div>
        </Show>

        <Show when={inboxState().status === "error"}>
          <div class="inbox-empty">
            <p>Can't reach the Sprint Platform.</p>
            <p class="inbox-hint">{inboxState().error}</p>
            <button class="inbox-link-btn" onClick={() => void refreshInbox()}>
              Try again
            </button>
          </div>
        </Show>

        <Show when={ready() && !openThread()}>
          <Show when={threadsError()}>
            <p class="inbox-error">{threadsError()}</p>
          </Show>
          <Show
            when={threads()}
            fallback={<div class="inbox-empty">Loading conversations…</div>}
          >
            {(list) => (
              <Show
                when={list().length > 0}
                fallback={<div class="inbox-empty">No conversations yet.</div>}
              >
                <ul class="inbox-threads">
                  <For each={list()}>
                    {(t) => (
                      <li>
                        <button
                          class="inbox-thread"
                          classList={{ unread: t.naoLidas > 0 }}
                          onClick={() => showThread(t.threadId)}
                        >
                          <span class="inbox-thread-head">
                            <span class="inbox-thread-title">{threadTitle(t)}</span>
                            <span class="inbox-thread-time">{formatTime(t.ultima.createdAt)}</span>
                          </span>
                          <span class="inbox-thread-sub">
                            <span class="inbox-thread-preview">
                              <span class="inbox-thread-author">{t.ultima.fromName}:</span>{" "}
                              {t.ultima.resumo}
                            </span>
                            <Show when={t.naoLidas > 0}>
                              <span class="inbox-pill">{t.naoLidas}</span>
                            </Show>
                          </span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            )}
          </Show>
        </Show>

        <Show when={ready() && openThread()}>
          <Show when={threadError()}>
            <p class="inbox-error">{threadError()}</p>
          </Show>
          <Show
            when={messages()}
            fallback={
              <Show when={!threadError()}>
                <div class="inbox-empty">Loading…</div>
              </Show>
            }
          >
            {(msgs) => (
              <ol class="inbox-messages">
                <For each={msgs()}>
                  {(m, index) => (
                    <li
                      class="inbox-message"
                      classList={{
                        mine: m.from.clickupUserId === me(),
                        fresh: freshIds().has(m.id),
                        collapsed: !isExpanded(m, index()),
                      }}
                      role="button"
                      tabIndex={0}
                      aria-expanded={isExpanded(m, index())}
                      onClick={(e) => onMessageClick(e, m.id)}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggleExpanded(m.id);
                        }
                      }}
                    >
                      <div class="inbox-message-head">
                        <span class="inbox-message-from">{m.from.name}</span>
                        <Show when={m.from.via === "agent"}>
                          <span class="inbox-message-agent" title="Sent by an agent">
                            <IconBot size={13} stroke-width={ICON_STROKE} />
                          </span>
                        </Show>
                        <Show when={m.decisao}>
                          <span class="inbox-tag">Decision</span>
                        </Show>
                        <Show when={freshIds().has(m.id)}>
                          <span class="inbox-tag inbox-tag-new">New</span>
                        </Show>
                        <span class="inbox-message-time">{formatTime(m.createdAt)}</span>
                      </div>
                      <Show
                        when={isExpanded(m, index())}
                        fallback={<div class="inbox-message-resumo">{m.resumo}</div>}
                      >
                        <div
                          class="inbox-message-body"
                          // markdown-it runs with html: false, so the message
                          // can't smuggle markup of its own in here.
                          innerHTML={renderMarkdown(m.corpo)}
                        />
                      </Show>
                    </li>
                  )}
                </For>
              </ol>
            )}
          </Show>
        </Show>
      </div>

      <Show when={ready() && openThread() && messages()}>
        <form class="inbox-reply" onSubmit={sendReply}>
          <textarea
            class="inbox-reply-input"
            placeholder="Reply… (first line is the summary)"
            rows={3}
            value={reply()}
            onInput={(e) => setReply(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void sendReply(e);
            }}
          />
          <Show when={sendError()}>
            <p class="inbox-error">{sendError()}</p>
          </Show>
          <div class="inbox-reply-bar">
            <Show when={hasTask()}>
              <label class="inbox-decision" title="Also posts the full text as a comment on the task">
                <input
                  type="checkbox"
                  checked={decision()}
                  onChange={(e) => setDecision(e.currentTarget.checked)}
                />
                Decision
              </label>
            </Show>
            <button
              type="submit"
              class="inbox-primary-btn"
              disabled={sending() || !reply().trim()}
              title={`Send (${isMac ? "⌘" : "Ctrl+"}Enter)`}
            >
              <IconSend size={ICON_SIZE} stroke-width={ICON_STROKE} />
              {sending() ? "Sending…" : "Send"}
            </button>
          </div>
        </form>
      </Show>
    </div>
  );
}
