// Startup budget check for the "instant to open" pillar.
//
// Session restore adds work to the boot path, and the question that matters isn't
// whether the feature works but whether it costs anything measurable before you
// can type. This measures the two ends of the range:
//
//   cold     — nothing stored: a first run, the floor.
//   restored — 8 tabs, each with a serialized screen, and a screens file the size
//              a genuinely busy session produces.
//
// The delta is the number to watch. It should be small, because the design keeps
// it that way: the *layout* is read synchronously from localStorage (two
// kilobytes, and it must be — nothing can render before the window knows what it
// is), while the *screens* are read from a file the host owns, fired without being
// awaited, and each pane's replay is gated behind its own live output. So a
// multi-megabyte read happens beside the first shell spawning rather than in front
// of it.
//
// Only the active tab's panes mount, so only one pane's screen is replayed on
// boot however many tabs were restored — that is what keeps the restored case
// close to the cold one.
//
// Run: node test/perf-boot.mjs   (after `vite build`)
import { _electron as electron } from "playwright";
import { launchOptions } from "./launch.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[perf]", ...a);

const RUNS = Number(process.env.PERF_RUNS ?? 3);
const TABS = 8;
const SCREEN_BYTES = 250_000; // per pane; 8 of them ≈ 2MB, a busy session

// The regression gate. Generous on purpose: this runs on whatever machine happens
// to have it, and the point is to catch a *structural* mistake — a synchronous
// multi-megabyte parse sneaking back onto the boot path — not to police jitter.
const MAX_DELTA_MS = Number(process.env.PERF_MAX_DELTA_MS ?? 400);

