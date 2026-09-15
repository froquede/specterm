// Click-to-copy for paths and links (src/lib/terminal-links.ts).
//
// The matching is tested on its own in test/path-links.mjs; what needs a real
// app is everything around it — that a hovered span maps back to the right
// cells, that a soft-wrapped path copies whole, and above all that a pane whose
// program owns the mouse and redraws in place still answers a click. That last
// pair is why this doesn't ride on xterm's linkifier, so it is the pair worth
// having a suite for.
//
// The clipboard is read from the main process, which is the same clipboard the
// app writes to — no renderer-side stubbing anywhere in here.
//
// Run: node test/e2e-links.mjs   (after `vite build`)
import { _electron as electron } from "playwright";
import { launchOptions } from "./launch.mjs";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specterm-links-"));
const app = await electron.launch(launchOptions(root, userDataDir));
const win = await app.firstWindow();
await win.waitForSelector(".xterm-screen", { timeout: 30000 });
await new Promise((r) => setTimeout(r, 2500));

const metrics = async () =>
  win.evaluate(() => {
    const screen = document.querySelector(".xterm-screen").getBoundingClientRect();
    const cell = document.querySelector(".xterm-helper-textarea").getBoundingClientRect();
    return { x: screen.x, y: screen.y, cw: cell.width, ch: cell.height };
  });

async function clickCell(col, row) {
  const m = await metrics();
  await win.mouse.move(m.x + m.cw * (col + 0.5), m.y + m.ch * (row + 0.5));
  await new Promise((r) => setTimeout(r, 400));
  await win.mouse.down();
  await win.mouse.up();
  await new Promise((r) => setTimeout(r, 900));
}

async function modifierClickCell(col, row) {
  const m = await metrics();
  await win.mouse.move(m.x + m.cw * (col + 0.5), m.y + m.ch * (row + 0.5));
  await new Promise((r) => setTimeout(r, 400));
  await win.keyboard.down("Control");
  await win.mouse.down();
  await win.mouse.up();
  await win.keyboard.up("Control");
  await new Promise((r) => setTimeout(r, 600));
}

