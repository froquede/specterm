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
import { launchOptions } from "./launch.mjs";
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

// Wait for a condition instead of for the clock.
//
// Almost every sleep in this file was really "however long a window takes to
// open, close, or come back on the slowest machine this might run on" — a
// number chosen for the worst case and then paid on every machine, on every
// run. Waiting on the condition keeps the same worst case as the deadline and
// gives the time back everywhere else. It also throws instead of continuing,
// so a window that never appears fails here rather than three checks later.
async function until(what, predicate, { timeout = 20000, poll = 100 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let ok = false;
    try {
      ok = await predicate();
    } catch (_) {
      ok = false;
    }
    if (ok) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeout}ms waiting for: ${what}`);
    }
    await sleep(poll);
  }
}

// One profile for the whole file: the on-disk snapshot lives in localStorage
// under the user-data dir, so the relaunch half has to see what the first half
// wrote.
const userDataDir = path.join(os.tmpdir(), `specterm-session-${process.pid}-${Date.now()}`);
fs.mkdirSync(userDataDir, { recursive: true });

const launch = () =>
  electron.launch(launchOptions(root, userDataDir));

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
  await until("the first pane to paint", () =>
    winA.evaluate(() => !!document.querySelector(".xterm-screen canvas"))
  );

  // Foreground, so its life is tied to the shell's. See the header.
  await winA.locator(".xterm-helper-textarea:visible").first().click({ force: true });
  await winA.keyboard.type(
    `for i in $(seq 1 900); do echo tick >> ${ticks}; sleep 1; done`
  );
  await winA.keyboard.press("Enter");
  // The loop writes a line a second, so this is a few seconds — not the five it
  // used to be, but not instant either: the point of the section is what happens
  // to a *running* shell, and three ticks is the difference between having one
  // and having just pressed Enter.
  await until("the tick loop to get going", () => countTicks() > 2, { timeout: 20000 });

  const atOpen = countTicks();
  check("a foreground process runs in the pane", atOpen > 1, `ticks=${atOpen}`);

  // A second window, so Playwright keeps a page to drive after the first closes.
  await winA.evaluate(() => window.specterm.newWindow());
  await until("a second window", async () => (await nWindows()) === 2);
  // …and wait for it to be a finished window, not just a created one. Closing
  // the first while the second is still wiring itself up is not what this
  // section is about, and the handover it would race is the very thing being
  // measured two checks below.
  await until("the second window to finish booting", async () => {
    const pages = await app.windows();
    const other = pages.find((p) => p !== winA);
    if (!other) return false;
    return other.evaluate(() => !!document.querySelector(".xterm-screen canvas"));
  });
  check("a second window opens", (await nWindows()) === 2, `windows=${await nWindows()}`);

  await closeFirstWindow();
  // Both counts, and in this order: the host's, which says the window is gone,
  // and Playwright's page list, which catches up a moment later — reaching for
  // `windows()[0]` before it does hands back the page that just died.
  await until("the first window to go", async () => (await nWindows()) === 1);
  await until(
    "the driver's page list to catch up",
    async () => (await app.windows()).length === 1
  );
  check("the closed window is gone", (await nWindows()) === 1, `windows=${await nWindows()}`);

  const survivor = (await app.windows())[0];
  // The window being gone and its shells being parked are two different moments.
  // Waited for rather than slept through, but with the check below still doing
  // the asserting: a timeout here should read as "it never parked", not as a
  // harness error.
  await until("its session to be parked", async () =>
    (await survivor.evaluate(() => window.specterm.detachedSessionCount())) === 1
  ).catch(() => {});
  const parked = await survivor.evaluate(() => window.specterm.detachedSessionCount());
  check("closing a window parks its session", parked === 1, `parked=${parked}`);

  // The shell has to keep ticking now that nothing is watching it, which takes
  // as long as it takes: wait for the ticks to arrive, but let the check do the
  // asserting so a shell that died reads as "ticks 3 → 3" rather than as a
  // harness error.
  await until(
    "the parked shell to keep ticking",
    () => countTicks() > atOpen + 3,
    { timeout: 15000 }
  ).catch(() => {});
  const afterClose = countTicks();
  check(
    "its shell keeps running after the window closed",
    afterClose > atOpen + 3,
    `ticks ${atOpen} → ${afterClose}`
  );

  const didReattach = await survivor.evaluate(() => window.specterm.reattachSession());
  check("reattach reports success", didReattach === true, `returned=${didReattach}`);
  await until("the reattached window", async () => (await nWindows()) === 2);
  check(
    "reattaching gives the session a window again",
    (await nWindows()) === 2,
    `windows=${await nWindows()}`
  );

  const beforeWait = countTicks();
  await until(
    "the reattached shell to keep ticking",
    () => countTicks() > beforeWait + 1,
    { timeout: 15000 }
  ).catch(() => {});
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
  await until("one window left", async () => (await nWindows()) === 1);
  await closeFirstWindow();
  await until("no windows left", async () => (await nWindows()) === 0);
  check("all windows can be closed", (await nWindows()) === 0, `windows=${await nWindows()}`);

  const bg = countTicks();
  await until(
    "the windowless shell to keep ticking",
    () => countTicks() > bg + 1,
    { timeout: 15000 }
  ).catch(() => {});
  check(
    "shells keep running with no window open at all",
    countTicks() > bg + 1,
    `ticks ${bg} → ${countTicks()}`
  );

  // The dock-click route back in (the tray's click handler runs the same code).
  await app.evaluate(({ app: electronApp }) => electronApp.emit("activate"));
  await until("a window to come back", async () => (await nWindows()) >= 1);
  // …and for the driver to have a page for it. Reaching into `windows()[0]`
  // before that is what the undefined below would have been.
  await until(
    "the driver to see the reattached window",
    async () => (await app.windows()).length >= 1
  );
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
  await until("the pane to paint", () =>
    win.evaluate(() => !!document.querySelector(".xterm-screen canvas"))
  );

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
    const first2 = await app2.firstWindow();
    await first2.waitForSelector(".file-tree", { timeout: 20000 });

    // More than one window can come back here, and that is correct: the phases
    // above left a session parked, and a detached window is part of the saved
    // session too — its shells died with the quit, but you hadn't finished with it.
    // So the window carrying the renamed tab has to be *found* rather than
    // assumed to be the first one — and looked for until it turns up, since the
    // windows do not all finish restoring at the same moment.
    let win2 = null;
    await until(
      `the restored window carrying "${TAB_NAME}"`,
      async () => {
        for (const page of await app2.windows()) {
          try {
            if (!(await page.evaluate(() => !!document.querySelector(".tab")))) continue;
            const title = await page.locator(".tab").first().innerText();
            if (title.includes(TAB_NAME)) {
              win2 = page;
              return true;
            }
          } catch (_) {
            // this window is still coming up
          }
        }
        return false;
      },
      { timeout: 30000 }
    ).catch(() => {
      // Fall through with the first window; the checks below report what they
      // actually found, which is more useful than dying here.
    });
    const pages = await app2.windows();
    win2 = win2 ?? pages[0];
    win2.on("pageerror", (e) => log("PAGEERROR(restored):", e.message));
    await win2.waitForTimeout(2000);

    // Always logged. When one of the checks below fails, the interesting question is
    // which of the two blobs is missing or stale — and answering it from a bare
    // "FAIL" means running the whole suite again with a print in it. The layout is a
    // file the host owns now, so it is read from disk rather than localStorage.
    let sessionFile = { present: false };
    try {
      const raw = fs.readFileSync(path.join(userDataDir, "session.json"), "utf8");
      const parsed = JSON.parse(raw);
      sessionFile = {
        present: true,
        bytes: raw.length,
        windows: parsed.windows?.length ?? 0,
        titles: (parsed.windows ?? []).map((wn) =>
          (wn.tabs ?? []).map((t) => t.title).join("|")
        ),
      };
    } catch (_) {
      sessionFile = { present: false };
    }
    const diag = {
      sessionFile,
      restoredWindows: pages.length,
      legacyScreensKey: await win2.evaluate(
        () => localStorage.getItem("specterm.session.screens") !== null
      ),
      legacySessionKey: await win2.evaluate(
        () => localStorage.getItem("specterm.session") !== null
      ),
    };
    log("restored state:", JSON.stringify(diag));
    check(
      "the host wrote a session naming the windows it saved",
      sessionFile.present && sessionFile.windows >= 1,
      JSON.stringify(sessionFile)
    );
    check(
      "nothing is left in the localStorage key the layout used to live in",
      diag.legacySessionKey === false,
      `legacyKey=${diag.legacySessionKey}`
    );

    // The screens are a file the main process owns now, not a localStorage blob —
    // so this reads the file, which is also the check that it landed at all
    // (the write is fired as the window goes away and completed host-side).
    const screensFile = path.join(userDataDir, "session-screens.json");
    let onDisk = { present: false };
    try {
      const raw = fs.readFileSync(screensFile, "utf8");
      onDisk = { present: true, bytes: raw.length, hasMarker: raw.includes(MARKER) };
    } catch (_) {
      onDisk = { present: false };
    }
    check(
      "the screens were written to disk on quit and hold the marker",
      onDisk.present && onDisk.hasMarker,
      JSON.stringify(onDisk)
    );
    check(
      "nothing is left in the localStorage key screens used to live in",
      diag.legacyScreensKey === false,
      `legacyKey=${diag.legacyScreensKey}`
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

  // ======================================================================
  // Part 2b — every window comes back, where it was
  // ======================================================================
  // The saved session is one entry per window now, assembled by the host. Quitting
  // with three windows open used to bring one back.
  const multiDir = path.join(os.tmpdir(), `specterm-multi-${Date.now()}`);
  fs.mkdirSync(multiDir, { recursive: true });
  const multiLaunch = () =>
    electron.launch(launchOptions(root, multiDir));

  const appM = await multiLaunch();
  let placed = [];
  try {
    const w = await appM.firstWindow();
    await w.waitForSelector(".file-tree", { timeout: 20000 });
    await until("the pane to paint", () =>
      w.evaluate(() => !!document.querySelector(".xterm-screen canvas"))
    );
    // Three windows, each at a distinct position and size, and each with a
    // different number of tabs so they can be told apart after the restart.
    const nWins = () =>
      appM.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    await w.evaluate(() => window.specterm.newWindow());
    await until("a second window", async () => (await nWins()) === 2);
    await w.evaluate(() => window.specterm.newWindow());
    await until("a third window", async () => (await nWins()) === 3);
    check(
      "three windows are open",
      (await appM.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 3,
      ""
    );

    placed = await appM.evaluate(({ BrowserWindow }) => {
      const wins = BrowserWindow.getAllWindows();
      const boxes = [
        { x: 60, y: 60, width: 900, height: 600 },
        { x: 200, y: 140, width: 1000, height: 640 },
        { x: 340, y: 220, width: 820, height: 560 },
      ];
      wins.forEach((win, i) => win.setBounds(boxes[i]));
      return wins.map((win) => win.getBounds());
    });
    await sleep(1500);

    // Give the middle window a second tab, so window identity is checkable.
    const pages = await appM.windows();
    await pages[1].keyboard.press("Control+Shift+T");
    await until("the second tab", async () =>
      (await pages[1].evaluate(() => document.querySelectorAll(".tab").length)) === 2
    );

    // Let the layout debounce settle, then quit properly — the host writes the
    // session on before-quit, while the windows are still open and measurable.
    await sleep(2000);
  } finally {
    await kill(appM);
  }

  const appM2 = await multiLaunch();
  try {
    await appM2.firstWindow();
    await sleep(6000);
    const restored = await appM2.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => ({
        bounds: w.getBounds(),
      }))
    );
    check(
      "quitting with three windows open reopens three",
      restored.length === 3,
      `windows=${restored.length}`
    );

    // Geometry: every saved rectangle should come back. Compared as a set, since
    // the order windows are recreated in isn't part of the promise.
    const key = (b) => `${b.width}x${b.height}+${b.x}+${b.y}`;
    const want = new Set(placed.map(key));
    const got = restored.map((r) => key(r.bounds));
    const matched = got.filter((g) => want.has(g)).length;
    check(
      "each window comes back at the size and position it had",
      matched === placed.length,
      `matched ${matched}/${placed.length}: wanted ${[...want].join(" ")} got ${got.join(" ")}`
    );

    const tabCounts = [];
    for (const page of await appM2.windows()) {
      try {
        await page.waitForSelector(".file-tree", { timeout: 15000 });
        tabCounts.push(await page.evaluate(() => document.querySelectorAll(".tab").length));
      } catch (_) {
        tabCounts.push(-1);
      }
    }
    tabCounts.sort((a, b) => a - b);
    check(
      "each window comes back with its own tabs",
      tabCounts.join(",") === "1,1,2",
      `tabs per window = ${tabCounts.join(",")}`
    );
  } finally {
    await kill(appM2);
    try {
      fs.rmSync(multiDir, { recursive: true, force: true });
    } catch (_) {
      // temp dir
    }
  }

  // ======================================================================
  // Part 3 — teardown safety: the two ways this can leak or trap you
  // ======================================================================
  // Its own profile and its own app, because both checks end the process and one
  // of them deliberately wedges a renderer.
  const safetyDir = path.join(os.tmpdir(), `specterm-safety-${Date.now()}`);
  fs.mkdirSync(safetyDir, { recursive: true });
  const safetyTicks = path.join(safetyDir, "ticks.txt");
  const countSafetyTicks = () => {
    try {
      return fs
        .readFileSync(safetyTicks, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean).length;
    } catch {
      return 0;
    }
  };

  const app3 = await electron.launch(launchOptions(root, safetyDir));
  try {
    const w = await app3.firstWindow();
    await w.waitForSelector(".file-tree", { timeout: 20000 });
    await w.waitForTimeout(3000);
    await w.locator(".xterm-helper-textarea:visible").first().click({ force: true });
    await w.keyboard.type(
      `for i in $(seq 1 900); do echo tick >> ${safetyTicks}; sleep 1; done`
    );
    await w.keyboard.press("Enter");
    await w.waitForTimeout(5000);
    check(
      "the safety probe is running",
      countSafetyTicks() > 1,
      `ticks=${countSafetyTicks()}`
    );

    // Wedge the renderer so it can never answer the host's detach request. The
    // host detaches the PTYs before it serializes, so without the reaper these
    // shells would survive the window and have nothing left that could reattach
    // them — running forever with no route back.
    await w.evaluate(() => {
      setTimeout(() => {
        const t = Date.now();
        while (Date.now() - t < 25000) {
          /* block the renderer past the host's detach timeout */
        }
      }, 0);
    });
    await sleep(500);
    await app3.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    // Past the 4s detach timeout, with room for the reap. Everything from here is
    // asserted from the filesystem: with no window left and nothing parked the app
    // quits, which drops Playwright's connection — so app.evaluate is not
    // available to ask how many windows there are.
    await sleep(12000);
    const reaped = countSafetyTicks();
    await sleep(5000);
    check(
      "shells detached but never parked are reaped, not orphaned",
      countSafetyTicks() === reaped,
      `ticks stayed at ${reaped}`
    );
  } finally {
    await kill(app3);
  }

  // Alt+F4 must end the app rather than detach it — on Linux and Windows it is
  // the only keyboard route out, since the menu bar is hidden and Ctrl+Shift+Q is
  // Close Tab. (Under a real window manager the WM usually grabs Alt+F4 first and
  // turns it into a close request; there is no WM under xvfb, so the binding is
  // what gets exercised here.)
  const quitTicks = path.join(safetyDir, "quit-ticks.txt");
  const countQuitTicks = () => {
    try {
      return fs.readFileSync(quitTicks, "utf8").trim().split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  const app4 = await electron.launch(launchOptions(root, safetyDir));
  try {
    const w = await app4.firstWindow();
    await w.waitForSelector(".file-tree", { timeout: 20000 });
    await w.waitForTimeout(3000);
    await w.locator(".xterm-helper-textarea:visible").first().click({ force: true });
    await w.keyboard.type(
      `for i in $(seq 1 900); do echo tick >> ${quitTicks}; sleep 1; done`
    );
    await w.keyboard.press("Enter");
    await w.waitForTimeout(5000);
    check("the quit probe is running", countQuitTicks() > 1, `ticks=${countQuitTicks()}`);

    try {
      await w.keyboard.press("Alt+F4");
    } catch (_) {
      // The press lands, the app quits, and Playwright can't acknowledge a target
      // that has already gone — which is the outcome being tested for.
    }
    // Same as above: quitting drops the connection, so the assertion is that the
    // shells stopped — which is the thing that distinguishes a quit from a detach,
    // and the only one that matters here.
    await sleep(9000);
    const atQuit = countQuitTicks();
    await sleep(5000);
    check(
      "Alt+F4 quits rather than detaching (the shells end)",
      countQuitTicks() === atQuit,
      `ticks stayed at ${atQuit}`
    );
  } finally {
    await kill(app4);
    try {
      fs.rmSync(safetyDir, { recursive: true, force: true });
    } catch (_) {
      // temp dir
    }
  }

  // ======================================================================
  // Part 3b — a resume command is only offered when it would work
  // ======================================================================
  // A recorded session id is a *remembered* fact: Claude Code prunes transcripts,
  // directories move, `~/.claude` gets cleared. Offering `claude --resume <id>` for
  // a session that has gone produces a command that looks authoritative and fails
  // the moment it runs — which is worse than offering nothing, now that a restored
  // pane already has its transcript replayed above the prompt.
  //
  // Both directions are checked, and the positive one is the important half: a bug
  // in the existence check would silently disable the whole feature rather than
  // breaking loudly.
  //
  // Driven by writing the host's own session file rather than by running claude, so
  // it needs nothing installed and the id under test is known exactly.
  const resumeDir = path.join(os.tmpdir(), `specterm-resume-${Date.now()}`);
  const workDir = path.join(resumeDir, "work");
  fs.mkdirSync(workDir, { recursive: true });
  const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const projectDir = path.join(
    os.homedir(),
    ".claude",
    "projects",
    workDir.replace(/[/\\]/g, "-")
  );
  const transcript = path.join(projectDir, `${SESSION_ID}.jsonl`);

  const writeResumeSession = () => {
    fs.writeFileSync(
      path.join(resumeDir, "session.json"),
      JSON.stringify({
        version: 2,
        savedAt: 1,
        windows: [
          {
            activeTabIndex: 0,
            tabs: [
              {
                title: "resume-me",
                manualTitle: true,
                activePaneIndex: 0,
                root: {
                  type: "leaf",
                  pane: {
                    kind: "terminal",
                    cwd: workDir,
                    title: "resume-me",
                    session: {
                      provider: "claude",
                      id: SESSION_ID,
                      resumeCommand: `claude --resume ${SESSION_ID}`,
                    },
                  },
                },
              },
            ],
          },
        ],
      }),
      "utf8"
    );
  };

  // Does the restored pane have the command sitting at its prompt? Probed through
  // the find bar, the same way every other buffer check here works.
  const resumeOffered = async () => {
    const app = await electron.launch(launchOptions(root, resumeDir));
    try {
      const w = await app.firstWindow();
      await w.waitForSelector(".file-tree", { timeout: 20000 });
      // The command is delivered after the shell's first output plus a beat, and
      // the existence check adds a filesystem round trip on top.
      await sleep(7000);
      return foundSomething(await findCount(w, "--resume"));
    } finally {
      await kill(app);
    }
  };

  try {
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(transcript, JSON.stringify({ sessionId: SESSION_ID }) + "\n");
    writeResumeSession();
    check(
      "a session that still exists gets its resume command offered",
      await resumeOffered(),
      ""
    );

    // Now take the transcript away — the case that produced a command which
    // errored at the prompt.
    fs.rmSync(transcript, { force: true });
    writeResumeSession();
    check(
      "a session that has since been pruned offers nothing",
      (await resumeOffered()) === false,
      ""
    );
  } finally {
    try {
      fs.rmSync(projectDir, { recursive: true, force: true });
    } catch (_) {
      // may not exist
    }
    try {
      fs.rmSync(resumeDir, { recursive: true, force: true });
    } catch (_) {
      // temp dir
    }
  }

  // ======================================================================
  // Part 4 — window chrome: the tab bar standing in for the title bar
  // ======================================================================
  // Lives in this suite rather than the main one because the interesting half needs
  // a *relaunch*: a frame can't be added to or taken off a window that is already
  // open, so the setting only shows up on the next window.
  const chromeDir = path.join(os.tmpdir(), `specterm-chrome-${Date.now()}`);
  fs.mkdirSync(chromeDir, { recursive: true });
  const chromeLaunch = () =>
    electron.launch(launchOptions(root, chromeDir));

  const appC = await chromeLaunch();
  try {
    const w = await appC.firstWindow();
    await w.waitForSelector(".file-tree", { timeout: 20000 });
    await w.waitForTimeout(2500);

    check(
      "the tab bar draws the window controls",
      (await w.locator(".tab-window-btn").count()) === 3,
      `buttons=${await w.locator(".tab-window-btn").count()}`
    );

    // Fullscreen: there is no window to minimise or restore, and the OS has taken
    // the chrome away anyway.
    await appC.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setFullScreen(true)
    );
    await sleep(2500);
    check(
      "the controls hide in fullscreen",
      (await w.locator(".tab-window-btn").count()) === 0,
      `buttons=${await w.locator(".tab-window-btn").count()}`
    );
    await appC.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setFullScreen(false)
    );
    await sleep(2500);
    check(
      "and come back on the way out",
      (await w.locator(".tab-window-btn").count()) === 3,
      `buttons=${await w.locator(".tab-window-btn").count()}`
    );

    // Turn it off the way a user would, through Settings.
    await w.keyboard.press("Control+Shift+,");
    await w.waitForSelector("#custom-title-bar", { timeout: 8000 });
    await w.locator("#custom-title-bar").uncheck();
    await sleep(1500);
  } finally {
    await kill(appC);
  }

  const appC2 = await chromeLaunch();
  try {
    const w = await appC2.firstWindow();
    // The sidebar remembers what it was showing, and the block above turned the
    // custom title bar off through Settings — so this window comes back on the
    // settings panel, not the file tree. Wait for the window itself.
    await w.waitForSelector(".app", { timeout: 20000 });
    await w.waitForTimeout(2500);
    check(
      "turning it off gives the system title bar back on the next window",
      (await w.locator(".tab-window-btn").count()) === 0,
      `buttons=${await w.locator(".tab-window-btn").count()}`
    );
  } finally {
    await kill(appC2);
    try {
      fs.rmSync(chromeDir, { recursive: true, force: true });
    } catch (_) {
      // temp dir
    }
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
