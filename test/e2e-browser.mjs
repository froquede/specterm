// Browser panes — end to end, against the real app and a local web server.
//
// What it holds the feature to: a page opens in a tab of its own from the
// keyboard, follows links, keeps its address in the tab's snapshot, survives a
// switch to another tab without reloading, opens target=_blank links as new
// tabs, leaves the app's shortcuts working while it has the keyboard, and gets
// none of what the app's own pages have (Node, file://, permissions).
//
// Run: node test/e2e-browser.mjs   (after `vite build`)
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

const BROWSER_KEY = MAC ? "Meta+Shift+B" : "Control+Alt+B";
const REOPEN_KEY = MAC ? "Meta+Shift+T" : "Control+Shift+R";

const started = Date.now();
const elapsed = () => ((Date.now() - started) / 1000).toFixed(1).padStart(6);
const log = (...a) => console.log(`[browser ${elapsed()}s]`, ...a);

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, skipped: false });
  log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const HARD_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 180000);
const hard =
  HARD_TIMEOUT_MS > 0 &&
  setTimeout(() => {
    console.error("[browser] HARD TIMEOUT");
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

// --- the web server ------------------------------------------------------------

const hits = new Map();
const pages = {
  "/one": `<title>Page one</title><body style="background:#fde">
    <h1>One</h1><a id="next" href="/two">two</a>
    <a id="blank" href="/three" target="_blank">three in a new tab</a></body>`,
  "/two": `<title>Page two</title><body style="background:#dfe"><h1>Two</h1></body>`,
  "/three": `<title>Page three</title><body><h1>Three</h1></body>`,
};
const server = http.createServer((req, res) => {
  hits.set(req.url, (hits.get(req.url) ?? 0) + 1);
  const body = pages[req.url];
  res.writeHead(body ? 200 : 404, { "content-type": "text/html" });
  res.end(body ?? "not found");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// --- run -------------------------------------------------------------------------

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specterm-browser-"));
const shotDir = process.env.E2E_SHOTS ?? null;
let app;
try {
  app = await electron.launch(launchOptions(root, userDataDir));
  const win = await app.firstWindow();
  win.on("pageerror", (e) => log("PAGEERROR:", e.message));
  win.on("console", (m) => m.type() === "error" && log("console:", m.text()));
  await win.waitForSelector(".xterm", { timeout: 20000 });

  const tabCount = () => win.locator(".tab").count();
  const activeTitle = () => win.locator(".tab.active").textContent();
  const pane = win.locator(".pane-browser");
  const address = pane.locator(".browser-address");
  // The visible page, and what it says about itself. Run as a user gesture,
  // as a real click is: Chromium skips history entries a page left without
  // one, so a scripted click would leave nothing for Back.
  const guest = (js) =>
    win.evaluate(async (js) => {
      const views = [...document.querySelectorAll(".browser-view")].filter((w) => w.style.visibility === "visible");
      if (views.length !== 1) throw new Error(`${views.length} visible pages`);
      return views[0].querySelector("webview").executeJavaScript(js, true);
    }, js);

  // 1. The shortcut opens a browser tab with the address bar focused.
  const before = await tabCount();
  await win.keyboard.press(BROWSER_KEY);
  check("the shortcut opens a tab", await until("tab", async () => (await tabCount()) === before + 1));
  check("with a browser pane", await until("pane", () => pane.isVisible()));
  check("and the address bar focused", await until("focus", () => address.evaluate((el) => el === document.activeElement)));

  // 2. Typing an address loads it, and the tab takes the page's title.
  await address.fill(`${base}/one`);
  await address.press("Enter");
  check("the page loads", await until("one", async () => (await guest("document.title")) === "Page one", { timeout: 15000 }));
  check("the tab is named after it", await until("title", async () => (await activeTitle())?.includes("Page one")), await activeTitle());
  check("the page has no Node", (await guest("typeof require + typeof process")) === "undefinedundefined");
  if (shotDir) await win.screenshot({ path: path.join(shotDir, "browser-one.png") });

  // 3. A link moves the page and the address bar; back is available.
  await guest("document.getElementById('next').click()");
  check("a link navigates", await until("two", async () => (await guest("document.title")) === "Page two"));
  check("the address bar follows", await until("addr", async () => (await address.inputValue()) === `${base}/two`), await address.inputValue());
  check("back is enabled", await until("back", () => pane.locator('button[title="Back"]').isEnabled()));
  await pane.locator('button[title="Back"]').click();
  check("back goes back", await until("back to one", async () => (await guest("document.title")) === "Page one"));

  // 4. Switching tabs keeps the page loaded.
  const loads = hits.get("/one");
  await win.locator(".tab").first().click();
  check("another tab hides the page", await until("hidden", async () => (await win.locator('.browser-view[style*="visible"]').count()) === 0));
  await win.locator(".tab").last().click();
  check("coming back shows it", await until("shown", async () => (await guest("document.title")) === "Page one"));
  check("without reloading it", hits.get("/one") === loads, `${loads} → ${hits.get("/one")}`);

  // 5. target=_blank opens a browser tab.
  const n = await tabCount();
  await guest("document.getElementById('blank').click()");
  check("a target=_blank link opens a tab", await until("new tab", async () => (await tabCount()) === n + 1));
  check("on that page", await until("three", async () => (await guest("document.title")) === "Page three", { timeout: 15000 }));

  // 6. The app's shortcuts still work with the page focused.
  await win.evaluate(() => {
    const v = [...document.querySelectorAll(".browser-view")].find((w) => w.style.visibility === "visible");
    v.querySelector("webview").focus();
  });
  await guest("document.body.focus()");
  const m = await tabCount();
  // Sent as the OS would send it, to the page's own contents: Playwright's
  // keyboard goes to the window's renderer and never reaches the page.
  await app.evaluate(({ webContents }, mac) => {
    const page = webContents.getAllWebContents().find((c) => c.getType() === "webview" && c.isFocused?.());
    const target = page ?? webContents.getAllWebContents().filter((c) => c.getType() === "webview").pop();
    const modifiers = mac ? ["meta"] : ["control", "shift"];
    target.sendInputEvent({ type: "keyDown", keyCode: "T", modifiers });
    target.sendInputEvent({ type: "keyUp", keyCode: "T", modifiers });
  }, MAC);
  check("an app shortcut works from inside a page", await until("new terminal tab", async () => (await tabCount()) === m + 1), `${m} → ${await tabCount()}`);

  // 7. A closed browser tab reopens at its address.
  await win.locator(".tab").nth(1).click(); // the first browser tab, on /one
  await until("pane", () => pane.isVisible());
  const k = await tabCount();
  await win.locator(".tab.active .tab-close, .tab.active [aria-label^='Close']").first().click();
  await until("closed", async () => (await tabCount()) === k - 1);
  check("closing destroys its page", (await win.locator(".browser-view").count()) === 1);
  await win.locator(".tab").first().click();
  await win.keyboard.press(REOPEN_KEY);
  check(
    "reopening brings it back at its address",
    await until("reopened", async () => (await guest("location.href")) === `${base}/one`, { timeout: 15000 })
  );

  // 8. What a page gets: no permissions beyond full screen, no file://.
  check("a permission is refused", (await guest("Notification.requestPermission()")) === "denied");
  await guest("location.href = 'file:///etc/hostname'");
  await new Promise((r) => setTimeout(r, 500));
  check("file:// is refused", (await guest("location.protocol")) === "http:");
  const attached = await win.evaluate(
    () =>
      new Promise((resolve) => {
        const v = document.createElement("webview");
        v.setAttribute("src", "file:///etc/hostname");
        v.setAttribute("partition", "persist:browser");
        v.style.cssText = "position:fixed;width:10px;height:10px";
        let loaded = false;
        v.addEventListener("did-finish-load", () => (loaded = true));
        document.body.appendChild(v);
        setTimeout(() => {
          v.remove();
          resolve(loaded);
        }, 1500);
      })
  );
  check("a webview pointed at file:// never loads", attached === false);
} catch (err) {
  check(`no exception (${err.message})`, false);
} finally {
  await app?.close().catch(() => {});
  server.close();
}

const failed = results.filter((r) => !r.pass).length;
console.log(`===== ${results.length - failed} passed, ${failed} failed =====`);
process.exit(failed ? 1 : 0);