const clip = () => app.evaluate(({ clipboard }) => clipboard.readText());
const started = Date.now();
const elapsed = () => ((Date.now() - started) / 1000).toFixed(1).padStart(6);
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`[links ${elapsed()}s] ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

async function echoLine(text) {
  await win.keyboard.type(`clear; echo ${text}`);
  await win.keyboard.press("Enter");
  await new Promise((r) => setTimeout(r, 1200));
}

await app.evaluate(({ clipboard }) => clipboard.writeText("nothing-yet"));
await win.click(".xterm-screen");

await echoLine("/tmp/spec-link/aaa.txt");
await clickCell(5, 0);
check("path click copies", (await clip()) === "/tmp/spec-link/aaa.txt", await clip());
check("flash shown", (await win.locator(".copy-flash").count()) === 1);

await echoLine("https://example.com/a/b");
await clickCell(5, 0);
check("url click copies", (await clip()) === "https://example.com/a/b", await clip());

await echoLine("available 24/7 today");
await clickCell(11, 0);
check("non-path click copies nothing", (await clip()) === "https://example.com/a/b", await clip());

// Printed with its quotes, the way a shell error quotes a path with a space.
await echoLine(`'"/tmp/spec link/notes.md"'`);
await clickCell(6, 0);
check("quoted path with a space", (await clip()) === "/tmp/spec link/notes.md", await clip());

// A path longer than the pane is wide: it soft-wraps, and clicking either row
// has to copy the whole thing.
const long = "/tmp/" + "dir/".repeat(40) + "end.txt";
await echoLine(long);
await clickCell(10, 0);
check("wrapped path copies whole", (await clip()) === long, (await clip()).slice(0, 40));
await clickCell(3, 1);
check("wrapped path second row", (await clip()) === long, (await clip()).slice(0, 40));

// The case xterm's own linkifier gets wrong, and the reason this doesn't use
// it: the pointer rests on a row with nothing clickable, the program redraws
// that row, and the path drawn there has to become clickable without the
// pointer moving off the row.
await win.keyboard.type("clear; echo available 24/7 today");
await win.keyboard.press("Enter");
await new Promise((r) => setTimeout(r, 1200));
{
  const m = await metrics();
  await win.mouse.move(m.x + m.cw * 11.5, m.y + m.ch * 0.5);
}
await new Promise((r) => setTimeout(r, 500));
await app.evaluate(({ clipboard }) => clipboard.writeText("before-redraw"));
await win.keyboard.type("clear; echo /tmp/redrawn/here.txt");
await win.keyboard.press("Enter");
await new Promise((r) => setTimeout(r, 1500));
await win.mouse.down();
await win.mouse.up();
await new Promise((r) => setTimeout(r, 900));
check("row redrawn under a still pointer", (await clip()) === "/tmp/redrawn/here.txt", await clip());


// Ctrl+click opens instead of copying. A path that no longer exists is the one
// case that can be driven here: opening a real file would hand the machine to
// whatever application claims that type, in the middle of a test run.
await echoLine("/tmp/specterm-no-such-dir/nope.txt");
await app.evaluate(({ clipboard }) => clipboard.writeText("untouched"));
await modifierClickCell(6, 0);
check("modifier click doesn't copy", (await clip()) === "untouched", await clip());
const flashText = await win
  .locator(".copy-flash")
  .first()
  .textContent({ timeout: 2000 })
  .catch(() => "");
check(
  "missing file is reported",
  (flashText ?? "").includes("/tmp/specterm-no-such-dir/nope.txt"),
  flashText ?? "(no flash)"
);

// A file Specterm can display opens where you are looking: a pane split off
// this one, in this window — not a tab, not a second copy of the app, and not
// somebody else's editor.
const mdPath = path.join(os.tmpdir(), `specterm-link-${process.pid}.md`);
fs.writeFileSync(mdPath, "# LINKED_MARKDOWN_OK\n\nbody\n");
const panesBefore = await win.evaluate(() => document.querySelectorAll(".pane").length);
const tabsBefore = await win.evaluate(() => document.querySelectorAll(".tab").length);
await echoLine(mdPath);
await modifierClickCell(6, 0);
await win.waitForSelector(".markdown-content", { timeout: 8000 }).catch(() => {});
const opened = await win.evaluate(() => ({
  panes: document.querySelectorAll(".pane").length,
  tabs: document.querySelectorAll(".tab").length,
  windows: 1,
  text: document.querySelector(".markdown-content")?.textContent ?? "",
}));
check("markdown opens in a new pane", opened.panes === panesBefore + 1, `panes ${panesBefore} → ${opened.panes}`);
check("it is that file", opened.text.includes("LINKED_MARKDOWN_OK"), opened.text.slice(0, 40));
check("no new tab was made", opened.tabs === tabsBefore, `tabs ${tabsBefore} → ${opened.tabs}`);
check("no second window", (await app.windows()).length === 1, `windows=${(await app.windows()).length}`);
fs.rmSync(mdPath, { force: true });

// The shapes a TUI draws: a frame rule hard against the path, an agent's file
// mention, and a pane whose program has grabbed the mouse.
await win.keyboard.type(
  `clear; printf '\\342\\224\\202 Read @src/lib/foo.ts:12 \\342\\224\\202\\n'; printf '\\033[?1003h\\033[?1006h'`
);
await win.keyboard.press("Enter");
await new Promise((r) => setTimeout(r, 1500));
await clickCell(10, 0);
check("path in a framed row, mouse grabbed", (await clip()) === "src/lib/foo.ts:12", await clip());


await app.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed in ${elapsed()}s`);
process.exit(results.every(Boolean) ? 0 : 1);
