// The inbox: the team's message channel from the Sprint Platform
// (nf-sprint-planner's /mensagens), surfaced in the tab bar.
//
// It lives in the main process for two reasons. The platform's API only allows
// its own web origin through CORS, so a renderer fetch would be refused; and the
// poll belongs to the app, not to a window — three windows open must not mean
// three pollers, nor three toasts that disagree about what is new. One poller
// here, every window hears every change (the same shape as the updater).
//
// Authentication is the token `/planning-login` already writes for the Claude
// skills, ~/.config/sprint-platform/token: a 30-day JWT sent as a Bearer header.
// The API slides it forward by answering with a fresh one in `X-Sprint-Token`
// once it is a day old, and whoever holds it is expected to write that back —
// so this file keeps the token alive for the skills too. Signing in from the
// panel runs the same device flow the skill does and writes the same file.
//
// The platform has no push channel; its own web page polls every 30 s, and so
// does this. "New" means an unread message id this process hasn't seen before.
// The first answer after launch (or after signing in) only seeds that set: the
// backlog is what the badge is for, and a launch shouldn't replay it as toasts.

const path = require("path");
const os = require("os");
const fs = require("fs");

// The tests shorten it; nothing else should.
const POLL_MS = Number(process.env.SPECTERM_INBOX_POLL_MS) || 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
const LOGIN_POLL_MS = 2_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
// The REST inbox returns at most this many unread items; past it the count has
// to come from the dedicated endpoint.
const INBOX_PAGE = 50;

function baseUrl() {
  const raw = process.env.NEXFAR_PLANNING_URL || "https://planning.nxf.link";
  return raw.replace(/\/+$/, "");
}

function tokenDir() {
  return path.join(os.homedir(), ".config", "sprint-platform");
}

function tokenPath() {
  return path.join(tokenDir(), "token");
}

function readToken() {
  try {
    const token = fs.readFileSync(tokenPath(), "utf-8").trim();
    return token || null;
  } catch (_) {
    return null;
  }
}

// Written through a temp file and a rename, so the skills reading the same file
// never see it half-written. Mode 600 in a 700 directory, as the skill does.
function writeToken(token) {
  const dir = tokenDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.token-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, token, { mode: 0o600 });
  fs.renameSync(tmp, tokenPath());
}

