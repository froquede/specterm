// Plugins — end to end, against the real app.
//
// Two fixture plugins in the profile's plugins folder:
//
//   hello  — every part of the contract: a host module (a method, a badge, a
//            timer that emits events), a panel module with a stylesheet, a
//            sidebar view, a tab-bar button and a shortcut.
//   future — asks for a plugin API major this build does not provide, so it must
//            be listed with the reason and impossible to turn on.
//   newer  — the same, for a newer minor of the API this build does provide.
//
// What is checked is the contract's promises: nothing runs until the user turns
// a plugin on, turning it off undoes everything (view, stylesheet, listeners,
// shortcut, and the plugin host process itself), and once on, its button is
// there on the first frame of the next launch.
//
// Run: node test/e2e-plugins.mjs   (after `vite build`)
import { _electron as electron } from "playwright";
import { launchOptions } from "./launch.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const MAC = process.platform === "darwin";
// The fixture's shortcut: { key: "y", shift: true } through cmd().
const HELLO_KEY = MAC ? "Meta+Shift+Y" : "Control+Alt+Y";
const BARE_KEY = MAC ? "Meta+Shift+J" : "Control+Alt+J";

const started = Date.now();
const elapsed = () => ((Date.now() - started) / 1000).toFixed(1).padStart(6);
const log = (...a) => console.log(`[plugins ${elapsed()}s]`, ...a);

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, skipped: false });
  log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const HARD_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 180000);
const hard =
  HARD_TIMEOUT_MS > 0 &&
  setTimeout(() => {
    console.error("[plugins] HARD TIMEOUT");
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

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
};

// --- fixture ---------------------------------------------------------------

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "specterm-plugins-home-"));
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specterm-plugins-"));
const pluginsDir = path.join(userDataDir, "plugins");
const pidFile = path.join(userDataDir, "plugin-data", "hello", "pid");

function writePlugin(id, files) {
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(pluginsDir, id, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  }
}

writePlugin("hello", {
  "specterm-plugin.json": {
    id: "hello",
    name: "Hello",
    version: "1.0.0",
    engines: { specterm: "^1.1" },
    host: "host.cjs",
    panel: "panel.js",
    style: "panel.css",
    sidebarViews: [
      { id: "main", title: "Hello view", icon: "inbox" },
      { id: "bare", title: "Bare view", icon: "bell", ownHeader: true },
    ],
    tabBarButton: { view: "main", icon: "inbox", title: "Hello" },
    commands: [
      { id: "toggle", title: "Toggle Hello", key: "y", shift: true, toggleView: "main" },
      { id: "bare", title: "Toggle bare", key: "j", shift: true, toggleView: "bare" },
    ],
  },
  "host.cjs": `
    const fs = require("fs");
    const path = require("path");
    exports.activate = (ctx) => {
      fs.writeFileSync(path.join(ctx.storagePath, "pid"), String(process.pid));
      ctx.setBadge(3);
      ctx.handle("ping", (x) => "pong:" + x);
      let n = 0;
      ctx.setInterval(() => ctx.emit("tick", ++n), 100);
      ctx.handle("toast", () =>
        ctx.toast({
          title: "Ana Example",
          tag: "TECH-1",
          body: "A message long enough to need two lines in a three hundred pixel toast, and then some more so it has to be clamped.",
          more: 2,
          payload: { thread: "t1" },
        })
      );
    };
  `,
  "panel.js": `
    export function mount(el, api) {
      const out = document.createElement("div");
      out.className = "hello-out";
      const ticks = document.createElement("div");
      ticks.className = "hello-ticks";
      el.append(out, ticks);
      const revealed = document.createElement("div");
      revealed.className = "hello-reveal";
      const md = document.createElement("div");
      md.className = "hello-md";
      md.innerHTML = api.renderMarkdown("**b** <i>x</i>");
      el.append(revealed, md);
      api.invoke("ping", "x").then((v) => (out.textContent = v));
      api.on("tick", (n) => (ticks.textContent = String(n)));
      api.onReveal((p) => (revealed.textContent = JSON.stringify(p)));
      return () => {
        window.__helloDisposed = (window.__helloDisposed || 0) + 1;
      };
    }
  `,
  "panel.css": `.hello-out { color: rgb(1, 2, 3); }`,
});

writePlugin("future", {
  "specterm-plugin.json": {
    id: "future",
    name: "Future",
    version: "1.0.0",
    engines: { specterm: "^2" },
  },
});

