// End-to-end assertions for multiple windows and tab/pane tear-off.
//
// The gesture under test is "drag a tab out of the window", which no automation
// API can perform for real: Playwright's mouse is clamped to the window, and the
// drop target is decided by the host from the OS cursor. So the drag itself is
// driven as the synthetic PointerEvent sequence the renderer actually listens
// for (TabBar/Pane attach their move/up handlers to `window`), with the release
// point outside the viewport — the same input the browser would deliver.
//
// What matters is verified without scraping the terminal canvas, exactly as
// test/e2e.mjs does it: the shell writes to a temp file, and a shell that keeps
// its PID across the move is proof the same process came along.
import { _electron as electron } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const WIN = process.platform === "win32";
const MAC = process.platform === "darwin";
const log = (...a) => console.log("[e2e-windows]", ...a);

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const hard = setTimeout(() => {
  console.error("[e2e-windows] HARD TIMEOUT");
  process.exit(2);
}, 180000);
hard.unref();

const NEW_TAB = MAC ? "Meta+T" : "Control+Shift+T";
const NEW_WINDOW = MAC ? "Meta+N" : "Control+Shift+N";
const COPY_KEY = MAC ? "Meta+C" : "Control+Shift+C";
const SETTINGS_KEY = MAC ? "Meta+Comma" : "Control+Shift+Comma";
const SPLIT_SIDE = MAC ? "Meta+Shift+D" : "Control+Shift+Enter";

// Printed into a terminal before it is moved; it may only reappear in the
// destination window if the buffer was serialized and replayed there.
const MARKER = "TEAROFF_MARKER_42";

const userDataDir = path.join(
  os.tmpdir(),
  `specterm-e2e-win-${process.pid}-${Date.now()}`
);
fs.mkdirSync(userDataDir, { recursive: true });

// Have the focused pane's shell write an expression's output to a temp file.
// Same trick as the main suite: renderer- and shell-agnostic, no canvas reads.
async function shellValue(win, marker, expr, timeoutMs = 15000) {
  const outFile = path.join(os.tmpdir(), `specterm_win_${marker}.txt`);
  try {
    fs.unlinkSync(outFile);
  } catch {}
  const cmd = WIN
    ? `${expr} | Out-File -Encoding ascii -FilePath "${outFile}"`
    : `${expr} > "${outFile}"`;
  await win.locator(".xterm-helper-textarea:visible").last().click({ force: true });
  await win.keyboard.type(cmd);
  await win.keyboard.press("Enter");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(outFile)) {
      const v = fs.readFileSync(outFile, "utf8").trim();
      if (v) return v;
    }
    await win.waitForTimeout(300);
  }
  return null;
}

// The PID of the shell running in the focused pane. Identity across a tear-off
// is the whole point: a rebuilt terminal that spawned a fresh shell would report
// a different number.
const shellPid = (win, marker) =>
  shellValue(win, marker, WIN ? "$PID" : 'printf "%s" "$$"');

const tabIds = (win) =>
  win.evaluate(() =>
    Array.from(document.querySelectorAll("[data-tab-id]")).map((e) =>
      e.getAttribute("data-tab-id")
    )
  );

const paneIds = (win) =>
  win.evaluate(() =>
    Array.from(document.querySelectorAll("[data-pane-id]")).map((e) =>
      e.getAttribute("data-pane-id")
    )
  );

// Read the terminal the only way that doesn't mean scraping a WebGL canvas:
// drag a selection across it and copy, then read the OS clipboard host-side.
async function selectAndCopy(win) {
  await app.evaluate(({ clipboard }) => clipboard.writeText("<<EMPTY>>"));
  const box = await win.locator(".xterm-screen").first().boundingBox();
  await win.mouse.move(box.x + 4, box.y + 4);
  await win.mouse.down();
  await win.mouse.move(box.x + box.width - 8, box.y + box.height - 8, {
    steps: 14,
  });
  await win.mouse.up();
  await win.waitForTimeout(300);
  await win.keyboard.press(COPY_KEY);
  await win.waitForTimeout(500);
  return app.evaluate(({ clipboard }) => clipboard.readText());
}

async function printMarker(win) {
  await win.locator(".xterm-helper-textarea:visible").last().click({ force: true });
  await win.keyboard.type(WIN ? `Write-Output ${MARKER}` : `printf '${MARKER}\\n'`);
  await win.keyboard.press("Enter");
  await win.waitForTimeout(1000);
}

