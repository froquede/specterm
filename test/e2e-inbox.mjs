// Inbox — end to end, against the real app and a stand-in Sprint Platform.
//
// The platform is a local HTTP server speaking the same /api/messages routes
// (see electron/inbox.cjs), pointed at through NEXFAR_PLANNING_URL, with a
// sandboxed HOME holding the token file /planning-login would have written.
// The poll is shortened so a "new" message shows up in seconds, not 30.
//
// Run: node test/e2e-inbox.mjs   (after `vite build`)
import { _electron as electron } from "playwright";
import { launchOptions } from "./launch.mjs";
import { fileURLToPath } from "node:url";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const MAC = process.platform === "darwin";

const INBOX_KEY = MAC ? "Meta+Shift+Backquote" : "Control+Shift+Backquote";

const started = Date.now();
const elapsed = () => ((Date.now() - started) / 1000).toFixed(1).padStart(6);
const log = (...a) => console.log(`[inbox ${elapsed()}s]`, ...a);

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, skipped: false });
  log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const HARD_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 120000);
const hard =
  HARD_TIMEOUT_MS > 0 &&
  setTimeout(() => {
    console.error("[inbox] HARD TIMEOUT");
    process.exit(2);
  }, HARD_TIMEOUT_MS);
if (hard) hard.unref();

async function until(what, predicate, { timeout = 10000, poll = 50 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let ok = false;
    try {
      ok = await predicate();
    } catch (_) {
      ok = false;
    }
    if (ok) return true;
    if (Date.now() > deadline) {
      log(`timed out after ${timeout}ms waiting for: ${what}`);
      return false;
    }
    await new Promise((r) => setTimeout(r, poll));
  }
}

// --- the stand-in platform -------------------------------------------------

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload) => `${b64({ alg: "HS256" })}.${b64(payload)}.sig`;
const ME = { clickupUserId: "100", name: "Test User" };
const ANA = { clickupUserId: "200", name: "Ana Souza" };
const TOKEN = jwt({ ...ME, purpose: "mcp" });
const RENEWED = jwt({ ...ME, purpose: "mcp", renewed: true });

const messages = [];
const read = new Set();
const posted = [];
let renewOnce = false;

function addMessage({ id, threadId, from, resumo, corpo, taskLabel = null }) {
  messages.push({
    id,
    threadId,
    from: { ...from, via: "human" },
    taskId: taskLabel ? "abc123" : null,
    taskLabel,
    resumo,
    corpo,
    decisao: false,
    respondeA: null,
    createdAt: new Date(Date.now() + messages.length).toISOString(),
    destinatarios: [{ ...ME, entrega: "canal", lidaEm: null }],
  });
}

addMessage({
  id: "m1",
  threadId: "dm-100-200",
  from: ANA,
  resumo: "Old message already waiting",
  corpo: "Old message already waiting\n\nBody of the first one.",
});

