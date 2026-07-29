// End-to-end suite for session continuity — the two independent mechanisms that
// answer "put it back the way it was", and which fail in different situations:
//
//   1. **Detaching.** Closing a window hands its shells to the host instead of
//      killing them. Nothing is restored because nothing stopped: reattaching
//      adopts the same PTYs. Covers closing a window and quitting-by-habit.
//      Dies with the process — an explicit Quit, a crash, a reboot.
//   2. **The on-disk snapshot.** Layout, directories, names and each pane's
//      serialized screen, replayed into fresh shells on the next launch. Covers
//      exactly what detaching can't.
//
// Kept out of e2e.mjs because both halves need the app closed and reopened, and
// that suite is one long-lived launch already sitting close to its time budget.
//
// Two traps this suite exists to stay out of, both of which produce a green run
// that proves nothing:
//
//   - A *backgrounded* probe (`( ... ) &`) outlives the shell that started it, so
//     it keeps ticking even when detaching is completely broken. Every probe here
//     runs in the foreground.
//   - A renderer-side `window.close()` goes through CDP and *destroys* the
//     window, which skips the `close` event the whole detach path hangs off. The
//     close must be driven through `BrowserWindow.close()`, the X button's path.
import { _electron as electron } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const started = Date.now();
const elapsed = () => ((Date.now() - started) / 1000).toFixed(1).padStart(6);
const log = (...a) => console.log(`[session ${elapsed()}s]`, ...a);

const results = [];
let lastCheckAt = Date.now();
const check = (name, pass, detail = "") => {
  results.push({ name, pass, skipped: false });
  const took = ((Date.now() - lastCheckAt) / 1000).toFixed(1);
  lastCheckAt = Date.now();
  log(
    `${pass ? "PASS" : "FAIL"}  ${name}  (+${took}s)${detail ? "  — " + detail : ""}`
  );
};

const HARD_TIMEOUT_MS =
  process.env.E2E_TIMEOUT_MS !== undefined
    ? Number(process.env.E2E_TIMEOUT_MS)
    : 420000;
const hard =
  HARD_TIMEOUT_MS > 0 &&
  setTimeout(() => {
    console.error("[session] HARD TIMEOUT");
    process.exit(2);
  }, HARD_TIMEOUT_MS);
if (hard) hard.unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One profile for the whole file: the on-disk snapshot lives in localStorage
// under the user-data dir, so the relaunch half has to see what the first half
// wrote.
const userDataDir = path.join(os.tmpdir(), `specterm-session-${process.pid}-${Date.now()}`);
fs.mkdirSync(userDataDir, { recursive: true });

const launch = () =>
  electron.launch({ args: [root, `--user-data-dir=${userDataDir}`], cwd: root });

const kill = async (app) => {
  try {
    // Generous: app.close() has to let the renderer finish writing the snapshot on
    // its way out, and killing it early produces a half-written session that looks
    // like a product bug.
    await Promise.race([app.close(), sleep(15000)]);
  } catch (_) {
    // Best effort; the kill below is the backstop.
  }
  try {
    app.process().kill("SIGKILL");
  } catch (_) {
    // already gone
  }
};

// Probe the terminal buffer through the app's own find bar and read its
// "index/total" counter. The only route to buffer text that doesn't involve
// scraping a WebGL canvas.
async function findCount(win, needle) {
  await win.locator(".xterm-helper-textarea:visible").first().click({ force: true });
  await win.keyboard.press("Control+Shift+F");
  await win.waitForSelector(".term-search-input", { timeout: 6000 });
  await win.locator(".term-search-input").fill(needle);
  await win.waitForTimeout(1200);
  const text = await win.locator(".term-search-count").textContent();
  await win.keyboard.press("Escape");
  return text?.trim() ?? "";
}
const foundSomething = (count) => /\/[1-9]/.test(count);

