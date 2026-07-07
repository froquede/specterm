// Cross-platform end-to-end assertion suite for the FileTree sidebar.
// Launches the built Electron app and drives the real UI. Windows-only concerns
// (the "This PC" drive view / partition roots) run under `if (WIN)`; POSIX gets
// an equivalent "reach filesystem root" check. Terminal cwd is verified by
// having the shell write its working directory to a temp file (renderer- and
// shell-agnostic), not by scraping the WebGL canvas.
import { _electron as electron } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const WIN = process.platform === "win32";
const SEP = WIN ? "\\" : "/";
const log = (...a) => console.log("[e2e]", ...a);

// A directory that reliably exists to point the startup path at.
const STARTUP_TARGET = WIN ? "C:\\Windows" : "/usr";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, skipped: false });
  log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const skip = (name, why) => {
  results.push({ name, pass: true, skipped: true });
  log(`SKIP  ${name}  — ${why}`);
};

const eqPath = (a, b) =>
  a != null && b != null && (WIN ? a.toLowerCase() === b.toLowerCase() : a === b);
const joinPath = (base, name) => base.replace(/[\\/]+$/, "") + SEP + name;

const hard = setTimeout(() => {
  console.error("[e2e] HARD TIMEOUT");
  process.exit(2);
}, 180000);
hard.unref();

// --- helpers ---------------------------------------------------------------
const state = (win) =>
  win.evaluate(() => {
    const q = (s) => Array.from(document.querySelectorAll(s));
    const stripIcon = (t) => (t || "").replace(/[▴▸◆·]/g, "").trim();
    return {
      crumbs: q(".file-tree-crumb").map((b) => b.textContent),
      crumbTitle:
        document.querySelector(".file-tree-crumbs")?.getAttribute("title") ?? null,
      names: q(".file-tree-content .file-tree-name").map((s) => s.textContent),
      dirNames: q(".file-tree-content .file-tree-entry.file-tree-dir .file-tree-name").map(
        (s) => s.textContent
      ),
      dotDot: q(".file-tree-content .file-tree-entry").some(
        (e) => !e.querySelector(".file-tree-name") && stripIcon(e.textContent) === ".."
      ),
    };
  });

const rx = (s) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
const clickCrumb = (win, label) =>
  win.locator(".file-tree-crumb", { hasText: rx(label) }).first().click();
const clickEntry = (win, name) =>
  win
    .locator(".file-tree-content .file-tree-entry", {
      has: win.locator(".file-tree-name", { hasText: rx(name) }),
    })
    .first()
    .click();
const clickDotDot = (win) =>
  win.locator(".file-tree-content .file-tree-entry", { hasText: ".." }).first().click();

