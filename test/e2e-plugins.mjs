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
// And a git repository, not in the plugins folder, with a plugin ("greet") in
// a subfolder and two release tags: what Settings > Plugins adds from a URL.
//
// What is checked is the contract's promises: nothing runs until the user turns
// a plugin on, turning it off undoes everything (view, stylesheet, listeners,
// shortcut, and the plugin host process itself), and once on, its button is
// there on the first frame of the next launch.
//
// Run: node test/e2e-plugins.mjs   (after `vite build`)
import { _electron as electron } from "playwright";
import { launchOptions } from "./launch.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
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

// A plugin developed in place: its folder lives elsewhere and is symlinked in.
const linkedSource = fs.mkdtempSync(path.join(os.tmpdir(), "specterm-linked-plugin-"));
fs.writeFileSync(
  path.join(linkedSource, "specterm-plugin.json"),
  JSON.stringify({ id: "linked", name: "Linked", version: "1.0.0", engines: { specterm: "^1" } })
);
fs.symlinkSync(linkedSource, path.join(pluginsDir, "linked"), "dir");

// A repository to add a plugin from, as a user would paste its URL: the plugin
// sits in apps/greet and is released as greet-v1.0.0 and greet-v1.1.0.
const greetRepo = fs.mkdtempSync(path.join(os.tmpdir(), "specterm-greet-repo-"));
{
  const git = (...args) => execFileSync("git", args, { cwd: greetRepo, stdio: "pipe" });
  const write = (rel, body) => {
    const p = path.join(greetRepo, "apps", "greet", rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  };
  const manifest = (version) => ({
    id: "greet",
    name: "Greet",
    version,
    engines: { specterm: "^1.1" },
    panel: "panel.js",
    sidebarViews: [{ id: "main", title: "Greet", icon: "bell" }],
    tabBarButton: { view: "main", icon: "bell", title: "Greet" },
  });
  git("init", "-q");
  git("config", "user.email", "e2e@specterm.test");
  git("config", "user.name", "e2e");
  write("panel.js", `export function mount(el) { el.textContent = "greetings"; return () => {}; }`);
  write("specterm-plugin.json", manifest("1.0.0"));
  git("add", ".");
  git("commit", "-qm", "greet 1.0.0");
  git("tag", "greet-v1.0.0");
  write("specterm-plugin.json", manifest("1.1.0"));
  git("commit", "-qam", "greet 1.1.0");
  git("tag", "greet-v1.1.0");
  // A second plugin in the same repo whose id is taken by "hello", which is in
  // the plugins folder by hand.
  const twin = path.join(greetRepo, "apps", "twin", "specterm-plugin.json");
  fs.mkdirSync(path.dirname(twin), { recursive: true });
  fs.writeFileSync(twin, JSON.stringify({ id: "hello", name: "Twin", version: "1.0.0", engines: { specterm: "^1" } }));
  git("add", ".");
  git("commit", "-qm", "twin 1.0.0");
  git("tag", "twin-v1.0.0");
}
const greetUrl = `${pathToFileURL(greetRepo).href}#:apps/greet`;

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
    launchOptions(root, userDataDir, {
      // The background update check is run on cue below, never by its timer.
      env: { HOME: fakeHome, USERPROFILE: fakeHome, SPECTERM_PLUGIN_UPDATE_DELAY_MS: "3600000" },
    })
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
  check(
    "nothing of it is drawn while off",
    (await win.locator('.tab-plugin[data-plugin="hello"]').count()) === 0
  );

  // 1b. The built-in GitHub plugin: listed as built in, on by default, its
  //     button there, and no host process until its view is opened.
  const githubItem = win.locator('.plugins-settings-item[data-plugin="github"]');
  check("the built-in GitHub plugin is listed", (await githubItem.count()) === 1);
  check("and is on by default", await githubItem.locator("input").isChecked());
  check(
    "and its button is drawn",
    (await win.locator('.tab-plugin[data-plugin="github"]').count()) === 1
  );
  const githubRunning = async () =>
    (await win.evaluate(() => window.specterm.pluginsState())).plugins.find((p) => p.id === "github")
      ?.running === true;
  check("its host has not started before its view opens", !(await githubRunning()));
  check(
    "a symlinked plugin folder is found",
    (await win.locator('.plugins-settings-item[data-plugin="linked"]').count()) === 1
  );
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

  // 10. The built-in GitHub plugin: its host starts on the view's first call,
  //     and a user of the version where GitHub was part of the core keeps
  //     their watchlist and their open panel.
  const github = win.locator('.tab-plugin[data-plugin="github"]');
  await github.click();
  const githubView = win.locator('.plugin-view[data-plugin="github"]');
  check("the GitHub button opens its view", await until("github view", () => githubView.isVisible()));
  check("its host starts on the view's first call", await until("github running", githubRunning));
  await win.evaluate(() => {
    localStorage.removeItem("specterm.plugin.github");
    const settings = JSON.parse(localStorage.getItem("specterm.settings") || "{}");
    settings.githubWatchlist = ["acme/widgets"];
    localStorage.setItem("specterm.settings", JSON.stringify(settings));
    localStorage.setItem("specterm.sidebar", JSON.stringify({ view: "github" }));
  });
  await win.reload();
  await win.waitForSelector(".tab-bar", { timeout: 20000 });
  check(
    "a sidebar left on the old GitHub panel opens on the plugin's",
    await until("migrated view", () => githubView.isVisible())
  );
  const migrated = await win.evaluate(() => localStorage.getItem("specterm.plugin.github"));
  check(
    "the watchlist moves from the settings to the plugin's storage",
    migrated === JSON.stringify({ watchlist: ["acme/widgets"] }),
    String(migrated)
  );

  // 10b. The same for the Vault: its list, the open sidebar and the user's
  //      rebinding of its shortcuts carry over from when it was in the core.
  await win.evaluate(() => {
    localStorage.removeItem("specterm.plugin.vault");
    localStorage.setItem("specterm.vaults", JSON.stringify([{ path: "/tmp/notes", label: "notes" }]));
    localStorage.setItem("specterm.sidebar", JSON.stringify({ view: "vault" }));
    localStorage.setItem(
      "specterm.keybindings",
      JSON.stringify({ "vault.toggle": { key: "k", ctrl: true, alt: true, shift: true } })
    );
  });
  await win.reload();
  await win.waitForSelector(".tab-bar", { timeout: 20000 });
  check(
    "a sidebar left on the old Vault panel opens on the plugin's",
    await until("vault view", () => win.locator('.plugin-view[data-plugin="vault"]').isVisible())
  );
  const vaultStore = await win.evaluate(() => localStorage.getItem("specterm.plugin.vault"));
  check(
    "the vault list moves to the plugin's storage",
    vaultStore === JSON.stringify({ vaults: [{ path: "/tmp/notes", label: "notes" }] }),
    String(vaultStore)
  );
  await win.locator(".vault-panel").waitFor({ timeout: 5000 }).catch(() => {});
  await win.keyboard.press("Control+Alt+Shift+K");
  check(
    "a rebound core shortcut keeps its chord as the plugin's",
    await until("vault closed by the old override", async () =>
      (await win.locator('.plugin-view[data-plugin="vault"]').count()) === 0
    )
  );
  await win.evaluate(() => localStorage.removeItem("specterm.keybindings"));
  const order = await win.locator(".tab-plugin").evaluateAll((els) => els.map((e) => e.dataset.plugin));
  check(
    "built-in buttons keep their old order (vault, then github)",
    order.indexOf("vault") !== -1 && order.indexOf("vault") < order.indexOf("github"),
    order.join(",")
  );
  const served = await win.evaluate(async () => {
    const get = (u) => fetch(u).then((r) => r.status, () => "error");
    return {
      renderer: await get("specterm-plugin://vault/dist/renderer.js"),
      host: await get("specterm-plugin://vault/host.cjs"),
      manifest: await get("specterm-plugin://vault/specterm-plugin.json"),
    };
  });
  check(
    "the scheme serves a plugin's built files but not its host or manifest",
    served.renderer === 200 && served.host === 404 && served.manifest === 404,
    JSON.stringify(served)
  );

  // 11. A built-in plugin can be turned off, and stays off.
  await win.locator(".tab-settings").click();
  await win.locator('.plugins-settings-item[data-plugin="github"] input').click();
  check("turning GitHub off removes its button", await until("no github", async () => (await github.count()) === 0));
  const saved = JSON.parse(fs.readFileSync(path.join(userDataDir, "plugins.json"), "utf-8"));
  check("and is remembered", saved.disabled?.github === true, JSON.stringify(saved.disabled));

  // 12. Adding a plugin from its git URL, and removing it again.
  const addInput = win.locator("#plugins-settings-add-url");
  const addButton = win.locator(".plugins-settings-add-button");
  check(
    "built-in and external plugins are listed apart",
    (await win.locator('[data-group="built-in"] .plugins-settings-item[data-plugin="github"]').count()) === 1 &&
      (await win.locator('[data-group="external"] .plugins-settings-item[data-plugin="hello"]').count()) === 1
  );
  check(
    "a plugin copied in by hand cannot be removed from Settings",
    (await win.locator('.plugins-settings-item[data-plugin="hello"] .plugins-settings-remove').count()) === 0
  );
  await addInput.fill("example.com/owner/repo");
  await addButton.click();
  check(
    "a pasted string that is not a git URL is refused, with the reason",
    await until("the error", async () =>
      /not a git repository URL/.test((await win.locator(".plugins-settings-add-error").textContent()) ?? "")
    )
  );
  await addInput.fill(greetUrl);
  await addButton.click();
  const greetItem = win.locator('[data-group="external"] .plugins-settings-item[data-plugin="greet"]');
  check("a plugin added from its URL is listed under External", await until("greet listed", () => greetItem.isVisible(), { timeout: 30000 }));
  check("and is on", await greetItem.locator("input").isChecked());
  check(
    "without a tag, the newest release is installed",
    ((await greetItem.locator(".plugins-settings-version").textContent()) ?? "").trim() === "1.1.0"
  );
  check(
    "its button is in the tab bar",
    await until("greet button", () => win.locator('.tab-plugin[data-plugin="greet"]').isVisible())
  );
  check("the field empties after it is added", (await addInput.inputValue()) === "");
  const greetDir = path.join(pluginsDir, "greet");
  check(
    "the plugin's folder is installed without the repository's history",
    fs.existsSync(path.join(greetDir, "specterm-plugin.json")) && !fs.existsSync(path.join(greetDir, ".git"))
  );
  check(
    "nothing is left of the clone it came from",
    fs.readdirSync(pluginsDir).every((n) => !n.startsWith(".install-")),
    fs.readdirSync(pluginsDir).join(",")
  );
  const record = JSON.parse(fs.readFileSync(path.join(userDataDir, "plugins.json"), "utf-8")).installed?.greet;
  check(
    "where it came from is recorded",
    record?.ref === "greet-v1.1.0" && record?.source === greetUrl && /^[0-9a-f]{40}$/.test(record?.commit ?? ""),
    JSON.stringify(record)
  );
  await addInput.fill(greetUrl.replace("#:", "#greet-v1.0.0:"));
  await addButton.click();
  check(
    "adding a plugin that is already installed is refused",
    await until("already installed", async () =>
      /already installed/.test((await win.locator(".plugins-settings-add-error").textContent()) ?? "")
    , { timeout: 30000 })
  );
  await addInput.fill(greetUrl.replace("#:apps/greet", "#:apps/twin"));
  await addButton.click();
  check(
    "a plugin whose id a hand-copied folder already uses is refused",
    await until("id taken", async () =>
      /"hello" is already installed/.test((await win.locator(".plugins-settings-add-error").textContent()) ?? "")
    , { timeout: 30000 }) && fs.readdirSync(pluginsDir).every((n) => n !== "twin" && !n.startsWith(".install-"))
  );
  await win.locator(".plugins-settings-add").scrollIntoViewIfNeeded();
  await win.screenshot({ path: path.join(root, "test", "shot-plugins-add.png") });
  await addInput.fill("");

  // 13. Updates, automatic by default: a minor release is installed without a
  //     restart (its host starts on the new code, an open view remounts with
  //     the new panel) and a background check says so in a dialog. A new major
  //     waits for the user, and one that fails to start is rolled back.
  const greetGit = (...args) => execFileSync("git", args, { cwd: greetRepo, stdio: "pipe" });
  const release = (version, files) => {
    for (const [rel, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(greetRepo, "apps", "greet", rel), typeof body === "string" ? body : JSON.stringify(body, null, 2));
    }
    greetGit("add", ".");
    greetGit("commit", "-qm", `greet ${version}`);
    greetGit("tag", `greet-v${version}`);
  };
  const greetRelease = (version, host) => ({
    "panel.js": `export function mount(el) { el.textContent = "greetings ${version}"; return () => {}; }`,
    "host.cjs": host,
    "specterm-plugin.json": {
      id: "greet",
      name: "Greet",
      version,
      engines: { specterm: "^1.1" },
      host: "host.cjs",
      panel: "panel.js",
      sidebarViews: [{ id: "main", title: "Greet", icon: "bell" }],
      tabBarButton: { view: "main", icon: "bell", title: "Greet" },
    },
  });
  const greetInfo = async () =>
    (await win.evaluate(() => window.specterm.pluginsState())).plugins.find((p) => p.id === "greet");
  release("1.2.0", greetRelease("1.2.0", "exports.activate = () => {};"));

  // Automatic updates are on by default: the button's check installs a
  // minor release by itself and says so next to the plugin.
  const checkButton = win.locator(".plugins-settings-check-button");
  const autoSwitch = win.locator("#plugins-settings-auto-update");
  check("an added plugin gets a button to check for updates", (await checkButton.count()) === 1);
  check("automatic updates are on by default", await autoSwitch.isChecked());
  await checkButton.click();
  check(
    "a check installs a newer minor release by itself",
    await until("1.2.0 installed", async () =>
      ((await greetItem.locator(".plugins-settings-version").textContent().catch(() => "")) ?? "").trim() === "1.2.0"
    , { timeout: 30000 })
  );
  check(
    "and says so next to the plugin",
    /Updated to 1\.2\.0/.test((await greetItem.locator(".plugins-settings-updated").textContent().catch(() => "")) ?? "")
  );
  check("a check from Settings opens no dialog", (await win.locator(".plugins-updated").count()) === 0);
  check("its new host module is running, with no restart", (await greetInfo())?.running === true);
  const updateButton = greetItem.locator(".plugins-settings-update-button");
  check("nothing is left on offer", (await updateButton.count()) === 0 && (await win.locator(".tab-settings .tab-icon-badge").count()) === 0);
  const updatedRecord = JSON.parse(fs.readFileSync(path.join(userDataDir, "plugins.json"), "utf-8")).installed?.greet;
  check(
    "the record points at the new tag",
    updatedRecord?.ref === "greet-v1.2.0" && updatedRecord?.source === greetUrl && updatedRecord?.commit !== record?.commit,
    JSON.stringify(updatedRecord)
  );
  check(
    "nothing is left of the update's staging",
    fs.readdirSync(pluginsDir).every((n) => !n.startsWith(".update-")),
    fs.readdirSync(pluginsDir).join(",")
  );

  // A background check (launch, every 6 hours) updates an open view in place
  // and then says what moved, in one dialog.
  release("1.3.0", greetRelease("1.3.0", "exports.activate = () => {};"));
  await win.locator(".tab-settings").click(); // close settings
  await win.locator('.tab-plugin[data-plugin="greet"]').click();
  const greetView = win.locator('.plugin-view[data-plugin="greet"]');
  check("the view shows the installed release", await until("view 1.2.0", async () => ((await greetView.textContent().catch(() => "")) ?? "").includes("greetings 1.2.0")));
  await win.evaluate(() => window.specterm.pluginsCheckUpdatesBackground());
  check(
    "an open view reloads with the new panel",
    await until("view 1.3.0", async () => ((await greetView.textContent().catch(() => "")) ?? "").includes("greetings 1.3.0"))
  );
  const dialog = win.locator(".plugins-updated");
  check("a dialog says some plugins were updated", await until("dialog", () => dialog.isVisible()));
  const dialogText = (await dialog.textContent()) ?? "";
  check(
    "and lists each one with its versions",
    dialogText.includes("Some plugins updated to a new version") &&
      (await dialog.locator('.plugins-updated-item[data-plugin="greet"]').count()) === 1 &&
      /Greet.*1\.2\.0.*1\.3\.0/.test(dialogText),
    dialogText
  );
  await win.screenshot({ path: path.join(root, "test", "shot-plugins-updated-dialog.png") });
  await dialog.locator(".plugins-updated-ok").click();
  check("OK closes it", await until("dialog closed", async () => (await dialog.count()) === 0));

  // A new major waits to be asked for; this one fails to start, so the
  // previous copy comes back.
  release("2.0.0", greetRelease("2.0.0", `exports.activate = () => { throw new Error("broken release"); };`));
  await win.locator(".tab-settings").click();
  await checkButton.click();
  check(
    "a new major version is offered, not installed",
    await until("2.0.0 offered", async () => ((await updateButton.textContent().catch(() => "")) ?? "").includes("2.0.0"), { timeout: 30000 }) &&
      ((await greetItem.locator(".plugins-settings-version").textContent()) ?? "").trim() === "1.3.0"
  );
  check("and the Settings button gets a dot", (await win.locator(".tab-settings .tab-icon-badge").count()) === 1);
  await updateButton.click();
  check(
    "a release that fails to start is rolled back, with the reason",
    await until("rolled back", async () => /did not start .*broken release.*1\.3\.0 was kept/.test((await greetItem.locator(".settings-error").textContent().catch(() => "")) ?? ""), { timeout: 30000 }),
    (await greetItem.locator(".settings-error").textContent().catch(() => "")) ?? ""
  );
  check(
    "and the previous release runs again",
    ((await greetItem.locator(".plugins-settings-version").textContent()) ?? "").trim() === "1.3.0" &&
      (await greetInfo())?.running === true &&
      JSON.parse(fs.readFileSync(path.join(greetDir, "specterm-plugin.json"), "utf-8")).version === "1.3.0"
  );
  await greetItem.scrollIntoViewIfNeeded();
  await win.screenshot({ path: path.join(root, "test", "shot-plugins-update.png") });

  // Off, a minor release is offered rather than installed. It comes before
  // the new major, which is offered once it is in.
  await autoSwitch.click();
  check(
    "turning automatic updates off is remembered",
    await until("saved", () => JSON.parse(fs.readFileSync(path.join(userDataDir, "plugins.json"), "utf-8")).autoUpdate === false)
  );
  release("1.3.1", greetRelease("1.3.1", "exports.activate = () => {};"));
  await checkButton.click();
  check(
    "with them off, a minor release is offered, ahead of the new major",
    await until("1.3.1 offered", async () => ((await updateButton.textContent().catch(() => "")) ?? "").includes("1.3.1"), { timeout: 30000 }) &&
      ((await greetItem.locator(".plugins-settings-version").textContent()) ?? "").trim() === "1.3.0"
  );

  await greetItem.locator(".plugins-settings-remove").click();
  await greetItem.locator(".plugins-settings-remove-confirm").click();
  check(
    "removing it takes it off the list",
    await until("greet gone", async () => (await win.locator('.plugins-settings-item[data-plugin="greet"]').count()) === 0)
  );
  check(
    "and its button off the tab bar",
    await until("greet button gone", async () => (await win.locator('.tab-plugin[data-plugin="greet"]').count()) === 0)
  );
  check("and deletes its folder", !fs.existsSync(greetDir));

  await win.screenshot({ path: path.join(root, "test", "shot-plugins.png") });
} catch (err) {
  console.error("[plugins] ERROR:", err?.stack || err);
  results.push({ name: "suite ran", pass: false, skipped: false });
} finally {
  await quit(app);
  for (const dir of [userDataDir, fakeHome, linkedSource, greetRepo]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

const failed = results.filter((r) => !r.pass).length;
log(`\n===== ${results.length - failed} passed, ${failed} failed =====`);
if (hard) clearTimeout(hard);
process.exit(failed === 0 ? 0 : 1);