// A realistic serialized screen: SGR runs plus text, which is the shape
// SerializeAddon emits.
function fakeScreen(bytes) {
  let s = "";
  while (s.length < bytes) {
    s +=
      `\x1b[38;5;${s.length % 255}m` +
      "nexfar@host:~/dev$ some command output line with colour\r\n";
  }
  return s.slice(0, bytes);
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function boot(profile) {
  const t0 = Date.now();
  const app = await electron.launch(launchOptions(root, profile));
  const win = await app.firstWindow();
  // The terminal's render surface existing is the closest observable proxy for
  // "there is a pane in front of you".
  await win.waitForSelector(".xterm-screen canvas", { timeout: 30000 });
  const painted = Date.now() - t0;
  // The same moment on the renderer's own clock, so renderer work can be compared
  // without the host's startup (and Playwright's launch overhead) mixed in.
  const paintedInPage = Math.round(await win.evaluate(() => performance.now()));
  const tabs = await win.evaluate(() => document.querySelectorAll(".tab").length);
  // Always logged, because it is what distinguishes "measured the restore" from
  // "measured a cold boot twice and reported a flattering delta" — which is how
  // this harness read on its first two attempts.
  const seen = await win.evaluate(() => ({
    nav: performance.getEntriesByType("navigation")[0]?.type,
    restore: Boolean(window.specterm?.windowBoot?.restore),
  }));
  log(`   boot saw nav=${seen.nav} tabs=${tabs} restore=${seen.restore}`);
  try {
    await Promise.race([app.close(), sleep(10000)]);
  } catch (_) {
    // best effort
  }
  try {
    app.process().kill("SIGKILL");
  } catch (_) {
    // already gone
  }
  return { painted, paintedInPage, tabs };
}

// Inflate the screens the app just wrote, keeping its own keys.
//
// The layout lives in the renderer's localStorage — a LevelDB the app owns — and
// there is no honest way to seed it from outside: writing it and then killing the
// app loses the write (Chromium flushes on its own schedule), while closing the app
// gracefully runs the exit save, which replaces whatever was seeded with the
// throwaway window's own single tab. Both roads end at a cold boot measured twice.
//
// So the app builds the real state itself — tabs opened through the UI, closed
// normally — and only the *screens file* is rewritten afterwards, under the keys
// the app chose. That is the one piece that can be made heavy from outside, and the
// one piece the measurement is about.
function inflateScreens(profile) {
  const file = path.join(profile, "session-screens.json");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const keys = Object.keys(parsed.screens ?? {});
  const screen = fakeScreen(SCREEN_BYTES);
  const screens = {};
  for (const k of keys) screens[k] = screen;
  fs.writeFileSync(file, JSON.stringify({ version: 1, screens }), "utf8");
  return keys.length;
}

const results = [];
try {
  // --- cold ----------------------------------------------------------------
  const coldTimes = [];
  const coldInPage = [];
  for (let i = 0; i < RUNS; i++) {
    const p = path.join(os.tmpdir(), `specterm-perf-cold-${Date.now()}-${i}`);
    fs.mkdirSync(p, { recursive: true });
    const r = await boot(p);
    coldTimes.push(r.painted);
    coldInPage.push(r.paintedInPage);
    fs.rmSync(p, { recursive: true, force: true });
  }
  log(
    `cold      painted: ${coldTimes.join(", ")} ms  median=${median(coldTimes)}ms  ` +
      `| in-page median=${median(coldInPage)}ms`
  );

  // --- restored ------------------------------------------------------------
  const restoredTimes = [];
  const restoredInPage = [];
  let restoredTabs = 0;
  for (let i = 0; i < RUNS; i++) {
    const p = path.join(os.tmpdir(), `specterm-perf-warm-${Date.now()}-${i}`);
    fs.mkdirSync(p, { recursive: true });

    // Build the session for real: open TABS tabs through the UI, so every one has a
    // live terminal and lands in the snapshot. (A tab that has been visited keeps
    // its terminal even once another tab is showing, which is why all of them get a
    // screen captured and not just the last.)
    const app = await electron.launch(launchOptions(root, p));
    const w = await app.firstWindow();
    await w.waitForSelector(".file-tree", { timeout: 30000 });
    await w.waitForTimeout(2500);
    for (let t = 1; t < TABS; t++) {
      await w.keyboard.press("Control+Shift+T");
      await w.waitForTimeout(900);
    }
    const built = await w.evaluate(() => document.querySelectorAll(".tab").length);
    if (built !== TABS) log(`   (built ${built}/${TABS} tabs)`);
    await w.waitForTimeout(2000);
    try {
      await Promise.race([app.close(), sleep(15000)]);
    } catch (_) {
      /* best effort */
    }
    try {
      app.process().kill("SIGKILL");
    } catch (_) {
      /* gone */
    }
    await sleep(1500);

    const inflated = inflateScreens(p);
    if (i === 0) {
      log(
        `   (session built by the app: ${built} tabs, ${inflated} screens inflated to ` +
          `${((inflated * SCREEN_BYTES) / 1024 / 1024).toFixed(1)}MB)`
      );
    }
    const r = await boot(p);
    restoredTimes.push(r.painted);
    restoredInPage.push(r.paintedInPage);
    restoredTabs = r.tabs;
    fs.rmSync(p, { recursive: true, force: true });
  }
  log(
    `restored  painted: ${restoredTimes.join(", ")} ms  median=${median(restoredTimes)}ms  ` +
      `| in-page median=${median(restoredInPage)}ms  (tabs=${restoredTabs})`
  );

  const delta = median(restoredTimes) - median(coldTimes);
  const inPageDelta = median(restoredInPage) - median(coldInPage);
  log(
    `delta: ${delta > 0 ? "+" : ""}${delta}ms wall, ` +
      `${inPageDelta > 0 ? "+" : ""}${inPageDelta}ms in-page  (budget ${MAX_DELTA_MS}ms)`
  );

  const restoredOk = restoredTabs === TABS;
  if (!restoredOk) log(`WARN  expected ${TABS} restored tabs, saw ${restoredTabs}`);
  results.push({ name: "restore stays inside the startup budget", pass: delta <= MAX_DELTA_MS });
  results.push({ name: "the heavy fixture actually restored", pass: restoredOk });
} catch (err) {
  log("ERROR", err?.stack || err);
  results.push({ name: "harness ran", pass: false });
}

const failed = results.filter((r) => !r.pass).length;
for (const r of results) log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}`);
log(`===== ${results.length - failed} passed, ${failed} failed =====`);
process.exit(failed === 0 ? 0 : 1);
