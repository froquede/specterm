// Screenshot the chrome, for looking at.
//
// Not a test: nothing here asserts. It launches the built app on a throwaway
// profile, drives it into each layout worth seeing, and writes a PNG per state
// so a UI change can be reviewed as a picture instead of as a diff.
//
// Run: node scripts/ui-shots.mjs [outDir]   (after `vite build`)
import { _electron as electron } from "playwright";
import { launchOptions } from "../test/launch.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = process.argv[2] ?? path.join(root, "build-output", "ui-shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[shots]", ...a);

fs.mkdirSync(outDir, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "specterm-shots-"));

const app = await electron.launch(launchOptions(root, profile));
const win = await app.firstWindow();
await win.waitForSelector(".xterm-screen canvas", { timeout: 30000 });
await win.setViewportSize({ width: 1280, height: 800 });

let n = 0;
async function shot(name) {
  await sleep(350); // let transitions settle
  const file = path.join(outDir, `${String(++n).padStart(2, "0")}-${name}.png`);
  await win.screenshot({ path: file });
  log(`wrote ${file}`);
}

// Move the tab bar by clicking the corner picker, which means opening the
// settings panel. Writing localStorage directly would be quicker and wrong:
// changes propagate through the host (see lib/store-sync), not through the
// storage event, so a poked value wouldn't reach the running window.
async function setCorner(corner) {
  await win.click(".tab-settings");
  await win.waitForSelector(".corner-picker", { timeout: 10000 });
  await win.click(`.corner-option[data-corner="${corner}"]`);
  await sleep(250);
  await win.click(".tab-settings");
  await sleep(300);
}

// Drive the chrome sizes the way the app offers them: the tab bar has a slider,
// the sidebar is dragged. (There is no sidebar-width slider any more — one width
// for both views, set by the edge between the sidebar and the panes.)
async function setBarHeight(px) {
  await win.click(".tab-settings");
  await win.waitForSelector("#tab-bar-height", { timeout: 10000 });
  await win.evaluate((v) => {
    const el = document.querySelector("#tab-bar-height");
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    ).set;
    setter.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, px);
  await sleep(300);
  await win.click(".tab-settings");
  await sleep(300);
}

async function dragSidebarTo(px) {
  // The sidebar has to be showing to be dragged; open the file tree if the
  // previous shot left it closed.
  if (!(await win.locator(".file-tree, .settings-sidebar").count())) {
    await win.click(".tab-actions button:first-child");
    await sleep(400);
  }
  const sidebar = await win.locator(".file-tree, .settings-sidebar").first().boundingBox();
  const handle = await win.locator(".sidebar-resize-handle").boundingBox();
  if (!sidebar || !handle) return;
  await win.mouse.move(handle.x + handle.width / 2, handle.y + 200);
  await win.mouse.down();
  await win.mouse.move(
    handle.x + handle.width / 2 + (px - sidebar.width),
    handle.y + 200,
    { steps: 10 }
  );
  await win.mouse.up();
  await sleep(300);
}

// A couple of extra tabs, so the tab bar has something to be a tab bar about.
for (const _ of [0, 1]) {
  await win.click(".tab-new");
  await sleep(500);
}

await shot("tabs-top-left");

// Settings sidebar, top of the scroll and then a couple of pages down.
await win.click(".tab-settings");
await win.waitForSelector(".settings-sidebar", { timeout: 10000 });
await shot("settings-top");
await win.evaluate(() => {
  document.querySelector(".settings-scroll")?.scrollTo(0, 520);
});
await shot("settings-scrolled");
await win.evaluate(() => {
  const el = document.querySelector(".settings-scroll");
  if (el) el.scrollTop = el.scrollHeight;
});
await shot("settings-bottom");
await win.click(".tab-settings");
await sleep(300);

// File sidebar.
await win.click(".tab-actions button:first-child");
await sleep(400);
await shot("file-sidebar");
await win.click(".tab-actions button:first-child");
await sleep(300);

// The tab bar in each of its four corners. The bottom two are the ones the
// window controls must not follow it into.
for (const corner of ["top-right", "bottom-left", "bottom-right"]) {
  await setCorner(corner);
  await shot(`tabs-${corner}`);
}
await setCorner("top-left");

// The chrome at a 28px tab bar and a 250px sidebar — smaller than the defaults,
// and the size that shows whether the icons hold up when the bar is tight.
await setBarHeight(28);
// Leaves the file tree open at 250px, which is the next shot.
await dragSidebarTo(250);
await shot("compact-file-sidebar");
await win.click(".tab-actions button:first-child");
await sleep(400);
await shot("compact-28px-bar");
await win.click(".tab-settings");
await win.waitForSelector(".settings-sidebar", { timeout: 10000 });
await shot("compact-settings");

// And under a theme whose palette is nothing like the default, so anything
// still wearing a hardcoded colour has nowhere to hide.
await win.selectOption("#theme-select", { label: "Gruvbox Dark" }).catch(async () => {
  const opts = await win.evaluate(() =>
    [...document.querySelectorAll("#theme-select option")].map((o) => o.value)
  );
  await win.selectOption("#theme-select", opts[Math.min(2, opts.length - 1)]);
});
await sleep(500);
await shot("themed-settings");
await win.click(".tab-settings");
await sleep(300);
await win.click(".tab-actions button:first-child");
await sleep(500);
await shot("themed-file-sidebar");

await app.close().catch(() => {});
try {
  app.process().kill("SIGKILL");
} catch (_) {
  /* already gone */
}
fs.rmSync(profile, { recursive: true, force: true });
log(`done — ${n} shots in ${outDir}`);