writePlugin("newer", {
  "specterm-plugin.json": {
    id: "newer",
    name: "Newer",
    version: "1.0.0",
    engines: { specterm: "^1.9" },
  },
});

const launch = () =>
  electron.launch(
    launchOptions(root, userDataDir, { env: { HOME: fakeHome, USERPROFILE: fakeHome } })
  );

async function quit(app) {
  try {
    await Promise.race([app?.close(), new Promise((r) => setTimeout(r, 3000))]);
  } catch (_) {}
  try {
    app?.process().kill("SIGKILL");
  } catch {}
}

// --- run -------------------------------------------------------------------

let app;
try {
  app = await launch();
  let win = await app.firstWindow();
  win.on("pageerror", (e) => log("PAGEERROR:", e.message));
  await win.waitForSelector(".tab-bar", { timeout: 20000 });

  // 1. Installed is not on: no button, and no plugin code ran.
  await win.locator(".tab-settings").click();
  const listed = await until("the plugins list", () =>
    win.locator('.plugins-settings-item[data-plugin="hello"]').isVisible()
  );
  check("installed plugins are listed in Settings", listed);
  check(
    "a newly found plugin starts off",
    !(await win.locator('.plugins-settings-item[data-plugin="hello"] input').isChecked())
  );
  check("nothing of it is drawn while off", (await win.locator(".tab-plugin").count()) === 0);
  check("its host code has not run", !fs.existsSync(pidFile));

  // 2. A plugin for a newer API says why and cannot be turned on.
  const futureError = await win
    .locator('.plugins-settings-item[data-plugin="future"] .settings-error')
    .textContent()
    .catch(() => "");
  check(
    "an incompatible plugin shows why",
    /needs plugin API 2/.test(futureError ?? ""),
    String(futureError)
  );
  check(
    "and cannot be turned on",
    await win.locator('.plugins-settings-item[data-plugin="future"] input').isDisabled()
  );
  const newerError = await win
    .locator('.plugins-settings-item[data-plugin="newer"] .settings-error')
    .textContent()
    .catch(() => "");
  check(
    "a plugin needing a newer minor says to update",
    /needs plugin API 1\.9.*update Specterm/.test(newerError ?? ""),
    String(newerError)
  );

  // 3. Turning it on: button, badge from the host.
  await win.locator('.plugins-settings-item[data-plugin="hello"] input').click();
  const button = win.locator('.tab-plugin[data-plugin="hello"]');
  check("turning it on adds its tab-bar button", await until("the button", () => button.isVisible()));
  const badged = await until("the badge", async () =>
    (await button.locator(".tab-icon-count").textContent()) === "3"
  );
  check("the host's badge shows on the button", badged);
  check("its host code ran", await until("the pid file", () => fs.existsSync(pidFile)));
  const hostPid = Number(fs.readFileSync(pidFile, "utf-8"));
  check(
    "the host runs outside the main process",
    hostPid > 0 && hostPid !== app.process().pid,
    `host ${hostPid}, main ${app.process().pid}`
  );

  // 4. The view: panel module, a host call, host events, the stylesheet.
  await button.click();
  const view = win.locator('.plugin-view[data-plugin="hello"]');
  check("the button opens the plugin's view", await until("the view", () => view.isVisible()));
  check(
    "the panel can call its host",
    await until("pong", async () => (await win.locator(".hello-out").textContent()) === "pong:x")
  );
  check(
    "the panel hears its host's events",
    await until("ticks", async () => Number(await win.locator(".hello-ticks").textContent()) >= 2)
  );
  const colour = await win
    .locator(".hello-out")
    .evaluate((el) => getComputedStyle(el).color)
    .catch(() => "");
  check("the plugin's stylesheet applies", colour === "rgb(1, 2, 3)", colour);
  const md = await win.locator(".hello-md").innerHTML().catch(() => "");
  check(
    "renderMarkdown renders markdown and escapes raw HTML",
    md.includes("<strong>b</strong>") && md.includes("&lt;i&gt;") && !md.includes("<i>"),
    md
  );
  check(
    "the frame draws the view's header",
    (await view.locator(".plugin-view-header").textContent().catch(() => "")) === "Hello view"
  );

  // 5. Its shortcut closes the view, and closing undoes the panel.
  await win.keyboard.press(HELLO_KEY);
  check("its shortcut closes the view", await until("view gone", async () => (await view.count()) === 0));
  check(
    "the panel's dispose ran",
    (await win.evaluate(() => window.__helloDisposed ?? 0)) === 1
  );
  check(
    "its stylesheet is removed",
    (await win.locator('link[data-plugin="hello"]').count()) === 0
  );

  // 6. A toast from the host, under the button; clicking it opens the view and
  //    hands its payload to the panel.
  await win.evaluate(() => window.specterm.pluginInvoke("hello", "toast", []));
  const toast = win.locator('.plugin-toast[data-plugin="hello"]');
  check("a host toast shows while the view is closed", await until("toast", () => toast.isVisible()));
  check(
    "with its title and the count of the rest",
    (await toast.locator(".plugin-toast-title").textContent()) === "Ana Example" &&
      (await toast.locator(".plugin-toast-more").textContent()) === "+2"
  );
  const [tBox, bBox] = [await toast.boundingBox(), await button.boundingBox()];
  check(
    "it hangs under the plugin's button",
    tBox && bBox && tBox.y >= bBox.y + bBox.height && tBox.x <= bBox.x && tBox.x + tBox.width >= bBox.x + bBox.width,
    JSON.stringify({ tBox, bBox })
  );
  const clipped = await toast
    .locator(".plugin-toast-body")
    .evaluate((el) => el.scrollHeight > el.clientHeight && el.getBoundingClientRect().right <= el.parentElement.getBoundingClientRect().right)
    .catch(() => false);
  check("its body is clamped inside the toast", clipped);
  await toast.click();
  check("clicking it opens the view", await until("view via toast", () => view.isVisible()));
  check(
    "and hands the payload to the panel",
    await until("reveal", async () => (await win.locator(".hello-reveal").textContent()) === '{"thread":"t1"}')
  );
  await win.evaluate(() => window.specterm.pluginInvoke("hello", "toast", []));
  await new Promise((r) => setTimeout(r, 400));
  check("no toast while the view is open", (await toast.count()) === 0);

  // 7. A view that draws its own header gets no frame header.
  await win.keyboard.press(BARE_KEY);
  const bare = win.locator('.plugin-view[data-plugin="hello"]');
  await until("bare view", async () => (await bare.getAttribute("aria-label")) === "Bare view");
  check("an ownHeader view has no frame header", (await bare.locator(".plugin-view-header").count()) === 0);
  await win.keyboard.press(BARE_KEY);
  await win.keyboard.press(HELLO_KEY);
  check("and opens it again", await until("view back", () => view.isVisible()));

  // 8. Turning it off undoes everything, down to the process.
  await win.locator(".tab-settings").click();
  await win.locator('.plugins-settings-item[data-plugin="hello"] input').click();
  check("turning it off removes the button", await until("no button", async () => (await button.count()) === 0));
  check(
    "and stops the plugin host when nothing else runs in it",
    await until("host gone", () => !alive(hostPid), { timeout: 5000 })
  );
  await win.locator(".tab-settings").click(); // close settings
  await win.keyboard.press(HELLO_KEY);
  await new Promise((r) => setTimeout(r, 300));
  check("and its shortcut is gone", (await view.count()) === 0);

  // 9. On again, then a new launch: the button is on the first frame.
  await win.locator(".tab-settings").click();
  await win.locator('.plugins-settings-item[data-plugin="hello"] input').click();
  await until("the button", () => button.isVisible());
  await until("the new host", () => Number(fs.readFileSync(pidFile, "utf-8")) !== hostPid);
  await quit(app);

  app = await launch();
  win = await app.firstWindow();
  win.on("pageerror", (e) => log("PAGEERROR:", e.message));
  await win.waitForSelector(".tab-bar", { timeout: 20000 });
  check(
    "after a relaunch the button is there with the first tab bar",
    (await win.locator('.tab-plugin[data-plugin="hello"]').count()) === 1
  );
  check(
    "and the host comes back after the first paint",
    await until("badge again", async () =>
      (await win.locator('.tab-plugin[data-plugin="hello"] .tab-icon-count').textContent()) === "3"
    )
  );

  await win.screenshot({ path: path.join(root, "test", "shot-plugins.png") });
} catch (err) {
  console.error("[plugins] ERROR:", err?.stack || err);
  results.push({ name: "suite ran", pass: false, skipped: false });
} finally {
  await quit(app);
  for (const dir of [userDataDir, fakeHome]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

const failed = results.filter((r) => !r.pass).length;
log(`\n===== ${results.length - failed} passed, ${failed} failed =====`);
if (hard) clearTimeout(hard);
process.exit(failed === 0 ? 0 : 1);
