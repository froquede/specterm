// Copying a selection, in the app (src/lib/selection-text.ts and
// src/lib/selection-follow.ts).
//
// The join rules are tested on their own in test/selection-text.mjs. What needs
// a real app is the rest: that ⌘C (Ctrl+Shift+C here) copies through them, and
// that a selection made in a pane whose program redraws to scroll — Claude
// Code's transcript, less — stays on the text it was made on.
//
// The clipboard is read from the main process, the same clipboard the app
// writes to.
//
// Run: node test/e2e-selection.mjs   (after `vite build`)
import { _electron as electron } from "playwright";
import { launchOptions } from "./launch.mjs";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specterm-selection-"));
const app = await electron.launch(launchOptions(root, userDataDir));
const win = await app.firstWindow();
await win.waitForSelector(".xterm-screen", { timeout: 30000 });
await new Promise((r) => setTimeout(r, 2500));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const metrics = async () =>
  win.evaluate(() => {
    const screen = document.querySelector(".xterm-screen").getBoundingClientRect();
    const cell = document.querySelector(".xterm-helper-textarea").getBoundingClientRect();
    return { x: screen.x, y: screen.y, w: screen.width, cw: cell.width, ch: cell.height };
  });

async function drag(fromCol, fromRow, toCol, toRow) {
  const m = await metrics();
  const at = (col, row) => [m.x + m.cw * (col + 0.5), m.y + m.ch * (row + 0.5)];
  await win.mouse.move(...at(fromCol, fromRow));
  await win.mouse.down();
  await win.mouse.move(...at(toCol, toRow), { steps: 8 });
  await win.mouse.up();
  await sleep(300);
}

const copy = async () => {
  await win.keyboard.press(process.platform === "darwin" ? "Meta+c" : "Control+Shift+c");
  await sleep(400);
  return app.evaluate(({ clipboard }) => clipboard.readText());
};

const started = Date.now();
const elapsed = () => ((Date.now() - started) / 1000).toFixed(1).padStart(6);
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`[selection ${elapsed()}s] ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

await win.click(".xterm-screen");
const m = await metrics();
const cols = Math.round(m.w / m.cw);

// --- a command Claude Code wrapped ----------------------------------------
// Drawn the way Claude Code draws a tool call: the head row filled with words
// up to where the next one doesn't fit, the rest carried on with a cursor move
// to the indent, so xterm flags nothing as wrapped.
{
  const words = "gh pr view 95 --json body,files,commits,statusCheckRollup --jq .files --repo froquede/specterm --comments --web".split(" ");
  const head = "⏺ Bash(";
  let row0 = head + words[0];
  let i = 1;
  while (i < words.length && [...row0].length + 1 + words[i].length <= cols) row0 += " " + words[i++];
  const row1 = words.slice(i).join(" ") + ")";
  const want = head + words.join(" ") + ")";
  await app.evaluate(({ clipboard }) => clipboard.writeText("nothing-yet"));
  await win.keyboard.type(`clear; printf '%s\\n\\033[8G%s\\n' '${row0.replace("⏺", "*")}' '${row1}'`);
  await win.keyboard.press("Enter");
  await sleep(1200);
  await drag(0, 0, cols - 1, 1);
  const got = await copy();
  check(
    "a wrapped command copies as one line",
    got === want.replace("⏺", "*"),
    JSON.stringify(got)
  );
}

// --- the same rows, printed by a shell -------------------------------------
// Indent printed as spaces: two lines, exactly as before.
{
  await win.keyboard.type(
    `clear; printf '%s\\n%s\\n' "$(printf 'x%.0s' $(seq 1 ${cols}))" '       continued_by_a_long_enough_word'`
  );
  await win.keyboard.press("Enter");
  await sleep(1200);
  await drag(0, 0, cols - 1, 1);
  const got = await copy();
  check(
    "a shell's indented line stays a line",
    got === "x".repeat(cols) + "\n       continued_by_a_long_enough_word",
    JSON.stringify(got)
  );
}

// --- a selection in a program that scrolls by redrawing ---------------------
// A full-screen program with the mouse grabbed paints twenty rows, then paints
// them again three rows further up, then paints something else entirely.
{
  const line = (n) => `line ${n} of the transcript`;
  await win.keyboard.type(
    "clear; printf '\\033[?1049h\\033[?1000h\\033[?1006h\\033[H';" +
      " for i in $(seq 1 20); do echo \"line $i of the transcript\"; done; sleep 4;" +
      " printf '\\033[H\\033[2J'; for i in $(seq 4 23); do echo \"line $i of the transcript\"; done; sleep 4;" +
      " printf '\\033[H\\033[2J'; for i in $(seq 40 59); do echo \"line $i of the transcript\"; done; sleep 30"
  );
  await win.keyboard.press("Enter");
  await sleep(1000);
  await drag(0, 9, line(10).length, 9);
  await sleep(4000);
  await win.screenshot({ path: path.join(root, "test", "shot-selection-followed.png") });
  check("after the redraw, it copies the text it was made on", (await copy()) === line(10), await copy());
  await sleep(4000);
  await win.screenshot({ path: path.join(root, "test", "shot-selection-gone.png") });
  check("with the text gone, it still copies what was selected", (await copy()) === line(10), await copy());
  await win.keyboard.press("Control+c");
  await sleep(300);
  await win.keyboard.type("printf '\\033[?1000l\\033[?1006l\\033[?1049l'");
  await win.keyboard.press("Enter");
  await sleep(500);
}

await app.close();
fs.rmSync(userDataDir, { recursive: true, force: true });
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed in ${elapsed()}s`);
process.exit(results.every(Boolean) ? 0 : 1);