// Drive the drag the renderer listens for, releasing outside the window.
// `selector` picks the grab handle: a tab chip, or a pane's title bar.
const dragOutOfWindow = (win, selector) =>
  win.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`no element for ${sel}`);
    const box = el.getBoundingClientRect();
    const at = (x, y) => ({
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      clientX: x,
      clientY: y,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    });
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    el.dispatchEvent(new PointerEvent("pointerdown", at(startX, startY)));
    // Past the drag threshold first, still inside — then clear of the window.
    for (const [x, y] of [
      [startX + 20, startY + 20],
      [startX + 60, startY + 200],
      [-140, 320],
    ]) {
      el.dispatchEvent(new PointerEvent("pointermove", at(x, y)));
      window.dispatchEvent(new PointerEvent("pointermove", at(x, y)));
    }
    el.dispatchEvent(new PointerEvent("pointerup", at(-140, 320)));
    window.dispatchEvent(new PointerEvent("pointerup", at(-140, 320)));
  }, selector);

let app;
try {
  app = await electron.launch({
    args: [root, `--user-data-dir=${userDataDir}`],
    cwd: root,
  });

  const winA = await app.firstWindow();
  await winA.waitForSelector(".file-tree", { timeout: 20000 });
  await winA.waitForSelector(".xterm-helper-textarea", { timeout: 20000 });
  await winA.waitForTimeout(1200);

  check(
    "a window opens with exactly one terminal tab",
    (await tabIds(winA)).length === 1,
    `tabs=${(await tabIds(winA)).length}`
  );

  // --- new window ---------------------------------------------------------
  await winA.keyboard.press(NEW_WINDOW);
  await winA.waitForTimeout(2500);
  const afterNew = app.windows();
  check("the new-window shortcut opens a second window", afterNew.length === 2,
    `windows=${afterNew.length}`);

  const winB = afterNew.find((w) => w !== winA);
  await winB.waitForSelector(".xterm-helper-textarea", { timeout: 20000 });
  await winB.waitForTimeout(1500);

  // Independent PTY routing: each window drives its own shell. If output were
  // still fanned out to a single window, one of these would come back null.
  const pidA = await shellPid(winA, "a1");
  const pidB = await shellPid(winB, "b1");
  check(
    "each window runs its own shell",
    !!pidA && !!pidB && pidA !== pidB,
    `A=${pidA} B=${pidB}`
  );

  // --- cross-window settings sync -----------------------------------------
  // Each window holds its own copy of the theme, so changing it in one has to
  // reach the others through the host relay rather than waiting for a restart.
  const bgOf = (win) =>
    win.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()
    );
  const bgBefore = await bgOf(winB);

  await winA.keyboard.press(SETTINGS_KEY);
  await winA.waitForSelector("#theme-select", { timeout: 10000 });
  const otherTheme = await winA.evaluate(() => {
    const sel = document.querySelector("#theme-select");
    const opt = Array.from(sel.options).find((o) => o.value !== sel.value);
    return opt ? opt.value : null;
  });
  if (otherTheme) {
    await winA.selectOption("#theme-select", otherTheme);
    await winA.waitForTimeout(1200);
    const bgA = await bgOf(winA);
    const bgAfter = await bgOf(winB);
    check(
      "a theme change in one window reaches the others",
      bgAfter === bgA && bgAfter !== bgBefore,
      `B: ${bgBefore} → ${bgAfter}, A: ${bgA}`
    );
  } else {
    check("a theme change in one window reaches the others", false,
      "no alternative theme to pick");
  }
  await winA.keyboard.press(SETTINGS_KEY);
  await winA.waitForTimeout(600);

  // --- tear a tab off ------------------------------------------------------
  // A second tab, so the move isn't refused as "the window's only tab".
  await winA.locator(".xterm-helper-textarea:visible").last().click({ force: true });
  await winA.keyboard.press(NEW_TAB);
  await winA.waitForTimeout(1800);
  const before = await tabIds(winA);
  check("a second tab opens in window A", before.length === 2, `tabs=${before.length}`);

  const movedPid = await shellPid(winA, "moved");
  check("the tab to be moved has a live shell", !!movedPid, `pid=${movedPid}`);

  await printMarker(winA);

  // The cursor really is somewhere over the screen during this run, and the host
  // decides the drop from it. Windows A and B are stacked at the default
  // position, so the release may land on B (adopt) or on empty desktop (new
  // window); both are correct outcomes and both are asserted below.
  const activeTabSel = `[data-tab-id="${before[1]}"]`;
  await dragOutOfWindow(winA, activeTabSel);
  await winA.waitForTimeout(3000);

  const afterTear = app.windows();
  const remaining = await tabIds(winA);
  check(
    "the torn-off tab leaves the source window",
    remaining.length === 1,
    `tabs=${remaining.length}`
  );

  // Wherever it landed, find the window now holding it and confirm the shell
  // that came along is the same process.
  const candidates = afterTear.filter((w) => w !== winA);
  let landed = null;
  for (const w of candidates) {
    try {
      await w.waitForSelector(".xterm-helper-textarea", { timeout: 15000 });
      const ids = await tabIds(w);
      // The adopting window gained a tab; a brand-new window has exactly one.
      if (ids.length >= 1) landed = w;
    } catch {
      /* window not ready — try the next */
    }
  }
  check("the tab landed in a window", !!landed, `windows=${afterTear.length}`);

  if (landed) {
    await landed.waitForTimeout(1500);

    // Before typing anything into it: the scrollback the move carried over.
    const replayed = await selectAndCopy(landed);
    check(
      "the moved terminal kept its scrollback",
      replayed.includes(MARKER),
      `marker=${replayed.includes(MARKER)}`
    );

    const adoptedPid = await shellPid(landed, "adopted");
    check(
      "the moved tab kept its shell process (PTY survived the move)",
      !!adoptedPid && adoptedPid === movedPid,
      `before=${movedPid} after=${adoptedPid}`
    );

    // --- tear a single pane off ---------------------------------------------
    // Split, then drag the new pane's title bar out. A pane that leaves becomes
    // a tab wherever it lands.
    await landed.locator(".xterm-helper-textarea:visible").last().click({ force: true });
    await landed.keyboard.press(SPLIT_SIDE);
    await landed.waitForTimeout(2000);
    const panesBefore = await paneIds(landed);
    check("the pane splits in two", panesBefore.length === 2,
      `panes=${panesBefore.length}`);

    if (panesBefore.length === 2) {
      const panePid = await shellPid(landed, "pane");
      await dragOutOfWindow(
        landed,
        `[data-pane-id="${panesBefore[1]}"] .pane-titlebar`
      );
      await landed.waitForTimeout(3000);
      const panesAfter = await paneIds(landed);
      check(
        "the torn-off pane leaves the source window",
        panesAfter.length === 1,
        `panes=${panesAfter.length}`
      );

      // Find whichever window now runs that shell.
      let paneLanded = null;
      for (const w of app.windows()) {
        if (w === landed) continue;
        try {
          await w.waitForSelector(".xterm-helper-textarea", { timeout: 10000 });
          if ((await shellPid(w, `pl${app.windows().indexOf(w)}`)) === panePid) {
            paneLanded = w;
            break;
          }
        } catch {
          /* not this one */
        }
      }
      check(
        "the torn-off pane kept its shell process",
        !!paneLanded,
        `pid=${panePid}`
      );
    }
  }

  // --- per-window teardown -------------------------------------------------
  // Closing one window must not take another's terminals down with it.
  const survivor = app.windows().find((w) => w !== winA);
  await winA.close();
  await new Promise((r) => setTimeout(r, 2000));
  if (survivor) {
    const stillAlive = await shellPid(survivor, "survivor");
    check(
      "closing a window leaves the other windows' shells running",
      !!stillAlive,
      `pid=${stillAlive}`
    );
  } else {
    check("closing a window leaves the other windows' shells running", false,
      "no surviving window");
  }
} catch (err) {
  console.error("[e2e-windows] ERROR:", err?.message || err);
  results.push({ name: "suite completed", pass: false });
} finally {
  try {
    await app?.close();
  } catch {}
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch {}
}

const failed = results.filter((r) => !r.pass).length;
log("");
log(`===== ${results.length - failed} passed, ${failed} failed (${process.platform}) =====`);
process.exit(failed ? 1 : 0);