const unreadFor = () =>
  messages.filter((m) => m.from.clickupUserId !== ME.clickupUserId && !read.has(m.id));

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  if (req.headers.authorization !== `Bearer ${TOKEN}` && req.headers.authorization !== `Bearer ${RENEWED}`) {
    return send(401, { error: { code: "UNAUTHORIZED", message: "Invalid or expired session", status: 401 } });
  }
  const extra = renewOnce ? { "X-Sprint-Token": RENEWED } : {};
  renewOnce = false;

  if (req.method === "GET" && url.pathname === "/api/messages/inbox") {
    return send(200, {
      itens: unreadFor().map((m) => ({
        id: m.id,
        threadId: m.threadId,
        taskLabel: m.taskLabel,
        from: m.from,
        resumo: m.resumo,
        decisao: m.decisao,
        createdAt: m.createdAt,
        lidaEm: null,
      })),
    }, extra);
  }
  if (req.method === "GET" && url.pathname === "/api/messages/unread-count") {
    return send(200, { naoLidas: unreadFor().length }, extra);
  }
  if (req.method === "GET" && url.pathname === "/api/messages/threads") {
    const byThread = new Map();
    for (const m of messages) byThread.set(m.threadId, m);
    return send(200, {
      threads: [...byThread.values()].reverse().map((last) => ({
        threadId: last.threadId,
        taskId: last.taskId,
        taskLabel: last.taskLabel,
        participantes: [ME, ANA],
        ultima: { id: last.id, resumo: last.resumo, fromName: last.from.name, createdAt: last.createdAt },
        naoLidas: unreadFor().filter((m) => m.threadId === last.threadId).length,
      })),
    }, extra);
  }
  const thread = url.pathname.match(/^\/api\/messages\/threads\/([\w-]+)$/);
  if (req.method === "GET" && thread) {
    const list = messages.filter((m) => m.threadId === thread[1]);
    for (const m of list) read.add(m.id);
    return send(200, { mensagens: list }, extra);
  }
  if (req.method === "POST" && url.pathname === "/api/messages") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      posted.push(body);
      const original = messages.find((m) => m.id === body.respondeA);
      addMessage({
        id: `r${posted.length}`,
        threadId: original?.threadId ?? "dm-100-200",
        from: ME,
        resumo: body.corpo.split("\n")[0],
        corpo: body.corpo,
      });
      send(201, { id: `r${posted.length}`, threadId: original?.threadId, taskLabel: null, entregas: [], comentarioNaTask: null });
    });
    return;
  }
  send(404, { error: { code: "NOT_FOUND", message: "nope", status: 404 } });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

// --- fixture ---------------------------------------------------------------

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "specterm-inbox-home-"));
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specterm-inbox-"));
const tokenFile = path.join(fakeHome, ".config", "sprint-platform", "token");
fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
fs.writeFileSync(tokenFile, `${TOKEN}\n`);

// --- run -------------------------------------------------------------------

