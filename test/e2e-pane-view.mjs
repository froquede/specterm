// Pane view: focus (zoom), collapse and hide. Drives the built app, takes a
// screenshot of each state into SHOTS_DIR, and checks the one thing a
// screenshot can't show: a folded terminal keeps its pty size.
import { _electron as electron } from "playwright";
import { launchOptions } from "./launch.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import http from "node:http";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shots = process.env.SHOTS_DIR || os.tmpdir();
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specterm-paneview-"));
const sizeFile = path.join(os.tmpdir(), `specterm_paneview_${process.pid}.txt`);
const results = [];
const check = (name, pass, detail = "") => {
  results.push(pass);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The loop rewrites the file every 200ms; a read can land between truncate and
// write, so take the first non-empty answer.
const readSize = async () => {
  for (let i = 0; i < 10; i++) {
    const v = fs.existsSync(sizeFile) ? fs.readFileSync(sizeFile, "utf8").trim() : "";
    if (v) return v;
    await sleep(50);
  }
  return "";
};

const app = await electron.launch(launchOptions(root, userDataDir));
const win = await app.firstWindow();
await win.setViewportSize({ width: 1280, height: 760 }).catch(() => {});
await win.waitForSelector(".pane .xterm-helper-textarea", { timeout: 20000 });
await sleep(1500);

const panes = () => win.$$eval("[data-pane-id]", (els) => els.map((e) => e.getAttribute("data-pane-id")));
const typeIn = async (paneId, text) => {
  await win.click(`[data-pane-id="${paneId}"] .pane-content`, { force: true });
  await win.keyboard.type(text);
  await win.keyboard.press("Enter");
};
const shot = (name) => win.screenshot({ path: path.join(shots, `${name}.png`) });
const isFolded = (paneId) => win.$eval(`[data-pane-id="${paneId}"]`, (e) => e.classList.contains("pane-collapsed"));
const btn = (paneId, label) => `[data-pane-id="${paneId}"] button[aria-label="${label}"]`;

// Three panes: A | (B / C).
const [a] = await panes();
await win.keyboard.press("Control+Shift+Enter");
await sleep(800);
await win.keyboard.press("Control+Shift+s");
await sleep(1200);
const [, b, c] = await panes();
check("three panes", (await panes()).length === 3);

// Pane A reports its pty size on a loop, so a resize shows up in the file.
await typeIn(a, `while true; do stty size > ${sizeFile}; sleep 0.2; done &`);
await typeIn(a, "clear; echo pane A; ls /usr");
await typeIn(b, "echo pane B; echo secret-token=abc123");
await typeIn(c, "echo pane C");
await sleep(800);
const before = await readSize();

await win.hover(`[data-pane-id="${b}"] .pane-titlebar`);
await sleep(200);
await shot("1-buttons");

// Collapse A (side by side → a vertical strip).
await win.click(btn(a, "Collapse pane"));
await sleep(900);
const during = await readSize();
check("collapsed pane keeps its pty size", during === before, `${before} → ${during}`);
const aWidth = await win.$eval(`[data-pane-id="${a}"]`, (e) => e.getBoundingClientRect().width);
check("collapsed side-by-side pane is a strip", aWidth < 40, `width=${aWidth}`);
await shot("2-collapsed-side");

// Collapse C too (stacked → a bar at the bottom).
await win.click(btn(c, "Collapse pane"));
await sleep(500);
const cHeight = await win.$eval(`[data-pane-id="${c}"]`, (e) => e.getBoundingClientRect().height);
check("collapsed stacked pane is a bar", cHeight < 40, `height=${cHeight}`);
await shot("3-collapsed-both");

// Click the strips to bring them back.
await win.click(`[data-pane-id="${a}"] .pane-titlebar`);
await win.click(`[data-pane-id="${c}"] .pane-titlebar`);
await sleep(600);
const aBack = await win.$eval(`[data-pane-id="${a}"]`, (e) => e.getBoundingClientRect().width);
check("click on the strip expands it", aBack > 200, `width=${aBack}`);
const after = await readSize();
check("expanded pane is back at its size", after === before, `${before} → ${after}`);

// The collapse chord twice in a row takes the fold back; after a pause it
// folds the pane focus was handed to instead.
const active = () => win.$eval(".pane-active", (e) => e.getAttribute("data-pane-id"));
await win.click(`[data-pane-id="${a}"] .pane-content`, { force: true });
await win.keyboard.press("Control+Alt+m");
await sleep(150);
const handed = await active();
check("collapse chord hands focus on at once", handed !== a && (await isFolded(a)), `active=${handed}`);
await win.keyboard.press("Control+Alt+m");
await sleep(300);
check("second press undoes the fold", !(await isFolded(a)) && !(await isFolded(handed)) && (await active()) === a);
await win.keyboard.press("Control+Alt+m");
await sleep(1800);
const next = await active();
await win.keyboard.press("Control+Alt+m");
await sleep(300);
check("after a pause it folds the next pane", (await isFolded(a)) && (await isFolded(next)));
await win.click(`[data-pane-id="${a}"] .pane-titlebar`);
await win.click(`[data-pane-id="${next}"] .pane-titlebar`);
await sleep(400);

// Hide B.
await win.click(btn(b, "Hide pane content"));
await sleep(300);
check("hidden pane shows a cover", !!(await win.$(`[data-pane-id="${b}"] .pane-privacy-cover`)));
await shot("4-hidden");

// Focus C: it takes the workspace.
await win.click(btn(c, "Focus pane"));
await sleep(600);
const ws = await win.$eval("[data-split-root]", (e) => e.getBoundingClientRect());
const cz = await win.$eval(`[data-pane-id="${c}"]`, (e) => e.getBoundingClientRect());
check("focused pane fills the workspace", cz.width > ws.width - 10 && cz.height > ws.height - 10, `${cz.width}x${cz.height} of ${ws.width}x${ws.height}`);
await sleep(400);
check("panes behind the focused one keep their pty size", (await readSize()) === before);
await shot("5-focused");

// Keyboard: restore with the same chord.
await win.keyboard.press("Control+Alt+Enter");
await sleep(600);
const cBack = await win.$eval(`[data-pane-id="${c}"]`, (e) => e.getBoundingClientRect());
check("chord restores the layout", cBack.width < ws.width - 100, `width=${cBack.width}`);

// Hidden content leaves layout too, and the shell keeps its size meanwhile.
await win.click(btn(b, "Show pane content"));
await win.click(btn(a, "Hide pane content"));
await sleep(900);
check("hidden pane keeps its pty size", (await readSize()) === before);
const tabTitle = () => win.$eval(".tab.active", (e) => e.textContent.trim());
check("the tab doesn't give a hidden pane's title away", (await tabTitle()) === "Hidden", await tabTitle());
await win.click(`[data-pane-id="${a}"] .pane-privacy-cover`);
await sleep(300);
await shot("7-revealed");
check("and gets it back when shown", (await tabTitle()) !== "Hidden", await tabTitle());
check("a click on the cover shows the pane", !(await win.$(`[data-pane-id="${a}"] .pane-privacy-cover`)));

// Both panes of one split folded: that split becomes one strip of its parent,
// and its panes stand on their side with it.
await win.click(btn(b, "Collapse pane"));
await win.click(btn(c, "Collapse pane"));
await sleep(500);
const bBox = await win.$eval(`[data-pane-id="${b}"]`, (e) => ({ w: e.getBoundingClientRect().width, side: e.classList.contains("pane-collapsed-h") }));
await shot("8-split-folded");
check("a fully folded split is one strip", bBox.w < 40 && bBox.side, JSON.stringify(bBox));

// Moving focus onto a folded pane opens it.
await win.click(`[data-pane-id="${a}"] .pane-content`, { force: true });
await win.keyboard.press("Alt+ArrowRight");
await sleep(400);
const arrivedAt = await active();
check("⌥+arrow onto a folded pane opens it", arrivedAt !== a && !(await isFolded(arrivedAt)), `active=${arrivedAt}`);
for (const id of [b, c]) if (await isFolded(id)) await win.click(`[data-pane-id="${id}"] .pane-titlebar`);
await sleep(300);

// The last open pane in a tab doesn't fold.
await win.click(btn(b, "Collapse pane"));
await win.click(btn(c, "Collapse pane"));
await sleep(300);
await win.click(`[data-pane-id="${a}"] .pane-content`, { force: true });
await win.keyboard.press("Control+Alt+m");
await sleep(400);
check("the last open pane won't fold", !(await isFolded(a)) && (await active()) === a);

await typeIn(a, "kill %1");

// A browser pane's page sits in a layer above the panes: hiding the pane must
// hide the page, not just paint a cover under it.
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<title>Private</title><body style='background:#fde'><h1>private page</h1></body>");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
await win.keyboard.press(process.platform === "darwin" ? "Meta+Shift+B" : "Control+Alt+B");
await win.waitForSelector(".pane-browser .browser-address", { timeout: 10000 });
await win.fill(".pane-browser .browser-address", `http://127.0.0.1:${server.address().port}/`);
await win.press(".pane-browser .browser-address", "Enter");
const visiblePages = () =>
  win.$$eval(".browser-view", (els) => els.filter((w) => w.style.visibility === "visible").length);
let shown = 0;
for (let i = 0; i < 100 && shown !== 1; i++) { await sleep(100); shown = await visiblePages(); }
check("browser page is on screen", shown === 1);
const browserId = await win.$eval(".pane-browser", (e) => e.getAttribute("data-pane-id"));
await win.click(btn(browserId, "Hide pane content"));
await sleep(600);
check("hiding a browser pane hides its page", (await visiblePages()) === 0);
await shot("6-browser-hidden");
await win.click(btn(browserId, "Show pane content"));
await sleep(600);
check("showing it brings the page back", (await visiblePages()) === 1);
server.close();
await app.close();
try { fs.unlinkSync(sizeFile); } catch {}
const failed = results.filter((r) => !r).length;
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