// Have the active-pane shell write a value to a temp file, then read it back.
// `expr` is the shell expression whose stdout we capture.
async function shellValue(win, marker, expr, timeoutMs = 12000) {
  const outFile = path.join(os.tmpdir(), `specterm_${marker}.txt`);
  try { fs.unlinkSync(outFile); } catch {}
  const cmd = WIN
    ? `${expr} | Out-File -Encoding ascii -FilePath "${outFile}"`
    : `${expr} > "${outFile}"`;
  await win.locator(".xterm-helper-textarea:visible").last().click({ force: true });
  await win.keyboard.type(cmd);
  await win.keyboard.press("Enter"); // sends CR — executes on PowerShell and POSIX shells
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

// Where the active pane's shell currently is (its live cwd).
const terminalCwd = (win, marker, timeoutMs) =>
  shellValue(win, marker, WIN ? "(Get-Location).Path" : "pwd", timeoutMs);

// Where the terminal was *opened* — the spawn cwd the main process recorded in
// SPECTERM_CWD, before the user's shell rc ran. Unlike `pwd`, this survives an
// rc that `cd`s on startup, so it reflects the startup-path setting itself.
const spawnCwd = (win, marker, timeoutMs) =>
  shellValue(win, marker, WIN ? "$Env:SPECTERM_CWD" : 'printf "%s" "$SPECTERM_CWD"', timeoutMs);

// Run against a throwaway Electron profile so the suite never touches the
// developer's real settings/favorites/theme (localStorage lives in userData).
const userDataDir = path.join(os.tmpdir(), `specterm-e2e-${process.pid}-${Date.now()}`);
fs.mkdirSync(userDataDir, { recursive: true });

// Which key splits a pane side-by-side. macOS uses the ⌘-scheme (⌘⇧D); Windows
// and Linux keep the original "kitty" chord (Ctrl+Shift+Enter). See keymap.ts.
const SPLIT_SIDE = process.platform === "darwin" ? "Meta+Shift+D" : "Control+Shift+Enter";
// Stacked (row) split — ⌘D on macOS, Ctrl+Shift+S elsewhere. See keymap.ts.
const SPLIT_STACK = process.platform === "darwin" ? "Meta+D" : "Control+Shift+S";

// Read the transient drop-preview state mid-drag. A root-span preview is a
// direct child of the split root; a local split preview lives inside a pane.
const readDrop = (win) =>
  win.evaluate(() => ({
    rootIndicator: !!document.querySelector("[data-split-root] > .drop-indicator"),
    localIndicator: !!document.querySelector(".pane .drop-indicator"),
  }));

// --- run -------------------------------------------------------------------
let app;
try {
  app = await electron.launch({ args: [root, `--user-data-dir=${userDataDir}`], cwd: root });
  const win = await app.firstWindow();
  win.on("pageerror", (e) => log("PAGEERROR:", e.message));
  await win.waitForSelector(".file-tree", { timeout: 20000 });
  // Fresh profile → localStorage starts empty (startupPath blank → opens at home),
  // so no clean-slate reset is needed.
  await win.waitForTimeout(1500);

  const s0 = await state(win);
  const home = s0.crumbTitle;
  check("sidebar opens at home", !!home && (WIN ? /:/.test(home) : home.startsWith("/")), home);
  check("breadcrumb collapses home to ~", s0.crumbs.includes("~"), s0.crumbs.join(" / "));
  if (WIN) check('breadcrumb shows "This PC"', s0.crumbs.includes("This PC"), s0.crumbs.join(" / "));
  check('".." row present', s0.dotDot, "");

  // Boot terminal spawns at home (blank startupPath). Read the spawn cwd, not
  // the live pwd, so a shell rc that `cd`s on startup doesn't mask it.
  await win.waitForTimeout(2500);
  const cwd0 = await spawnCwd(win, "boot");
  check("terminal spawns at home (blank startupPath)", eqPath(cwd0, home), `spawn cwd=${cwd0}`);

  // 1) Enter the first real subdirectory (skip if home has none).
  const sub = s0.dirNames.find((n) => n && n !== "..");
  if (sub) {
    await clickEntry(win, sub);
    await win.waitForTimeout(700);
    const s1 = await state(win);
    check("enter subdirectory updates path", eqPath(s1.crumbTitle, joinPath(home, sub)), s1.crumbTitle);

    // 2) Go up via "..".
    await clickDotDot(win);
    await win.waitForTimeout(500);
    const s2 = await state(win);
    check('".." returns to parent', eqPath(s2.crumbTitle, home), s2.crumbTitle);
  } else {
    skip("enter subdirectory updates path", "home has no subdirectories");
    skip('".." returns to parent', "home has no subdirectories");
  }

  if (WIN) {
    // 3) Cross-partition: This PC drive view.
    await clickCrumb(win, "This PC");
    await win.waitForTimeout(800);
    const s3 = await state(win);
    const drives = s3.names.filter((n) => /^[A-Z]:$/i.test(n));
    check("This PC shows the drive list", drives.some((n) => /^C:$/i.test(n)), `drives=[${s3.names.join(", ")}]`);
    check("multiple partitions visible", drives.length >= 1, `${drives.length} drive(s)`);
    await win.screenshot({ path: path.join(root, "test", "shot-drives.png") });

    // 4) Enter C: — navigation into a partition root.
    await clickEntry(win, "C:");
    await win.waitForTimeout(800);
    const s4 = await state(win);
    const atCRoot = /^C:\\?$/i.test(s4.crumbTitle || "");
    const looksLikeC = s4.names.some((n) => /^(Windows|Users)$/i.test(n));
    check("entering C: lists the partition root", atCRoot && looksLikeC, `${s4.crumbTitle}`);
  } else {
    // 3') POSIX equivalent: walk up to the filesystem root and confirm we stop.
    let cur = (await state(win)).crumbTitle;
    for (let i = 0; i < 8 && cur !== "/"; i++) {
      await clickDotDot(win);
      await win.waitForTimeout(300);
      cur = (await state(win)).crumbTitle;
    }
    check("reaches filesystem root /", cur === "/", cur);
    await clickDotDot(win); // going up from / stays at /
    await win.waitForTimeout(300);
    check("cannot go above /", (await state(win)).crumbTitle === "/", "");
  }

  // 5) cd control: from wherever we are now, browse into a *safe* subdirectory
  // (avoid system/hidden dirs like $Recycle.Bin that deny access) and cd there.
  const s5 = await state(win);
  const base = s5.crumbTitle;
  const cdSub =
    ["Users", "Windows", "usr", "etc", "home"].find((n) => s5.dirNames.includes(n)) ||
    s5.dirNames.find((n) => n && n !== ".." && !n.startsWith("$") && !n.startsWith("."));
  if (cdSub) {
    await clickEntry(win, cdSub);
    await win.waitForTimeout(700);
    const browsed = (await state(win)).crumbTitle;
    await win.locator(".file-tree-cd-here").click();
    await win.waitForTimeout(1500);
    const cwdCd = await terminalCwd(win, "cdctl");
    check("cd control moves the terminal", eqPath(cwdCd, browsed), `browsed=${browsed} pty cwd=${cwdCd}`);

    // 6) Keyboard up-nav: Backspace in an empty filter goes up to the parent.
    await win.locator(".file-tree-search input").click();
    await win.keyboard.press("Backspace");
    await win.waitForTimeout(500);
    check("Backspace (empty filter) goes up", eqPath((await state(win)).crumbTitle, base), `back to ${base}`);
  } else {
    skip("cd control moves the terminal", "no safe subdirectory to cd into");
    skip("Backspace (empty filter) goes up", "no safe subdirectory to cd into");
  }

  // 6b) PR #17 — "cd fav-N" typed at the shell prompt expands to a real cd into
  // the pinned favorite. Favorite a folder, cd the terminal to a *different*
  // dir, then type `cd fav-1` and confirm the shell landed in the favorite.
  const sf = await state(win);
  const favBase = sf.crumbTitle;
  const favDir =
    ["Windows", "usr", "etc", "Users", "home"].find((n) => sf.dirNames.includes(n)) ||
    sf.dirNames.find((n) => n && n !== ".." && !n.startsWith("$") && !n.startsWith("."));
  if (favDir) {
    const entry = win
      .locator(".file-tree-content .file-tree-entry", {
        has: win.locator(".file-tree-name", { hasText: rx(favDir) }),
      })
      .first();
    await entry.hover();
    await entry.locator(".file-tree-entry-fav").click({ force: true });
    // cd the active terminal to favBase (so the fav-N jump is a visible change).
    const favLS = await win.evaluate(() => localStorage.getItem("specterm.favorites"));
    await win.locator(".file-tree-cd-here").click();
    await win.waitForTimeout(1200);
    await win.locator(".xterm-helper-textarea:visible").last().click({ force: true });
    await win.keyboard.type("cd fav-1");
    await win.keyboard.press("Enter");
    await win.waitForTimeout(1500);
    const cwdFav = await terminalCwd(win, "favN");
    check("cd fav-N expands to the favorite path", eqPath(cwdFav, joinPath(favBase, favDir)), `expected=${joinPath(favBase, favDir)} cwd=${cwdFav} favs=${favLS}`);
  } else {
    skip("cd fav-N expands to the favorite path", "no favoritable subdirectory");
  }

  // 6c) PR #16 — root-edge drag-and-drop. Split side-by-side, then drag the
  // right pane's titlebar: over the outer strip it previews a full-span root
  // drop; over an inner edge it previews a local split.
  await win.locator(".xterm-helper-textarea:visible").last().click({ force: true });
  await win.keyboard.press(SPLIT_SIDE);
  await win.waitForTimeout(2000);
  const paneN = await win.evaluate(() => document.querySelectorAll("[data-pane-id]").length);
  if (paneN >= 2) {
    const geo = await win.evaluate(() => {
      const rootEl = document.querySelector("[data-split-root]").getBoundingClientRect();
      const panes = Array.from(document.querySelectorAll("[data-pane-id]")).map((p) => {
        const r = p.getBoundingClientRect();
        const tb = p.querySelector(".pane-titlebar").getBoundingClientRect();
        return { r: { left: r.left, right: r.right, top: r.top, height: r.height, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 }, tb: { x: tb.left + 28, y: (tb.top + tb.bottom) / 2 } };
      });
      return { root: { left: rootEl.left, right: rootEl.right }, panes };
    });
    const [p0, p1] = geo.panes;
    await win.mouse.move(p1.tb.x, p1.tb.y);
    await win.mouse.down();
    await win.mouse.move(geo.root.left + 6, p0.r.cy, { steps: 8 }); // outer-left strip
    const d1 = await readDrop(win);
    check("outer-edge drag previews a root-span drop", d1.rootIndicator && !d1.localIndicator, JSON.stringify(d1));
    // Inner top of the left pane: past the outer band (so not a root drop) yet
    // in the top zone (so a real edge, not a center swap) and clear of the divider.
    await win.mouse.move(p0.r.cx, p0.r.top + p0.r.height * 0.2, { steps: 8 });
    const d2 = await readDrop(win);
    check("inner-edge drag previews a local split", d2.localIndicator && !d2.rootIndicator, JSON.stringify(d2));
    await win.mouse.move(geo.root.left + 6, p0.r.cy, { steps: 6 });
    await win.mouse.up();
    await win.waitForTimeout(600);
    const paneN2 = await win.evaluate(() => document.querySelectorAll("[data-pane-id]").length);
    check("root-edge drop rearranges without adding panes", paneN2 === paneN, `before=${paneN} after=${paneN2}`);
  } else {
    skip("outer-edge drag previews a root-span drop", "split shortcut did not create a second pane");
    skip("inner-edge drag previews a local split", "split shortcut did not create a second pane");
    skip("root-edge drop rearranges without adding panes", "split shortcut did not create a second pane");
  }

  // 6d) v0.10.0 — snapped divider resize. Build a 2×2 grid in a fresh tab so its
  // two vertical dividers line up into one continuous "snapped" line: a plain
  // drag must move both (whole-column resize); Alt-drag must move only one.
  const paneRects = () =>
    win.evaluate(() =>
      Array.from(document.querySelectorAll("[data-pane-id]")).map((p) => {
        const r = p.getBoundingClientRect();
        return { cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 };
      })
    );
  // Vertical dividers only (direction "h" = col-resize bar); the root row split
  // is a horizontal bar (.split-handle-v) and is excluded.
  const vHandles = () =>
    win.evaluate(() =>
      Array.from(document.querySelectorAll(".split-handle-h")).map((h) => {
        const r = h.getBoundingClientRect();
        return { id: h.dataset.splitId, x: (r.left + r.right) / 2, top: r.top, cy: (r.top + r.bottom) / 2 };
      })
    );
  const focusPaneAt = async (x, y) => {
    await win.mouse.click(x, y);
    await win.waitForTimeout(200);
  };

  await win.locator(".tab-new").click();
  await win.waitForTimeout(2000);
  let rects = await paneRects();
  // Stacked split → two rows.
  await focusPaneAt(rects[0].cx, rects[0].cy);
  await win.keyboard.press(SPLIT_STACK);
  await win.waitForTimeout(2000);
  // Split the top row side-by-side.
  rects = await paneRects();
  let topPane = rects.reduce((a, b) => (a.cy < b.cy ? a : b));
  await focusPaneAt(topPane.cx, topPane.cy);
  await win.keyboard.press(SPLIT_SIDE);
  await win.waitForTimeout(2000);
  // Split the bottom row side-by-side → 2×2.
  rects = await paneRects();
  let bottomPane = rects.reduce((a, b) => (a.cy > b.cy ? a : b));
  await focusPaneAt(bottomPane.cx, bottomPane.cy);
  await win.keyboard.press(SPLIT_SIDE);
  await win.waitForTimeout(2000);

  const h0 = await vHandles();
  const gridOk = h0.length === 2 && Math.abs(h0[0].x - h0[1].x) < 6;
  check("2×2 grid yields two aligned vertical dividers", gridOk, JSON.stringify(h0));

  if (gridOk) {
    const upper = h0.reduce((a, b) => (a.cy < b.cy ? a : b));
    const lower = h0.reduce((a, b) => (a.cy > b.cy ? a : b));
    const startX = upper.x;
    // Grab the handle near its top edge — the centered flip button (which stops
    // the resize) sits at the handle's mid-point.
    const grabY = upper.top + 12;

    // Plain drag → the whole snapped line follows; both dividers stay aligned.
    await win.mouse.move(startX, grabY);
    await win.mouse.down();
    await win.mouse.move(startX + 90, grabY, { steps: 12 });
    await win.mouse.up();
    await win.waitForTimeout(300);
    const h1 = await vHandles();
    const both = h1.every((h) => h.x > startX + 40) && Math.abs(h1[0].x - h1[1].x) < 6;
    check("plain drag moves both snapped dividers together", both, `before x≈${Math.round(startX)} → ${JSON.stringify(h1.map((h) => Math.round(h.x)))}`);

    // Alt-drag → only the grabbed split resizes; its partner holds position.
    const b = await vHandles();
    const bUp = b.find((h) => h.id === upper.id);
    const bLow = b.find((h) => h.id === lower.id);
    await win.keyboard.down("Alt");
    await win.mouse.move(bUp.x, bUp.top + 12);
    await win.mouse.down();
    await win.mouse.move(bUp.x - 100, bUp.top + 12, { steps: 12 });
    await win.mouse.up();
    await win.keyboard.up("Alt");
    await win.waitForTimeout(300);
    const a = await vHandles();
    const aUp = a.find((h) => h.id === upper.id);
    const aLow = a.find((h) => h.id === lower.id);
    const only = Math.abs(aUp.x - bUp.x) > 40 && Math.abs(aLow.x - bLow.x) < 8;
    check("Alt-drag resizes only the grabbed divider", only, `upperΔ=${Math.round(aUp.x - bUp.x)} lowerΔ=${Math.round(aLow.x - bLow.x)}`);
  } else {
    skip("plain drag moves both snapped dividers together", "grid did not form");
    skip("Alt-drag resizes only the grabbed divider", "grid did not form");
  }

  // 6e) Symmetric case — horizontal dividers (row resize, dragged up/down). Build
  // a grid whose two horizontal dividers line up into one snapped line and prove
  // the same both-together / Alt-only behaviour on the vertical axis.
  const hHandles = () =>
    win.evaluate(() =>
      Array.from(document.querySelectorAll(".split-handle-v")).map((h) => {
        const r = h.getBoundingClientRect();
        return { id: h.dataset.splitId, y: (r.top + r.bottom) / 2, left: r.left, cx: (r.left + r.right) / 2 };
      })
    );

  await win.locator(".tab-new").click();
  await win.waitForTimeout(2000);
  let r2 = await paneRects();
  // Side-by-side split → two columns.
  await focusPaneAt(r2[0].cx, r2[0].cy);
  await win.keyboard.press(SPLIT_SIDE);
  await win.waitForTimeout(2000);
  // Stack the left column.
  r2 = await paneRects();
  let leftPane = r2.reduce((a, b) => (a.cx < b.cx ? a : b));
  await focusPaneAt(leftPane.cx, leftPane.cy);
  await win.keyboard.press(SPLIT_STACK);
  await win.waitForTimeout(2000);
  // Stack the right column → 2×2 with two aligned horizontal dividers.
  r2 = await paneRects();
  let rightPane = r2.reduce((a, b) => (a.cx > b.cx ? a : b));
  await focusPaneAt(rightPane.cx, rightPane.cy);
  await win.keyboard.press(SPLIT_STACK);
  await win.waitForTimeout(2000);

  const g0 = await hHandles();
  const gridOk2 = g0.length === 2 && Math.abs(g0[0].y - g0[1].y) < 6;
  check("2×2 grid yields two aligned horizontal dividers", gridOk2, JSON.stringify(g0));

  if (gridOk2) {
    const leftH = g0.reduce((a, b) => (a.cx < b.cx ? a : b));
    const rightH = g0.reduce((a, b) => (a.cx > b.cx ? a : b));
    const startY = leftH.y;
    // Grab near the handle's left edge — the centered flip button sits mid-span.
    const grabX = leftH.left + 12;

    // Plain drag downward → both rows follow; the dividers stay aligned.
    await win.mouse.move(grabX, startY);
    await win.mouse.down();
    await win.mouse.move(grabX, startY + 80, { steps: 12 });
    await win.mouse.up();
    await win.waitForTimeout(300);
    const g1 = await hHandles();
    const both2 = g1.every((h) => h.y > startY + 35) && Math.abs(g1[0].y - g1[1].y) < 6;
    check("plain drag moves both snapped rows together", both2, `before y≈${Math.round(startY)} → ${JSON.stringify(g1.map((h) => Math.round(h.y)))}`);

    // Alt-drag upward → only the grabbed row moves; its partner holds position.
    const gb = await hHandles();
    const bL = gb.find((h) => h.id === leftH.id);
    const bR = gb.find((h) => h.id === rightH.id);
    await win.keyboard.down("Alt");
    await win.mouse.move(bL.left + 12, bL.y);
    await win.mouse.down();
    await win.mouse.move(bL.left + 12, bL.y - 90, { steps: 12 });
    await win.mouse.up();
    await win.keyboard.up("Alt");
    await win.waitForTimeout(300);
    const ga = await hHandles();
    const aL = ga.find((h) => h.id === leftH.id);
    const aR = ga.find((h) => h.id === rightH.id);
    const only2 = Math.abs(aL.y - bL.y) > 40 && Math.abs(aR.y - bR.y) < 8;
    check("Alt-drag resizes only the grabbed row", only2, `leftΔ=${Math.round(aL.y - bL.y)} rightΔ=${Math.round(aR.y - bR.y)}`);
  } else {
    skip("plain drag moves both snapped rows together", "grid did not form");
    skip("Alt-drag resizes only the grabbed row", "grid did not form");
  }

  // 6f) Clipboard reliability. Copy must reach the *OS* clipboard (read here from
  // the Electron main process — the ground truth an external app would see), and
  // paste must pull from it into the active pane. Regression guard for the
  // navigator.clipboard flakiness that made copy work "only inside the app".
  const readOsClip = () => app.evaluate(({ clipboard }) => clipboard.readText());
  const writeOsClip = (t) => app.evaluate(({ clipboard }, text) => clipboard.writeText(text), t);
  const COPY_KEY = process.platform === "darwin" ? "Meta+C" : "Control+Shift+C";
  const PASTE_KEY = process.platform === "darwin" ? "Meta+Shift+V" : "Control+Shift+V";

  // Fresh single-pane tab so the copy drag-select and the type target the same
  // (full-size) pane, independent of the multi-pane grid left by earlier tests.
  await win.locator(".tab-new").click();
  await win.waitForTimeout(2500);

  await writeOsClip("STALE_CLIP_SHOULD_BE_REPLACED");
  await win.locator(".xterm-helper-textarea:visible").last().click({ force: true });
  await win.keyboard.type("echo CLIP_MARK_98765");
  await win.keyboard.press("Enter");
  await win.waitForTimeout(700);
  // Drag-select the visible pane content so the echoed marker line is selected.
  const cbox = await win.evaluate(() => {
    const c = document.querySelector(".pane-content");
    const r = c.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  await win.mouse.move(cbox.x + 8, cbox.y + 8);
  await win.mouse.down();
  await win.mouse.move(cbox.x + cbox.w - 8, cbox.y + cbox.h * 0.5, { steps: 10 });
  await win.mouse.up();
  await win.waitForTimeout(250);
  await win.keyboard.press(COPY_KEY);
  await win.waitForTimeout(400);
  const copied = await readOsClip();
  check("copy reaches the OS clipboard", copied.includes("CLIP_MARK_98765"), `clip=${JSON.stringify(copied.slice(0, 48))}`);

  // Paste: a command placed on the OS clipboard must land in the pane's shell.
  const pasteOut = path.join(os.tmpdir(), `specterm_paste_${process.pid}.txt`);
  try { fs.unlinkSync(pasteOut); } catch {}
  const pasteCmd = WIN
    ? `Set-Content -Path "${pasteOut}" -Value PASTE_OK_555`
    : `echo PASTE_OK_555 > "${pasteOut}"`;
  await writeOsClip(pasteCmd);
  await win.locator(".xterm-helper-textarea:visible").last().click({ force: true });
  await win.keyboard.press(PASTE_KEY);
  await win.waitForTimeout(500);
  await win.keyboard.press("Enter");
  await win.waitForTimeout(1200);
  let pasted = "";
  for (let i = 0; i < 10 && !pasted; i++) {
    if (fs.existsSync(pasteOut)) pasted = fs.readFileSync(pasteOut, "utf8").trim();
    else await win.waitForTimeout(200);
  }
  check("paste delivers the OS clipboard into the pane", pasted === "PASTE_OK_555", `got=${pasted}`);
  try { fs.unlinkSync(pasteOut); } catch {}

  // 6g) WebGL context-loss recovery. Chromium force-kills the oldest WebGL
  // context under its ~16-context cap, which used to leave that pane blank until
  // some unrelated relayout. Force the loss directly and assert the pane
  // repaints itself. Blankness proxy: a uniform region compresses to a tiny PNG.
  const paneShotBytes = async (id) => {
    const box = await win.evaluate((pid) => {
      const c = document.querySelector(`[data-pane-id="${pid}"] .pane-content`);
      const r = c.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    }, id);
    return (await win.screenshot({ clip: box })).length;
  };
  const glPane = await win.evaluate(() => {
    const p = document.querySelector("[data-pane-id]");
    return p ? p.getAttribute("data-pane-id") : null;
  });
  if (glPane) {
    // Give the pane distinctive content so a blank vs. painted canvas differ.
    await win.locator(".xterm-helper-textarea:visible").first().click({ force: true });
    await win.keyboard.type("for i in $(seq 1 30); do echo GLROW_$i ZZZZZZZZZZZZZZZZZZ; done");
    await win.keyboard.press("Enter");
    await win.waitForTimeout(800);
    const glBefore = await paneShotBytes(glPane);
    const lost = await win.evaluate((pid) => {
      let n = 0;
      for (const c of document.querySelectorAll(`[data-pane-id="${pid}"] canvas`)) {
        const gl = c.getContext("webgl2") || c.getContext("webgl");
        const ext = gl && gl.getExtension("WEBGL_lose_context");
        if (ext) { ext.loseContext(); n++; }
      }
      return n;
    }, glPane);
    await win.waitForTimeout(1200); // fast path recovers on the next frame(s)
    const glAfter = await paneShotBytes(glPane);
    check(
      "pane repaints after WebGL context loss",
      lost > 0 && glAfter > glBefore * 0.6,
      `lostCtx=${lost} png ${glBefore}→${glAfter}`
    );
  } else {
    skip("pane repaints after WebGL context loss", "no pane found");
  }

  // 7) Default terminal path: set via UI, confirm persistence, reload, verify
  // a boot terminal spawns there (new tabs spawn lazily, so reload is reliable).
  await win.locator(".tab-settings").click();
  await win.waitForSelector("#startup-path", { timeout: 5000 });
  await win.locator("#startup-path").fill(STARTUP_TARGET);
  await win.locator("#startup-path").blur();
  await win.waitForTimeout(500);
  const persisted = await win.evaluate(() => JSON.parse(localStorage.getItem("specterm.settings")).startupPath);
  check("startup path persists to settings", persisted === STARTUP_TARGET, persisted);

  await win.reload();
  await win.waitForSelector(".file-tree", { timeout: 20000 });
  await win.waitForTimeout(3500);
  const cwdBoot = await spawnCwd(win, "startup");
  check("terminal spawns at configured startup path", eqPath(cwdBoot, STARTUP_TARGET), `spawn cwd=${cwdBoot}`);

  await win.screenshot({ path: path.join(root, "test", "shot-final.png") });

  // --- summary ---
  const failed = results.filter((r) => !r.pass).length;
  const skipped = results.filter((r) => r.skipped).length;
  const passed = results.length - failed - skipped;
  log(`\n===== ${passed} passed, ${failed} failed, ${skipped} skipped (${process.platform}) =====`);
  fs.writeFileSync(path.join(root, "test", "e2e-result.json"), JSON.stringify({ platform: process.platform, results }, null, 2));

  clearTimeout(hard);
  try { await Promise.race([app.close(), new Promise((r) => setTimeout(r, 3000))]); } catch {}
  try { app.process().kill("SIGKILL"); } catch {}
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  process.exit(failed === 0 ? 0 : 1);
} catch (err) {
  console.error("[e2e] ERROR:", err?.stack || err);
  try { app?.process().kill("SIGKILL"); } catch {}
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  process.exit(3);
}