let app;
try {
  app = await electron.launch(
    launchOptions(root, userDataDir, {
      env: {
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        NEXFAR_PLANNING_URL: baseUrl,
        SPECTERM_INBOX_POLL_MS: "700",
      },
    })
  );
  const win = await app.firstWindow();
  win.on("pageerror", (e) => log("PAGEERROR:", e.message));
  await win.waitForSelector(".tab-inbox", { timeout: 20000 });

  // 1. The backlog shows as a count, not as a toast.
  const badge = win.locator(".tab-inbox .tab-icon-count");
  const counted = await until("the unread badge", async () => (await badge.textContent()) === "1");
  check("the unread count shows on the inbox icon", counted, String(await badge.textContent().catch(() => null)));
  await new Promise((r) => setTimeout(r, 1000));
  check("the backlog at launch raises no preview", (await win.locator(".inbox-toast").count()) === 0);

  // 2. A new message: preview under the icon, count goes up.
  addMessage({
    id: "m2",
    threadId: "task-abc123",
    from: ANA,
    taskLabel: "TECH-1234",
    resumo: "Deploy is green, can you check?",
    corpo: "Deploy is green, can you check?\n\nSee [the run](https://example.com/run).",
  });
  const toast = win.locator(".inbox-toast");
  const toasted = await until("the preview", () => toast.isVisible(), { timeout: 5000 });
  const toastText = toasted ? await toast.textContent() : "";
  check(
    "a new message shows a preview under the icon",
    toasted && toastText.includes("Ana Souza") && toastText.includes("Deploy is green") && toastText.includes("TECH-1234"),
    toastText
  );
  if (toasted) {
    const [btn, box] = await Promise.all([
      win.locator(".tab-inbox").boundingBox(),
      toast.boundingBox(),
    ]);
    check("the preview hangs below the icon", box.y >= btn.y + btn.height, `${box.y} vs ${btn.y + btn.height}`);
  }
  check("the count follows", await until("badge 2", async () => (await badge.textContent()) === "2"));
  await new Promise((r) => setTimeout(r, 400)); // past the fade-in
  await win.screenshot({ path: path.join(root, "test", "shot-inbox-toast.png") });

  // 3. Clicking the preview opens the panel on that thread, and reading it
  //    brings the count down.
  await toast.click();
  const opened = await until("the thread in the panel", async () =>
    (await win.locator(".inbox-panel .inbox-message").count()) === 1
  );
  const body = await win.locator(".inbox-message-body").last().textContent().catch(() => "");
  check("clicking the preview opens the panel on that thread", opened && body.includes("See the run"), body);
  check(
    "the message body is rendered as markdown",
    (await win.locator('.inbox-message-body a[href="https://example.com/run"]').count()) === 1
  );
  check("reading the thread lowers the count", await until("badge 1", async () => (await badge.textContent()) === "1"));
  check("the preview is gone", (await toast.count()) === 0);

  // 4. Reply.
  await win.locator(".inbox-reply-input").fill("On it\n\nWill check after lunch.");
  await win.locator(".inbox-reply-input").press(MAC ? "Meta+Enter" : "Control+Enter");
  const replied = await until("the reply to land", () => posted.length === 1);
  check(
    "a reply posts to the thread's last message",
    replied && posted[0].respondeA === "m2" && posted[0].corpo.startsWith("On it"),
    JSON.stringify(posted[0])
  );
  check(
    "the reply shows in the thread",
    await until("reply rendered", async () => (await win.locator(".inbox-message").count()) === 2)
  );
  await win.screenshot({ path: path.join(root, "test", "shot-inbox-thread.png") });

  // 4b. A click anywhere on a message's block collapses it to its summary,
  //     and another click opens it again.
  const first = win.locator(".inbox-message").first();
  await first.locator(".inbox-message-body").click();
  const collapsed = await until("collapsed", async () => (await first.locator(".inbox-message-resumo").count()) === 1);
  await first.locator(".inbox-message-resumo").click();
  const reopened = await until("reopened", async () => (await first.locator(".inbox-message-body").count()) === 1);
  check("clicking a message's block collapses and reopens it", collapsed && reopened);

  // 5. Back to the list.
  await win.locator(".inbox-panel-header .inbox-icon-btn").first().click();
  const listed = await until("thread list", async () => (await win.locator(".inbox-thread").count()) === 2);
  check("the thread list shows every conversation", listed);
  check("the unread conversation is marked", (await win.locator(".inbox-thread.unread").count()) === 1);

  // 6. The shortcut toggles the panel.
  await win.locator(".app-content").click();
  await win.keyboard.press(INBOX_KEY);
  check("the shortcut closes the inbox", await until("closed", async () => (await win.locator(".inbox-panel").count()) === 0));
  await win.keyboard.press(INBOX_KEY);
  check("the shortcut opens the inbox", await until("open", () => win.locator(".inbox-panel").isVisible()));

  // 7. A renewed token comes back to the file the skills read.
  renewOnce = true;
  check(
    "a renewed token is written back",
    await until("token file", () => fs.readFileSync(tokenFile, "utf-8").trim() === RENEWED, { timeout: 5000 })
  );

  // 8. No token: the panel offers to sign in, and the badge goes away.
  fs.rmSync(tokenFile);
  const signIn = await until("sign-in prompt", () => win.locator(".inbox-panel .inbox-primary-btn").isVisible(), { timeout: 5000 });
  check("with no token the panel offers to sign in", signIn);
  check("with no token there is no count", (await badge.count()) === 0);
} catch (err) {
  console.error("[inbox] ERROR:", err?.stack || err);
  results.push({ name: "suite ran", pass: false, skipped: false });
} finally {
  try {
    await Promise.race([app?.close(), new Promise((r) => setTimeout(r, 3000))]);
  } catch (_) {
    // Best effort; the kill below is the backstop.
  }
  try { app?.process().kill("SIGKILL"); } catch {}
  server.close();
  for (const dir of [userDataDir, fakeHome]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

const failed = results.filter((r) => !r.pass).length;
const skipped = results.filter((r) => r.skipped).length;
log(`\n===== ${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped =====`);
if (hard) clearTimeout(hard);
process.exit(failed === 0 ? 0 : 1);