// Who the token belongs to — needed to tell "my" messages from everyone
// else's. Read off the payload without verifying it: the server is the one that
// verifies, this only labels rows.
function tokenIdentity(token) {
  try {
    const payload = token.split(".")[1];
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
    if (!json || typeof json.clickupUserId !== "string") return null;
    return {
      clickupUserId: json.clickupUserId,
      name: typeof json.name === "string" ? json.name : "",
    };
  } catch (_) {
    return null;
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function registerInbox({ ipcMain, shell, openWindows }) {
  // status: "idle" (nobody asked yet), "signed-out" (no token file),
  // "unauthorized" (token rejected), "error" (network/server), "ok".
  let state = {
    status: "idle",
    unread: 0,
    items: [],
    me: null,
    baseUrl: baseUrl(),
    error: null,
    checkedAt: null,
  };
  let seen = null; // Set of unread ids already reported; null until seeded.
  let timer = null;
  let inFlight = null;
  let login = null; // { deviceCode, userCode, url, cancelled }

  function broadcast(payload) {
    for (const win of openWindows()) win.webContents.send("inbox:event", payload);
  }

  function setState(patch) {
    state = { ...state, ...patch };
    broadcast({ type: "state", state });
  }

  async function request(method, urlPath, body, token = readToken()) {
    if (!token) throw new HttpError(401, "Not signed in");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${baseUrl()}${urlPath}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      throw new HttpError(0, err?.name === "AbortError" ? "Timed out" : "Can't reach the Sprint Platform");
    } finally {
      clearTimeout(timeout);
    }

    const renewed = res.headers.get("x-sprint-token");
    if (renewed && renewed !== token) {
      try {
        writeToken(renewed.trim());
      } catch (err) {
        console.warn("[inbox] couldn't save the renewed token:", err?.message);
      }
    }

    let json = null;
    try {
      json = await res.json();
    } catch (_) {
      /* empty or non-JSON body; the status says enough */
    }
    if (!res.ok) {
      const message = json?.error?.message || `HTTP ${res.status}`;
      throw new HttpError(res.status, message);
    }
    return json;
  }

  async function pollOnce() {
    const token = readToken();
    if (!token) {
      seen = null;
      setState({ status: "signed-out", unread: 0, items: [], me: null, error: null });
      return;
    }
    const me = tokenIdentity(token);
    try {
      const inbox = await request("GET", "/api/messages/inbox", undefined, token);
      const items = Array.isArray(inbox?.itens) ? inbox.itens : [];
      let unread = items.length;
      if (items.length >= INBOX_PAGE) {
        const count = await request("GET", "/api/messages/unread-count", undefined, token);
        if (typeof count?.naoLidas === "number") unread = count.naoLidas;
      }

      const fresh = seen ? items.filter((item) => !seen.has(item.id)) : [];
      seen = new Set(items.map((item) => item.id));

      setState({
        status: "ok",
        unread,
        items,
        me,
        error: null,
        checkedAt: new Date().toISOString(),
      });
      if (fresh.length > 0) broadcast({ type: "new", items: fresh });
    } catch (err) {
      if (err.status === 401) {
        seen = null;
        setState({ status: "unauthorized", unread: 0, items: [], me, error: err.message });
      } else {
        // Keep the last good count on screen: a dropped request is not news.
        setState({ status: state.status === "ok" ? "ok" : "error", error: err.message });
      }
    }
  }

  // Coalesces overlapping triggers (the timer, a panel opening, a thread being
  // read) into the one request already on the wire.
  function poll() {
    if (!inFlight) {
      inFlight = pollOnce().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  function ensurePolling() {
    if (timer) return;
    timer = setInterval(() => void poll(), POLL_MS);
    void poll();
  }

  async function call(fn) {
    try {
      return { ok: true, data: await fn() };
    } catch (err) {
      if (err.status === 401) void poll();
      return { ok: false, status: err.status ?? 0, error: err.message || String(err) };
    }
  }

  ipcMain.handle("inbox:state", () => {
    ensurePolling();
    return state;
  });

  ipcMain.handle("inbox:refresh", async () => {
    ensurePolling();
    await poll();
    return state;
  });

  ipcMain.handle("inbox:threads", () =>
    call(async () => (await request("GET", "/api/messages/threads"))?.threads ?? [])
  );

  // Reading a thread marks every message in it read (server-side), so the
  // count is re-polled right after rather than waiting out the timer.
  ipcMain.handle("inbox:thread", (_event, threadId) =>
    call(async () => {
      const id = String(threadId ?? "");
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new HttpError(400, "Invalid thread");
      const res = await request("GET", `/api/messages/threads/${id}`);
      void poll();
      return res?.mensagens ?? [];
    })
  );

  ipcMain.handle("inbox:send", (_event, payload) =>
    call(async () => {
      const body = {
        corpo: String(payload?.corpo ?? ""),
        ...(payload?.respondeA ? { respondeA: String(payload.respondeA) } : {}),
        ...(payload?.decisao ? { decisao: true } : {}),
      };
      const res = await request("POST", "/api/messages", body);
      void poll();
      return res;
    })
  );

  ipcMain.handle("inbox:open-web", (_event, threadId) => {
    const id = typeof threadId === "string" && /^[a-zA-Z0-9_-]+$/.test(threadId) ? threadId : null;
    const url = `${baseUrl()}/mensagens${id ? `?t=${encodeURIComponent(id)}` : ""}`;
    return shell.openExternal(url);
  });

  // Device flow, the same one /planning-login runs: ask for a code, send the
  // user to approve it in the browser, poll until it's approved. Resolves once
  // the token is on disk (or the attempt ends); progress goes out as events so
  // every window's panel can show the code.
  ipcMain.handle("inbox:login", async () => {
    if (login) return { ok: false, error: "Sign-in already in progress" };
    let start;
    try {
      const res = await fetch(`${baseUrl()}/api/auth/cli/start`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      start = await res.json();
    } catch (err) {
      return { ok: false, error: `Couldn't start sign-in (${err.message})` };
    }
    // The API's own verifyUrl is built from an internal port; the public page
    // is the one the browser can reach.
    const url = `${baseUrl()}/cli-auth?code=${encodeURIComponent(start.userCode)}`;
    const attempt = { deviceCode: start.deviceCode, userCode: start.userCode, url, cancelled: false };
    login = attempt;
    broadcast({ type: "login", phase: "waiting", userCode: start.userCode, url });
    void shell.openExternal(url);

    const deadline = Date.now() + Math.min(LOGIN_TIMEOUT_MS, (start.expiresIn ?? 600) * 1000);
    try {
      while (!attempt.cancelled && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, LOGIN_POLL_MS));
        if (attempt.cancelled) break;
        let body;
        try {
          const res = await fetch(
            `${baseUrl()}/api/auth/cli/poll?deviceCode=${encodeURIComponent(attempt.deviceCode)}`
          );
          body = await res.json();
        } catch (_) {
          continue; // a dropped poll; try again on the next tick
        }
        if (body?.status === "approved" && typeof body.token === "string") {
          writeToken(body.token.trim());
          seen = null;
          broadcast({ type: "login", phase: "done" });
          ensurePolling();
          await poll();
          return { ok: true };
        }
        if (body?.status === "expired") break;
      }
      broadcast({ type: "login", phase: attempt.cancelled ? "cancelled" : "expired" });
      return { ok: false, error: attempt.cancelled ? "Cancelled" : "The code expired" };
    } finally {
      if (login === attempt) login = null;
    }
  });

  ipcMain.handle("inbox:login-cancel", () => {
    if (login) login.cancelled = true;
  });
}

module.exports = { registerInbox };