try {
  // ======================================================================
  // Part 1 — detaching: closing a window doesn't stop its shells
  // ======================================================================
  const ticks = path.join(userDataDir, "ticks.txt");
  const countTicks = () => {
    try {
      return fs.readFileSync(ticks, "utf8").trim().split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  };

  const app = await launch();
  const nWindows = () =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const closeFirstWindow = () =>
    app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });

  const winA = await app.firstWindow();
  winA.on("pageerror", (e) => log("PAGEERROR:", e.message));
  await winA.waitForSelector(".file-tree", { timeout: 20000 });
  await winA.waitForTimeout(3000);

  // Foreground, so its life is tied to the shell's. See the header.
  await winA.locator(".xterm-helper-textarea:visible").first().click({ force: true });
  await winA.keyboard.type(
    `for i in $(seq 1 900); do echo tick >> ${ticks}; sleep 1; done`
  );
  await winA.keyboard.press("Enter");
  await winA.waitForTimeout(5000);

  const atOpen = countTicks();
  check("a foreground process runs in the pane", atOpen > 1, `ticks=${atOpen}`);

  // A second window, so Playwright keeps a page to drive after the first closes.
  await winA.evaluate(() => window.specterm.newWindow());
  await sleep(6000);
  check("a second window opens", (await nWindows()) === 2, `windows=${await nWindows()}`);

  await closeFirstWindow();
  await sleep(8000);
  check("the closed window is gone", (await nWindows()) === 1, `windows=${await nWindows()}`);

  const survivor = (await app.windows())[0];
  const parked = await survivor.evaluate(() => window.specterm.detachedSessionCount());
  check("closing a window parks its session", parked === 1, `parked=${parked}`);

  const afterClose = countTicks();
  check(
    "its shell keeps running after the window closed",
    afterClose > atOpen + 3,
    `ticks ${atOpen} → ${afterClose}`
  );

  const didReattach = await survivor.evaluate(() => window.specterm.reattachSession());
  check("reattach reports success", didReattach === true, `returned=${didReattach}`);
  await sleep(7000);
  check(
    "reattaching gives the session a window again",
    (await nWindows()) === 2,
    `windows=${await nWindows()}`
  );

  const beforeWait = countTicks();
  await sleep(4000);
  check(
    "the reattached pane holds the same running shell",
    countTicks() > beforeWait + 1,
    `ticks ${beforeWait} → ${countTicks()}`
  );

  // The typed command exists only in that pane's buffer, so finding it proves the
  // PTY was adopted and the screen carried across rather than a shell respawned.
  let reattachedCount = null;
  for (const w of await app.windows()) {
    try {
      await w.waitForSelector(".file-tree", { timeout: 8000 });
      const c = await findCount(w, "seq 1 900");
      if (foundSomething(c)) {
        reattachedCount = c;
        break;
      }
    } catch (_) {
      // not this window
    }
  }
  check(
    "the reattached pane still shows its scrollback",
    reattachedCount !== null,
    `count=${reattachedCount}`
  );

  // Every window closed: the app must stay alive holding the shells. Inferred
  // from the ticks, not the pid — Playwright's debugger keeps the process alive
  // past a real quit, so the pid proves nothing, while window-all-closed kills
  // every PTY when it decides to quit.
  await closeFirstWindow();
  await sleep(7000);
  await closeFirstWindow();
  await sleep(8000);
  check("all windows can be closed", (await nWindows()) === 0, `windows=${await nWindows()}`);

  const bg = countTicks();
  await sleep(5000);
  check(
    "shells keep running with no window open at all",
    countTicks() > bg + 1,
    `ticks ${bg} → ${countTicks()}`
  );

  // The dock-click route back in (the tray's click handler runs the same code).
  await app.evaluate(({ app: electronApp }) => electronApp.emit("activate"));
  await sleep(7000);
  check(
    "activating with no windows reattaches a session",
    (await nWindows()) >= 1,
    `windows=${await nWindows()}`
  );

  // Set up Part 2 while a window is open: a marker in the buffer, a renamed tab,
  // and a distinctive OSC title that must survive a restart.
  //
  // The title is set by a command that then blocks, because a shell whose prompt
  // re-runs (bash's PROMPT_COMMAND does) would immediately overwrite it — so the
  // custom title has to be the last one the shell reported.
  const MARKER = "SPECTERM_SESSION_MARKER_4c7b";
  const TAB_NAME = "renamed-tab";
  const PANE_TITLE = "CUSTOM_PANE_TITLE";

  const win = (await app.windows())[0];
  await win.waitForSelector(".file-tree", { timeout: 20000 });
  await win.waitForTimeout(2000);

  await win.keyboard.press("F2");
  await win.waitForSelector(".tab-title-input", { timeout: 6000 });
  await win.locator(".tab-title-input").first().fill(TAB_NAME);
  await win.keyboard.press("Enter");
  await win.waitForTimeout(1200);
  const renamedTo = await win.locator(".tab").first().innerText();
  check(
    "the tab can be renamed",
    renamedTo.includes(TAB_NAME),
    `title=${JSON.stringify(renamedTo)}`
  );

  await win.locator(".xterm-helper-textarea:visible").first().click({ force: true });
  await win.keyboard.type(`echo ${MARKER}`);
  await win.keyboard.press("Enter");
  await win.waitForTimeout(2500);

  check(
    "the marker is on screen before the restart",
    foundSomething(await findCount(win, MARKER)),
    ""
  );

  await win.locator(".xterm-helper-textarea:visible").first().click({ force: true });
  await win.keyboard.type(`printf '\\033]0;${PANE_TITLE}\\007'; sleep 600`);
  await win.keyboard.press("Enter");
  await win.waitForTimeout(2000);
  const paneTitleBefore = await win.locator(".pane-title").first().innerText();
  check(
    "the pane picked up the shell's OSC title",
    paneTitleBefore.includes(PANE_TITLE),
    `title=${JSON.stringify(paneTitleBefore)}`
  );

  // Let the layout snapshot's debounce settle, as a real quit would.
  await win.waitForTimeout(2000);

  // ======================================================================
  // Part 2 — the on-disk snapshot: what survives the process dying
  // ======================================================================
  // app.close() quits properly, which is the path that must NOT detach: an
  // explicit Quit ends the shells and leaves only the snapshot.
  await kill(app);

  const app2 = await launch();
  try {
    const win2 = await app2.firstWindow();
    win2.on("pageerror", (e) => log("PAGEERROR(restored):", e.message));
    await win2.waitForSelector(".file-tree", { timeout: 20000 });
    await win2.waitForTimeout(4000);

    // Always logged. When one of the checks below fails, the interesting question
    // is which of the two blobs is missing or stale — and answering it from a bare
    // "FAIL" means running the whole 80-second suite again with a print in it.
    const diag = await win2.evaluate(() => {
      const sess = localStorage.getItem("specterm.session");
      const scr = localStorage.getItem("specterm.session.screens");
      let parsed = null;
      try {
        parsed = sess ? JSON.parse(sess) : null;
      } catch (_) {
        parsed = "unparseable";
      }
      return {
        sessionBytes: sess?.length ?? 0,
        screenBytes: scr?.length ?? 0,
        tabs: Array.isArray(parsed?.tabs) ? parsed.tabs.length : null,
        firstTab: parsed?.tabs?.[0] ? JSON.stringify(parsed.tabs[0]) : null,
        navType: performance.getEntriesByType("navigation")[0]?.type,
        ownsSession: window.specterm?.windowBoot?.ownsSession,
      };
    });
    log("restored-window state:", JSON.stringify(diag));

    const stored = await win2.evaluate((marker) => {
      const raw = localStorage.getItem("specterm.session.screens");
      if (!raw) return { present: false };
      return { present: true, bytes: raw.length, hasMarker: raw.includes(marker) };
    }, MARKER);
    check(
      "the screens were written on quit and hold the marker",
      stored.present && stored.hasMarker,
      JSON.stringify(stored)
    );

    check(
      "a restored pane replays the screen it had",
      foundSomething(await findCount(win2, MARKER)),
      ""
    );

    const tabTitle = await win2.locator(".tab").first().innerText();
    check(
      "a renamed tab keeps its name across a restart",
      tabTitle.includes(TAB_NAME),
      `title=${JSON.stringify(tabTitle)}`
    );

    const paneTitle = await win2.locator(".pane-title").first().innerText();
    check(
      "a restored pane keeps its name instead of the new shell's",
      paneTitle.includes(PANE_TITLE),
      `title=${JSON.stringify(paneTitle)}`
    );

    await win2.screenshot({ path: path.join(root, "test", "shot-restored.png") });
  } finally {
    await kill(app2);
  }

  const failed = results.filter((r) => !r.pass).length;
  const skipped = results.filter((r) => r.skipped).length;
  const passed = results.length - failed - skipped;
  log(
    `\n===== ${passed} passed, ${failed} failed, ${skipped} skipped (${process.platform}) =====`
  );
  fs.writeFileSync(
    path.join(root, "test", "e2e-session-result.json"),
    JSON.stringify({ platform: process.platform, results }, null, 2)
  );

  if (hard) clearTimeout(hard);
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch (_) {
    // temp dir; the OS will get it
  }
  process.exit(failed === 0 ? 0 : 1);
} catch (err) {
  console.error("[session] HARNESS ERROR", err?.stack || err);
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch (_) {
    // nothing to do
  }
  process.exit(3);
}
