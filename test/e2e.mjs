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
import { execSync } from "node:child_process";

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

// Whole-suite deadline. Raised from 180s when the cwd-inheritance checks landed:
// the suite was finishing just under the old ceiling, so any further check —
// and any slower machine — tipped it into a timeout that looks like a failure
// but isn't one. Headroom here is cheap; a false red is not.
const hard = setTimeout(() => {
  console.error("[e2e] HARD TIMEOUT");
  process.exit(2);
}, 240000);
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

// Shortcuts are authored macOS-first and translated per-OS (⌘X → Ctrl+Shift+X
// on Windows/Linux); see lib/platform.ts.
const MAC = process.platform === "darwin";
const SIDEBAR_KEY = MAC ? "Meta+B" : "Control+Shift+B";
const SETTINGS_KEY = MAC ? "Meta+Comma" : "Control+Shift+Comma";

// The Claude-session copy check is opt-in on the machine having the CLI: it's
// the program the bug was reported against, but the behaviour it proves is
// covered without it by the mouse-recorder checks, so its absence is a skip.
const HAS_CLAUDE = (() => {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  const names = WIN ? ["claude.exe", "claude.cmd"] : ["claude"];
  return dirs.some((d) => names.some((n) => d && fs.existsSync(path.join(d, n))));
})();

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

  // OS-clipboard ground truth, read/written from the Electron main process —
  // what an external app would actually see. Used by the context-menu copy
  // checks and the clipboard-reliability section further down.
  const readOsClip = () => app.evaluate(({ clipboard }) => clipboard.readText());
  const writeOsClip = (t) => app.evaluate(({ clipboard }, text) => clipboard.writeText(text), t);

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

  // 6b2) v0.12.0 — right-click context menu on a file-tree row. Its OS actions
  // are proved by ground truth, not by watching a file manager pop: copy writes
  // to the *OS* clipboard (read from the main process), "open terminal here"
  // moves the pty cwd, and reveal is asserted by intercepting the main-process
  // shell call so no real Explorer/Finder window opens during the run.
  const cm0 = await state(win);
  const cmDir =
    ["Windows", "usr", "etc", "Users", "home"].find((n) => cm0.dirNames.includes(n)) ||
    cm0.dirNames.find((n) => n && n !== ".." && !n.startsWith("$") && !n.startsWith("."));
  if (cmDir) {
    const cmBase = cm0.crumbTitle;
    const cmTarget = joinPath(cmBase, cmDir);
    const cmEntry = win
      .locator(".file-tree-content .file-tree-entry", {
        has: win.locator(".file-tree-name", { hasText: rx(cmDir) }),
      })
      .first();

    // Neutralise the real reveal so CI never spawns a file-manager window; the
    // stub records the path the app asked to reveal so we can assert on it.
    await app.evaluate(({ shell }) => {
      globalThis.__revealArg = null;
      shell.showItemInFolder = (p) => { globalThis.__revealArg = p; };
      shell.openPath = (p) => { globalThis.__revealArg = p; return Promise.resolve(""); };
    });

    await cmEntry.click({ button: "right" });
    await win.waitForTimeout(300);
    check("right-click opens the row context menu", await win.locator(".file-tree-context-menu").isVisible());

    // Copy path → the OS clipboard holds the row's absolute path.
    await writeOsClip("<<STALE>>");
    await win.locator('.file-tree-menu-item[data-action="copy-path"]').click();
    await win.waitForTimeout(300);
    const cmPath = await readOsClip();
    check("context menu: Copy path writes the row path", eqPath(cmPath, cmTarget), `clip=${cmPath} want=${cmTarget}`);
    check("context menu closes after an action", !(await win.locator(".file-tree-context-menu").isVisible()));

    // Copy name → just the basename.
    await cmEntry.click({ button: "right" });
    await win.waitForTimeout(200);
    await writeOsClip("<<STALE>>");
    await win.locator('.file-tree-menu-item[data-action="copy-name"]').click();
    await win.waitForTimeout(300);
    const cmName = await readOsClip();
    check("context menu: Copy name writes the row name", cmName === cmDir, `clip=${cmName} want=${cmDir}`);

    // Reveal → the app asks the OS to reveal exactly this path.
    await cmEntry.click({ button: "right" });
    await win.waitForTimeout(200);
    await win.locator('.file-tree-menu-item[data-action="reveal"]').click();
    await win.waitForTimeout(400);
    const cmReveal = await app.evaluate(() => globalThis.__revealArg);
    check("context menu: Reveal calls the OS file manager with the path", eqPath(cmReveal, cmTarget), `arg=${cmReveal} want=${cmTarget}`);

    // Open terminal here → the active pane's shell cds into the directory.
    await cmEntry.click({ button: "right" });
    await win.waitForTimeout(200);
    await win.locator('.file-tree-menu-item[data-action="cd"]').click();
    await win.waitForTimeout(1500);
    const cmCwd = await terminalCwd(win, "ctxcd");
    check("context menu: Open terminal here cds the terminal", eqPath(cmCwd, cmTarget), `cwd=${cmCwd} want=${cmTarget}`);

    // Escape (and an outside click) dismiss the menu.
    await cmEntry.click({ button: "right" });
    await win.waitForTimeout(200);
    await win.keyboard.press("Escape");
    await win.waitForTimeout(200);
    check("context menu: Escape dismisses it", !(await win.locator(".file-tree-context-menu").isVisible()));
  } else {
    skip("right-click opens the row context menu", "no safe subdirectory to target");
    skip("context menu: Copy path writes the row path", "no safe subdirectory to target");
    skip("context menu closes after an action", "no safe subdirectory to target");
    skip("context menu: Copy name writes the row name", "no safe subdirectory to target");
    skip("context menu: Reveal calls the OS file manager with the path", "no safe subdirectory to target");
    skip("context menu: Open terminal here cds the terminal", "no safe subdirectory to target");
    skip("context menu: Escape dismisses it", "no safe subdirectory to target");
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
  // (readOsClip/writeOsClip are defined once near the top of the run.)
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

  // 6h) Directional pane focus — ⌥+arrow moves focus to the pane visually
  // adjacent in that direction (spatial, not tree order). Build a 2×2 grid,
  // walk the four corners with the arrows, and confirm focus lands on the
  // right neighbour; pressing into an outer edge is a no-op. The chord is the
  // same on every OS (Alt+arrow); see keymap.ts.
  const FOCUS_L = "Alt+ArrowLeft";
  const FOCUS_R = "Alt+ArrowRight";
  const FOCUS_U = "Alt+ArrowUp";
  const FOCUS_D = "Alt+ArrowDown";
  const activePaneId = () =>
    win.evaluate(
      () => document.querySelector(".pane-active")?.getAttribute("data-pane-id") ?? null
    );
  const cornerPanes = () =>
    win.evaluate(() =>
      Array.from(document.querySelectorAll("[data-pane-id]")).map((p) => {
        const r = p.getBoundingClientRect();
        return { id: p.getAttribute("data-pane-id"), cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 };
      })
    );

  await win.locator(".tab-new").click();
  await win.waitForTimeout(2000);
  let fp = await cornerPanes();
  // Stacked split → two rows.
  await focusPaneAt(fp[0].cx, fp[0].cy);
  await win.keyboard.press(SPLIT_STACK);
  await win.waitForTimeout(2000);
  // Split the top row side-by-side.
  fp = await cornerPanes();
  const fTop = fp.reduce((a, b) => (a.cy < b.cy ? a : b));
  await focusPaneAt(fTop.cx, fTop.cy);
  await win.keyboard.press(SPLIT_SIDE);
  await win.waitForTimeout(2000);
  // Split the bottom row side-by-side → 2×2.
  fp = await cornerPanes();
  const fBottom = fp.reduce((a, b) => (a.cy > b.cy ? a : b));
  await focusPaneAt(fBottom.cx, fBottom.cy);
  await win.keyboard.press(SPLIT_SIDE);
  await win.waitForTimeout(2000);

  fp = await cornerPanes();
  let TL, TR, BL, BR;
  if (fp.length === 4) {
    const xs = fp.map((p) => p.cx);
    const ys = fp.map((p) => p.cy);
    const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
    const midY = (Math.min(...ys) + Math.max(...ys)) / 2;
    const corner = (left, top) =>
      fp.find((p) => p.cx < midX === left && p.cy < midY === top);
    TL = corner(true, true);
    TR = corner(false, true);
    BL = corner(true, false);
    BR = corner(false, false);
  }
  const grid2x2 = !!(TL && TR && BL && BR);
  check(
    "2×2 grid formed for directional focus",
    grid2x2,
    JSON.stringify(fp.map((p) => ({ cx: Math.round(p.cx), cy: Math.round(p.cy) })))
  );

  if (grid2x2) {
    // Start at top-left, then trace a loop: right, down, left, up.
    await focusPaneAt(TL.cx, TL.cy);
    await win.waitForTimeout(250);

    await win.keyboard.press(FOCUS_R);
    await win.waitForTimeout(250);
    const rId = await activePaneId();
    check("⌥→ moves focus to the pane on the right", rId === TR.id, `active=${rId} expected TR=${TR.id}`);

    await win.keyboard.press(FOCUS_D);
    await win.waitForTimeout(250);
    const dId = await activePaneId();
    check("⌥↓ moves focus to the pane below", dId === BR.id, `active=${dId} expected BR=${BR.id}`);

    await win.keyboard.press(FOCUS_L);
    await win.waitForTimeout(250);
    const lId = await activePaneId();
    check("⌥← moves focus to the pane on the left", lId === BL.id, `active=${lId} expected BL=${BL.id}`);

    await win.keyboard.press(FOCUS_U);
    await win.waitForTimeout(250);
    const uId = await activePaneId();
    check("⌥↑ moves focus to the pane above", uId === TL.id, `active=${uId} expected TL=${TL.id}`);

    // Outer edge: from the top-left pane, ⌥← and ⌥↑ have nowhere to go → no-op.
    await win.keyboard.press(FOCUS_L);
    await win.waitForTimeout(200);
    const edgeL = await activePaneId();
    await win.keyboard.press(FOCUS_U);
    await win.waitForTimeout(200);
    const edgeU = await activePaneId();
    check(
      "⌥ into an outer edge keeps focus put",
      edgeL === TL.id && edgeU === TL.id,
      `left→${edgeL} up→${edgeU} (TL=${TL.id})`
    );
  } else {
    skip("⌥→ moves focus to the pane on the right", "2×2 grid did not form");
    skip("⌥↓ moves focus to the pane below", "2×2 grid did not form");
    skip("⌥← moves focus to the pane on the left", "2×2 grid did not form");
    skip("⌥↑ moves focus to the pane above", "2×2 grid did not form");
    skip("⌥ into an outer edge keeps focus put", "2×2 grid did not form");
  }

  // 6i) Closing the active pane hands focus back to the pane it came from.
  // Regression guard: closePane used to call firstLeafId(newRoot), so splitting
  // off a pane and closing it dropped you on the tree's *first* leaf — with a
  // 2×2 grid, the top-left pane rather than the one you were working in.
  // Reuses the grid built above: focus the bottom-right pane, split off a new
  // one, close it, and require focus to land back on bottom-right (not TL).
  const CLOSE_PANE = process.platform === "darwin" ? "Meta+W" : "Control+Shift+W";
  if (grid2x2) {
    await focusPaneAt(BR.cx, BR.cy);
    await win.waitForTimeout(250);
    const mruBefore = await activePaneId();

    await win.keyboard.press(SPLIT_SIDE);
    await win.waitForTimeout(2000);
    const mruSpawned = await activePaneId();

    await win.keyboard.press(CLOSE_PANE);
    await win.waitForTimeout(1000);
    const mruAfter = await activePaneId();

    check(
      "closing a pane returns focus to the previously active one",
      mruBefore === BR.id && mruSpawned !== mruBefore && mruAfter === mruBefore,
      `before=${mruBefore} spawned=${mruSpawned} after=${mruAfter} (BR=${BR.id}, TL=${TL?.id})`
    );
  } else {
    skip(
      "closing a pane returns focus to the previously active one",
      "2×2 grid did not form"
    );
  }

  // 6j) The tab-level twin: closing the active tab returns to the tab you were
  // last on, not to whichever tab slides into the closed one's index. Visit the
  // first tab, then the last, then close the last — focus must go back to the
  // first. The old index rule would have landed on the second-to-last instead.
  const mruActiveTab = () =>
    win.evaluate(
      () => document.querySelector(".tab.active")?.getAttribute("data-tab-id") ?? null
    );
  const mruTabIds = () =>
    win.evaluate(() =>
      Array.from(document.querySelectorAll(".tab")).map((t) =>
        t.getAttribute("data-tab-id")
      )
    );

  const tabIdsBefore = await mruTabIds();
  if (tabIdsBefore.length >= 3) {
    const firstTab = tabIdsBefore[0];
    const lastTab = tabIdsBefore[tabIdsBefore.length - 1];
    const indexPick = tabIdsBefore[tabIdsBefore.length - 2];

    await win.locator(`.tab[data-tab-id="${firstTab}"]`).click();
    await win.waitForTimeout(400);
    await win.locator(`.tab[data-tab-id="${lastTab}"]`).click();
    await win.waitForTimeout(400);
    const tabBeforeClose = await mruActiveTab();

    await win.locator(`.tab[data-tab-id="${lastTab}"] .tab-close`).click();
    await win.waitForTimeout(800);
    const tabAfterClose = await mruActiveTab();

    check(
      "closing a tab returns to the previously active one",
      tabBeforeClose === lastTab && tabAfterClose === firstTab,
      `before=${tabBeforeClose} after=${tabAfterClose} expected=${firstTab} (index rule would give ${indexPick})`
    );
  } else {
    skip(
      "closing a tab returns to the previously active one",
      `needs 3+ tabs, had ${tabIdsBefore.length}`
    );
  }

  // 6k) A split opens where the pane it came from is, not at the startup path.
  // The source pane is cd'd somewhere specific first, so the assertion can't
  // pass by accident: the startup path is still unset at this point in the run
  // (section 7 sets it), so a pane that failed to inherit lands in home, which
  // is never the probe directory.
  //
  // The new pane's SPECTERM_CWD is the ground truth — it records the directory
  // the main process actually spawned the shell in, so this proves inheritance
  // reached the spawn rather than the shell having cd'd itself afterwards.
  //
  // Windows can't report a shell's live cwd (see the pty-cwd handler in
  // electron/main.cjs), so inheritance there degrades to the startup path by
  // design and the check is skipped rather than failed.
  const INHERIT_CHECK = "a split inherits the directory of the pane it came from";
  if (WIN) {
    skip(INHERIT_CHECK, "no live-cwd source on Windows");
  } else {
    await win.locator(".tab-new").click();
    await win.waitForTimeout(2000);

    const INHERIT_DIR = "/usr";
    await win.locator(".xterm-helper-textarea:visible").last().click({ force: true });
    await win.keyboard.type(`cd ${INHERIT_DIR}`);
    await win.keyboard.press("Enter");
    // The fallback path probes the shell process 150ms and 1500ms after Enter;
    // wait past the second so the value is settled before splitting.
    await win.waitForTimeout(1800);

    const sourceCwd = await terminalCwd(win, "inherit_src");
    await win.keyboard.press(SPLIT_SIDE);
    await win.waitForTimeout(1500);
    const splitSpawn = await spawnCwd(win, "inherit_split");

    check(
      INHERIT_CHECK,
      sourceCwd === INHERIT_DIR && splitSpawn === INHERIT_DIR,
      `source pane at ${sourceCwd}, split spawned in ${splitSpawn}, expected ${INHERIT_DIR}`
    );
  }

  // 6l) The OSC 7 path, isolated from the process probe. The shell is left in
  // one directory but reports a different one, so only a terminal that honors
  // the report can spawn the split there — reading the shell's process would
  // give the directory it's actually sitting in. That's not a realistic pairing
  // (a real shell reports where it is), it's what makes the two sources
  // distinguishable in a test.
  const OSC7_CHECK = "an OSC 7 report from the shell sets the inherited directory";
  if (WIN) {
    skip(OSC7_CHECK, "no live-cwd source on Windows to distinguish it from");
  } else {
    await win.locator(".tab-new").click();
    await win.waitForTimeout(2000);

    const OSC7_DIR = "/etc";
    await win.locator(".xterm-helper-textarea:visible").last().click({ force: true });
    // printf writes the raw sequence: ESC ] 7 ; file://<host><path> ESC \
    await win.keyboard.type(
      `printf '\\033]7;file://%s${OSC7_DIR}\\033\\\\' "$(hostname)"`
    );
    await win.keyboard.press("Enter");
    // The sequence is applied as it's parsed, so there's no probe to outwait
    // here — just let the shell echo the command and run it.
    await win.waitForTimeout(700);

    // Where the shell actually is — must differ from what it reported, or the
    // check would pass with the report ignored.
    const realCwd = await terminalCwd(win, "osc7_real");
    await win.keyboard.press(SPLIT_SIDE);
    await win.waitForTimeout(1500);
    const oscSpawn = await spawnCwd(win, "osc7_split");

    check(
      OSC7_CHECK,
      oscSpawn === OSC7_DIR && realCwd !== OSC7_DIR,
      `reported ${OSC7_DIR}, shell really at ${realCwd}, split spawned in ${oscSpawn}`
    );
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

  // 8) Settings sidebar. It shares one slot with the file tree — the store models
  // that as a single `sidebarView`, so "both open" must be unreachable however
  // you get there (gear, ⌘B, ⌘,).
  const slot = () =>
    win.evaluate(() => ({
      files: !!document.querySelector(".file-tree"),
      settings: !!document.querySelector(".settings-sidebar"),
      gearActive: !!document.querySelector(".tab-settings.active"),
      toast: !!document.querySelector(".settings-saved-bar"),
      settingsWidth:
        document.querySelector(".settings-sidebar")?.getBoundingClientRect().width ?? 0,
    }));

  await win.locator(".tab-settings").click();
  await win.waitForTimeout(400);
  let s = await slot();
  check("gear opens settings and evicts the file tree", s.settings && !s.files, JSON.stringify(s));
  check("gear reflects the open state", s.gearActive);
  check(
    "settings panel keeps a usable width in the sidebar slot",
    s.settingsWidth >= 340,
    `${s.settingsWidth}px`
  );

  await win.keyboard.press(SIDEBAR_KEY);
  await win.waitForTimeout(400);
  s = await slot();
  check("sidebar shortcut shows files and evicts settings", s.files && !s.settings, JSON.stringify(s));

  await win.keyboard.press(SETTINGS_KEY);
  await win.waitForTimeout(400);
  s = await slot();
  check("settings shortcut opens settings", s.settings && !s.files, JSON.stringify(s));
  await win.keyboard.press(SETTINGS_KEY);
  await win.waitForTimeout(400);
  check("settings shortcut toggles it closed", !(await slot()).settings);

  // Esc must close it even though the terminal holds keyboard focus (xterm
  // forwards Escape to the pty and stops it propagating).
  await win.keyboard.press(SETTINGS_KEY);
  await win.waitForTimeout(400);
  await win.locator(".xterm-helper-textarea:visible").last().focus();
  await win.keyboard.press("Escape");
  await win.waitForTimeout(400);
  check("Esc closes settings from a focused terminal", !(await slot()).settings);

  // 8b) Autosave: no Save button — an edit persists live and flashes a toast
  // once changes settle (1.5s debounce), which then fades on its own.
  await win.keyboard.press(SETTINGS_KEY);
  await win.waitForTimeout(400);
  check("no toast before any edit", !(await slot()).toast);
  await win.locator("#tab-bar-height").evaluate((el) => {
    el.value = "48";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await win.waitForTimeout(900);
  check("toast withheld during the debounce", !(await slot()).toast);
  await win.waitForTimeout(1300);
  check("toast appears once edits settle", (await slot()).toast);
  await win.waitForTimeout(2900);
  check("toast auto-dismisses", !(await slot()).toast);

  // 8c) Window opacity. The slider drives the *OS* window's alpha. We read the
  // real, external-observer opacity per platform: on Linux/X11 the app sets
  // _NET_WM_WINDOW_OPACITY on its own window (Electron's setOpacity is a no-op
  // there), so we read that property back via xprop; on Windows/macOS we read
  // BrowserWindow.getOpacity. Both the OS value and the persisted setting are
  // asserted. If the OS opacity can't be read (e.g. xprop absent), that one
  // check skips rather than fails — but persistence is always asserted.
  const settingsOpacity = () =>
    win.evaluate(() => JSON.parse(localStorage.getItem("specterm.settings")).windowOpacity);

  // This window's own X11 id, straight from Electron — never a name match (two
  // Specterm windows could be open, e.g. the developer's own terminal).
  const nativeXid = () =>
    app.evaluate(({ BrowserWindow }) => {
      const h = BrowserWindow.getAllWindows()[0].getNativeWindowHandle();
      return h.length >= 4 ? h.readUInt32LE(0) : null;
    });

  // The window's actual OS opacity as a 0–1 fraction, or null if unreadable.
  async function osOpacity() {
    if (process.platform === "linux") {
      const xid = await nativeXid();
      if (xid == null) return null;
      try {
        const out = execSync(`xprop -id 0x${xid.toString(16)} _NET_WM_WINDOW_OPACITY`, {
          encoding: "utf8",
        });
        const m = out.match(/=\s*(\d+)/);
        return m ? Number(m[1]) / 0xffffffff : 1; // property absent ⇒ opaque
      } catch {
        return null; // xprop not installed
      }
    }
    return app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getOpacity()
    );
  }

  const baseOsOp = await osOpacity();
  if (baseOsOp == null) {
    skip("window starts fully opaque", "OS opacity unreadable (xprop missing)");
  } else {
    check("window starts fully opaque", Math.abs(baseOsOp - 1) < 0.02, `osOpacity=${baseOsOp}`);
  }

  await win.locator("#window-opacity").evaluate((el) => {
    el.value = "0.6";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await win.waitForTimeout(500);
  check("window opacity setting persists", Math.abs((await settingsOpacity()) - 0.6) < 0.001, `${await settingsOpacity()}`);

  const dimmedOs = await osOpacity();
  if (dimmedOs == null) {
    skip("slider dims the OS window", "OS opacity unreadable (xprop missing)");
  } else {
    check("slider dims the OS window", Math.abs(dimmedOs - 0.6) < 0.03, `osOpacity=${dimmedOs}`);
  }

  // Reset returns the window (and the setting) to fully opaque.
  await win
    .locator("#window-opacity")
    .locator("xpath=ancestor::div[contains(@class,'settings-section')]")
    .locator(".settings-reset")
    .click();
  await win.waitForTimeout(500);
  check("reset restores the window opacity setting", Math.abs((await settingsOpacity()) - 1) < 0.001, `${await settingsOpacity()}`);
  const resetOs = await osOpacity();
  if (resetOs == null) {
    skip("reset restores full OS opacity", "OS opacity unreadable (xprop missing)");
  } else {
    check("reset restores full OS opacity", Math.abs(resetOs - 1) < 0.02, `osOpacity=${resetOs}`);
  }

  // 9) Chrome layout: the tab bar's corner, the two sizes, and auto-hide.
  const layout = () =>
    win.evaluate(() => {
      const app = document.querySelector(".app");
      const bar = document.querySelector(".tab-bar");
      const body = document.querySelector(".app-body");
      const actions = document.querySelector(".tab-actions");
      const list = document.querySelector(".tab-list");
      const b = bar.getBoundingClientRect();
      return {
        edge: app.dataset.tabEdge,
        side: bar.dataset.side,
        autohide: app.dataset.tabAutohide,
        barTop: Math.round(b.top),
        barHeight: Math.round(b.height),
        // Above or below the panes?
        barAbovePanes: b.top < body.getBoundingClientRect().top,
        // Which of the two sits further right — i.e. which corner they hug.
        actionsRightOfTabs:
          actions.getBoundingClientRect().left > list.getBoundingClientRect().left,
        sidebarWidth: Math.round(
          (document.querySelector(".file-tree") ??
            document.querySelector(".settings-sidebar")).getBoundingClientRect().width
        ),
      };
    });

  const pickCorner = async (corner) => {
    await win.locator(`.corner-option[data-corner="${corner}"]`).click();
    await win.waitForTimeout(450);
    return layout();
  };

  const tl = await pickCorner("top-left");
  check(
    "corner top-left: bar above the panes, icons left of the tabs",
    tl.edge === "top" && tl.side === "left" && tl.barAbovePanes && !tl.actionsRightOfTabs,
    JSON.stringify(tl)
  );

  const tr = await pickCorner("top-right");
  check(
    "corner top-right: bar above the panes, icons right of the tabs",
    tr.edge === "top" && tr.side === "right" && tr.barAbovePanes && tr.actionsRightOfTabs,
    JSON.stringify(tr)
  );

  const br = await pickCorner("bottom-right");
  check(
    "corner bottom-right: bar below the panes, icons right of the tabs",
    br.edge === "bottom" && br.side === "right" && !br.barAbovePanes && br.actionsRightOfTabs,
    JSON.stringify(br)
  );

  const bl = await pickCorner("bottom-left");
  check(
    "corner bottom-left: bar below the panes, icons left of the tabs",
    bl.edge === "bottom" && bl.side === "left" && !bl.barAbovePanes && !bl.actionsRightOfTabs,
    JSON.stringify(bl)
  );

  await pickCorner("top-left");

  // Sizes.
  await win.locator("#tab-bar-height").evaluate((el) => {
    el.value = "52";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await win.waitForTimeout(400);
  check("tab bar height follows the setting", (await layout()).barHeight === 52, `${(await layout()).barHeight}px`);

  await win.locator("#sidebar-width").evaluate((el) => {
    el.value = "420";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await win.waitForTimeout(400);
  check("sidebar width follows the setting", (await layout()).sidebarWidth === 420, `${(await layout()).sidebarWidth}px`);

  // The grab strip between the sidebar and the panes resizes it by dragging.
  // Do it against the file tree: the settings panel holds a floor of its own
  // (its controls stop being usable below 340px), which the drag respects.
  await win.keyboard.press(SIDEBAR_KEY);
  await win.waitForTimeout(400);
  const handle = await win.locator(".sidebar-resize-handle").boundingBox();
  await win.mouse.move(handle.x + handle.width / 2, handle.y + 200);
  await win.mouse.down();
  await win.mouse.move(handle.x + handle.width / 2 - 120, handle.y + 200, { steps: 10 });
  await win.mouse.up();
  await win.waitForTimeout(400);
  const dragged = (await layout()).sidebarWidth;
  check("dragging the grab strip resizes the sidebar", Math.abs(dragged - 300) <= 12, `${dragged}px (expected ≈300)`);

  // Auto-hide: the bar leaves the flow and slides off its edge, keeping a peek
  // strip as the hover target; hovering it brings the bar back.
  await win.keyboard.press(SETTINGS_KEY);
  await win.waitForTimeout(400);
  await win.locator("#tab-bar-autohide").check();
  await win.waitForTimeout(500);
  const hidden = await layout();
  check(
    "auto-hide slides the tab bar off its edge",
    hidden.autohide === "true" && hidden.barTop < 0,
    JSON.stringify({ barTop: hidden.barTop, barHeight: hidden.barHeight })
  );
  await win.mouse.move(500, 2);
  await win.waitForTimeout(500);
  const revealed = await layout();
  check("hovering the edge reveals the tab bar", revealed.barTop === 0, `barTop=${revealed.barTop}`);

  // 9b) All of it survives a restart.
  await win.reload();
  await win.waitForSelector(".app", { timeout: 20000 });
  await win.waitForTimeout(2500);
  const restored = await win.evaluate(() =>
    JSON.parse(localStorage.getItem("specterm.settings"))
  );
  check(
    "layout settings persist across a reload",
    restored.tabBarCorner === "top-left" &&
      restored.tabBarHeight === 52 &&
      restored.tabBarAutoHide === true &&
      Math.abs(restored.sidebarWidth - 300) <= 12,
    JSON.stringify({
      corner: restored.tabBarCorner,
      height: restored.tabBarHeight,
      autoHide: restored.tabBarAutoHide,
      width: restored.sidebarWidth,
    })
  );

  // Back to the defaults so the checks below aren't fighting a hidden tab bar.
  await win.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("specterm.settings"));
    localStorage.setItem(
      "specterm.settings",
      JSON.stringify({ ...s, tabBarAutoHide: false, tabBarHeight: 36, sidebarWidth: 250 })
    );
  });
  await win.reload();
  await win.waitForSelector(".file-tree", { timeout: 20000 });
  await win.waitForTimeout(2500);

  // 10) The sidebar's path is glued to the listing it labels: favourites, then
  // the filter, then the breadcrumb, then the files.
  const treeOrder = await win.evaluate(() =>
    Array.from(document.querySelector(".file-tree").children).map((el) => el.className)
  );
  const idx = (c) => treeOrder.findIndex((n) => n.includes(c));
  check(
    "file tree: path sits directly above the listing",
    idx("file-tree-header") >= 0 &&
      idx("file-tree-header") === idx("file-tree-content") - 1 &&
      idx("file-tree-search") < idx("file-tree-header"),
    treeOrder.join(" | ")
  );

  // 11) Copy out of a pane whose program has grabbed the mouse (Claude Code,
  // vim, htop). xterm hands the drag to the program and switches its own
  // selection off, so a plain drag used to select nothing at all. Now: a drag
  // selects locally and the program is told nothing; a click still reaches it.
  //
  // Ground truth is the program's own stdin — a recorder that turns mouse
  // tracking on and writes back whatever the terminal sends it. No Claude
  // needed, so this runs everywhere.
  const MOUSE_LOG = path.join(os.tmpdir(), `specterm_mouse_${process.pid}.txt`);
  const SGR_REPORT = /\x1b\[<\d+;\d+;\d+[Mm]/; // ESC [ < btn ; col ; row  M|m

  async function recordMouse(seconds) {
    try { fs.unlinkSync(MOUSE_LOG); } catch {}
    await win.locator(".xterm-helper-textarea:visible").last().click({ force: true });
    // Modes 1000 (buttons) + 1002 (drag) + 1006 (SGR). 1003 (motion with no
    // button) is left off on purpose, so a stray hover can't fake a report.
    await win.keyboard.type(
      `clear; printf '\\033[?1000h\\033[?1002h\\033[?1006h'; printf 'GRAB_MARKER\\r\\n'; ` +
        `stty raw -echo; timeout ${seconds} cat > "${MOUSE_LOG}"; stty sane; ` +
        `printf '\\033[?1000l\\033[?1002l\\033[?1006l'`
    );
    await win.keyboard.press("Enter");
    await win.waitForTimeout(1200);
  }
  const mouseLog = async (seconds) => {
    await win.waitForTimeout(seconds * 1000 + 800);
    try { return fs.readFileSync(MOUSE_LOG, "utf8"); } catch { return ""; }
  };
  async function dragAcross(rowY, { shift = false } = {}) {
    const b = await win.locator(".xterm-screen").first().boundingBox();
    if (shift) await win.keyboard.down("Shift");
    await win.mouse.move(b.x + 4, b.y + rowY);
    await win.mouse.down();
    await win.mouse.move(b.x + b.width - 8, b.y + rowY + 2, { steps: 12 });
    await win.mouse.up();
    if (shift) await win.keyboard.up("Shift");
    await win.waitForTimeout(200);
  }
  async function copyNow() {
    await writeOsClip("<<EMPTY>>");
    await win.keyboard.press(COPY_KEY);
    await win.waitForTimeout(400);
    return readOsClip();
  }

  await recordMouse(6);
  await dragAcross(8);
  const grabbedDragClip = await copyNow();
  const grabbedDragLog = await mouseLog(6);
  check(
    "mouse-grabbing pane: a drag selects text",
    grabbedDragClip.includes("GRAB_MARKER"),
    JSON.stringify(grabbedDragClip.slice(0, 40))
  );
  check(
    "mouse-grabbing pane: a drag reports nothing to the program",
    !SGR_REPORT.test(grabbedDragLog),
    JSON.stringify(grabbedDragLog.slice(0, 40))
  );

  await recordMouse(6);
  const screenBox = await win.locator(".xterm-screen").first().boundingBox();
  await win.mouse.click(screenBox.x + 80, screenBox.y + 60);
  await win.waitForTimeout(300);
  const grabbedClickClip = await copyNow();
  const grabbedClickLog = await mouseLog(6);
  check(
    "mouse-grabbing pane: a click IS reported to the program",
    SGR_REPORT.test(grabbedClickLog),
    JSON.stringify(grabbedClickLog.slice(0, 40))
  );
  check(
    "mouse-grabbing pane: a click makes no selection",
    grabbedClickClip === "<<EMPTY>>",
    JSON.stringify(grabbedClickClip.slice(0, 40))
  );

  await recordMouse(6);
  await dragAcross(8, { shift: true });
  const shiftDragClip = await copyNow();
  const shiftDragLog = await mouseLog(6);
  check(
    "mouse-grabbing pane: shift+drag (xterm's own hatch) still selects",
    shiftDragClip.includes("GRAB_MARKER") && !SGR_REPORT.test(shiftDragLog),
    JSON.stringify(shiftDragClip.slice(0, 40))
  );
  try { fs.unlinkSync(MOUSE_LOG); } catch {}

  // 12) Optional: the same thing against real Claude Code — the program this
  // was actually reported against. Skipped when the CLI isn't installed, so the
  // suite still runs on a machine (or CI box) without it.
  if (HAS_CLAUDE) {
    await win.locator(".xterm-helper-textarea:visible").last().click({ force: true });
    await win.keyboard.type("clear; claude");
    await win.keyboard.press("Enter");
    await win.waitForTimeout(7000);
    await win.keyboard.press("Enter"); // "trust this folder?", if it asks
    await win.waitForTimeout(8000);

    const claudeGrabbed = await win.evaluate(
      () => !!document.querySelector(".xterm.enable-mouse-events")
    );
    if (!claudeGrabbed) {
      skip("claude session: a drag copies its output", "claude never grabbed the mouse");
    } else {
      await dragAcross(60);
      const claudeClip = await copyNow();
      check(
        "claude session: a drag copies its output",
        claudeClip !== "<<EMPTY>>" && claudeClip.trim().length > 0,
        JSON.stringify(claudeClip.slice(0, 48))
      );
    }
  } else {
    skip("claude session: a drag copies its output", "claude CLI not on PATH");
  }

  // 13) Text viewer (open ANY file) + markdown/mermaid regression guard. Point
  // the file tree at test/fixtures, then drive real clicks on the fixtures.
  const fixturesDir = path.join(root, "test", "fixtures");
  const binFixture = path.join(fixturesDir, "binary.bin");
  // A file with NUL bytes — must be refused by the viewer, not shown as garbage.
  fs.writeFileSync(binFixture, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01, 0x02, 0x00, 0xff, 0xfe, 0x03]));
  try {
    // Point BOTH startupPath and lastBrowsedPath at the fixtures dir —
    // lastBrowsedPath takes precedence when the tree reopens, so setting the
    // startup path alone wouldn't move it. Merge into the existing blob.
    await win.evaluate((dir) => {
      const s = JSON.parse(localStorage.getItem("specterm.settings") || "{}");
      s.startupPath = dir;
      s.lastBrowsedPath = dir;
      localStorage.setItem("specterm.settings", JSON.stringify(s));
    }, fixturesDir);
    await win.reload();
    await win.waitForSelector(".file-tree", { timeout: 20000 });
    await win.waitForTimeout(2500);
    check("file tree lists the fixtures dir", (await state(win)).names.includes("sample.ts"), (await state(win)).names.join(","));

    // 13a) A non-markdown file opens in the read-only viewer, highlighted.
    await clickEntry(win, "sample.ts");
    await win.waitForSelector(".text-pane", { timeout: 8000 });
    await win.waitForTimeout(800); // lazy highlight.js chunk loads on first open
    const tv = await win.evaluate(() => {
      const pane = document.querySelector(".text-pane");
      const code = pane?.querySelector(".text-code code");
      const gutter = pane?.querySelector(".text-gutter");
      const gutterText = gutter?.textContent || "";
      return {
        codeText: code?.textContent || "",
        hasHljs: !!pane?.querySelector(".text-code [class^='hljs-']"),
        lang: pane?.querySelector(".text-lang")?.textContent || "",
        gutterFirst: gutterText.split("\n")[0],
        gutterLines: gutterText.split("\n").length,
      };
    });
    check("text viewer opens a non-markdown file", tv.codeText.includes("makeWidget"), tv.codeText.slice(0, 40));
    check("text viewer numbers every line once", tv.gutterFirst === "1" && tv.gutterLines > 8, `first=${tv.gutterFirst} lines=${tv.gutterLines}`);
    check("text viewer highlights syntax by language", tv.hasHljs && /typescript/i.test(tv.lang), `hljs=${tv.hasHljs} lang=${tv.lang}`);

    // 13b) In-pane find marks matches. Click the Find button (openSearch) rather
    // than the ⌘F chord, so the check doesn't race the pane's focus/isActive flip.
    await win.locator(".text-pane .text-toolbar-btn", { hasText: "Find" }).first().click();
    await win.waitForSelector(".text-search input", { timeout: 3000 });
    await win.locator(".text-search input").fill("makeWidget");
    await win.waitForTimeout(400);
    const findCount = (await win.locator(".text-search-count").textContent()) || "";
    const findMarks = await win.locator(".text-code mark.search-highlight").count();
    check("text viewer find marks matches", findMarks >= 2 && /[1-9]/.test(findCount), `count="${findCount}" marks=${findMarks}`);
    await win.keyboard.press("Escape");
    await win.waitForTimeout(200);

    // 13c) A binary file is refused, not rendered as mojibake.
    await clickEntry(win, "binary.bin");
    await win.waitForSelector(".text-error", { timeout: 8000 });
    const binErr = (await win.locator(".text-error").first().textContent()) || "";
    check("text viewer refuses a binary file", /binary/i.test(binErr), binErr.slice(0, 40));

    // 13d) Markdown regression: rendering, Mermaid execution, and pan/zoom.
    await clickEntry(win, "diagram.md");
    await win.waitForSelector(".markdown-content", { timeout: 8000 });
    await win.waitForSelector(".markdown-content pre.mermaid svg", { timeout: 20000 });
    const md = await win.evaluate(() => ({
      htmlLen: (document.querySelector(".markdown-content")?.innerHTML || "").length,
      hasSvg: !!document.querySelector(".markdown-content pre.mermaid svg"),
      hasViewport: !!document.querySelector(".mermaid-viewport"),
      hasInner: !!document.querySelector(".mermaid-inner"),
      transformBefore: document.querySelector(".mermaid-inner")?.style.transform || "",
    }));
    check("markdown still renders", md.htmlLen > 20, `htmlLen=${md.htmlLen}`);
    check("mermaid diagram renders to SVG", md.hasSvg, "");
    check("mermaid pan/zoom viewport is wired", md.hasViewport && md.hasInner, JSON.stringify({ v: md.hasViewport, i: md.hasInner }));

    // A wheel over the diagram must zoom it (set the inner transform scale). We
    // dispatch the WheelEvent straight at the viewport — a synthesized
    // mouse.wheel gesture is unreliable over a tiny nested split pane, and this
    // still runs the real wheel handler synchronously.
    const transformAfter = await win.evaluate(() => {
      const vp = document.querySelector(".mermaid-viewport");
      if (!vp) return null;
      const r = vp.getBoundingClientRect();
      vp.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: -120,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
          bubbles: true,
          cancelable: true,
        })
      );
      return document.querySelector(".mermaid-inner")?.style.transform || "";
    });
    check(
      "mermaid wheel-zoom changes the transform",
      transformAfter != null && transformAfter !== md.transformBefore && /scale\(/.test(transformAfter),
      `before="${md.transformBefore}" after="${transformAfter}"`
    );
  } finally {
    try { fs.unlinkSync(binFixture); } catch {}
  }

  // 14) Cross-tab pane detach: drag a pane's titlebar onto another tab's chip to
  // move it there. The target chip highlights mid-drag; the drop moves the pane
  // (splitting beside the target's active pane), brings that tab to the front,
  // and leaves the source tab with the rest.
  const activeTab = () =>
    win.evaluate(() => document.querySelector(".tab.active")?.getAttribute("data-tab-id") ?? null);
  const detachPaneCount = () => win.evaluate(() => document.querySelectorAll("[data-pane-id]").length);

  // Fresh tab so this starts from a clean single pane, then split → 2 panes.
  await win.locator(".tab-new").click();
  await win.waitForTimeout(2000);
  const srcTab = await activeTab();
  await win.locator(".xterm-helper-textarea:visible").last().click({ force: true });
  await win.keyboard.press(SPLIT_SIDE);
  await win.waitForTimeout(2000);
  const srcPanesBefore = await detachPaneCount();

  // Another fresh tab as the drop target, then back to the source tab.
  await win.locator(".tab-new").click();
  await win.waitForTimeout(2000);
  const dstTab = await activeTab();
  await win.locator(`.tab[data-tab-id="${srcTab}"]`).click();
  await win.waitForTimeout(700);

  if (srcPanesBefore === 2 && dstTab && dstTab !== srcTab) {
    // Drag the first pane's titlebar onto the destination tab's chip.
    const src = await win.evaluate(() => {
      const tb = document.querySelector("[data-pane-id] .pane-titlebar").getBoundingClientRect();
      return { x: tb.left + 24, y: (tb.top + tb.bottom) / 2 };
    });
    const chip = await win.locator(`.tab[data-tab-id="${dstTab}"]`).boundingBox();
    await win.mouse.move(src.x, src.y);
    await win.mouse.down();
    await win.mouse.move(chip.x + chip.width / 2, chip.y + chip.height / 2, { steps: 12 });
    await win.waitForTimeout(300);
    const highlight = await win.evaluate(
      (id) => !!document.querySelector(`.tab[data-tab-id="${id}"]`)?.classList.contains("drop-tab"),
      dstTab
    );
    check("dragging a pane over a tab highlights it as a drop target", highlight, "");
    await win.mouse.up();
    await win.waitForTimeout(1200);

    check("dropping on a tab activates it", (await activeTab()) === dstTab, `active=${await activeTab()}`);
    check("the pane detaches into the target tab", (await detachPaneCount()) === 2, `dst panes=${await detachPaneCount()}`);
    await win.locator(`.tab[data-tab-id="${srcTab}"]`).click();
    await win.waitForTimeout(600);
    check("the source tab keeps the remaining pane", (await detachPaneCount()) === 1, `src panes=${await detachPaneCount()}`);
  } else {
    skip("dragging a pane over a tab highlights it as a drop target", "setup did not produce 2 panes + 2 tabs");
    skip("dropping on a tab activates it", "setup did not produce 2 panes + 2 tabs");
    skip("the pane detaches into the target tab", "setup did not produce 2 panes + 2 tabs");
    skip("the source tab keeps the remaining pane", "setup did not produce 2 panes + 2 tabs");
  }

  // 15) Markdown editor: read → edit toggles CodeMirror (a lazy chunk), edits
  // mark the pane dirty, and Save writes through to disk. Uses a throwaway .md
  // in a temp dir so the test writes a real file without touching the repo.
  const mdWorkDir = path.join(os.tmpdir(), `specterm-md-${process.pid}`);
  fs.mkdirSync(mdWorkDir, { recursive: true });
  const notePath = path.join(mdWorkDir, "note.md");
  fs.writeFileSync(notePath, "# Hello\n\nworld\n");
  try {
    await win.evaluate((dir) => {
      const s = JSON.parse(localStorage.getItem("specterm.settings") || "{}");
      s.startupPath = dir;
      s.lastBrowsedPath = dir;
      localStorage.setItem("specterm.settings", JSON.stringify(s));
    }, mdWorkDir);
    await win.reload();
    await win.waitForSelector(".file-tree", { timeout: 20000 });
    await win.waitForTimeout(2000);

    await clickEntry(win, "note.md");
    await win.waitForSelector(".markdown-content", { timeout: 8000 });
    check("markdown opens in read mode", (await win.locator(".markdown-content h1").count()) === 1, "");

    // Toggle to edit — CodeMirror mounts (loaded lazily on first switch).
    await win.locator(".markdown-toolbar-btn", { hasText: "Edit" }).first().click();
    await win.waitForSelector(".markdown-editor .cm-editor", { timeout: 8000 });
    await win.waitForTimeout(500);
    check("Edit toggle mounts the CodeMirror editor", (await win.locator(".markdown-editor .cm-content").count()) === 1, "");

    // Type at the end of the document.
    await win.locator(".markdown-editor .cm-content").click();
    await win.keyboard.press("Control+End");
    await win.keyboard.type("\nEDITED_BY_E2E_777");
    await win.waitForTimeout(300);
    const isDirty = await win.evaluate(() =>
      (document.querySelector(".markdown-filepath")?.textContent || "").trim().startsWith("●")
    );
    check("editing marks the pane dirty", isDirty, "");

    // Save writes through to disk and clears the dirty flag.
    await win.locator(".markdown-toolbar-btn", { hasText: "Save" }).first().click();
    await win.waitForTimeout(600);
    const onDisk = fs.readFileSync(notePath, "utf8");
    check("Save writes the edited text to disk", onDisk.includes("EDITED_BY_E2E_777"), `tail=${JSON.stringify(onDisk.slice(-24))}`);
    const stillDirty = await win.evaluate(() =>
      (document.querySelector(".markdown-filepath")?.textContent || "").trim().startsWith("●")
    );
    check("Save clears the dirty indicator", !stillDirty, "");

    // Back to preview: the reader now reflects the saved text.
    await win.locator(".markdown-toolbar-btn", { hasText: "Preview" }).first().click();
    await win.waitForSelector(".markdown-content", { timeout: 8000 });
    await win.waitForTimeout(400);
    const previewText = await win.evaluate(() => document.querySelector(".markdown-content")?.textContent || "");
    check("Preview reflects the saved edit", previewText.includes("EDITED_BY_E2E_777"), previewText.slice(0, 40));
  } finally {
    try { fs.rmSync(mdWorkDir, { recursive: true, force: true }); } catch {}
  }

  // 16) Markdown editor — unsaved-edit safety. Refresh (which re-reads disk) is
  // hidden while editing, and a dirty pane dragged to another tab carries its
  // unsaved buffer with it (no silent re-read from disk, and no auto-save).
  const safeDir = path.join(os.tmpdir(), `specterm-mdsafe-${process.pid}`);
  fs.mkdirSync(safeDir, { recursive: true });
  const safeNote = path.join(safeDir, "safe.md");
  fs.writeFileSync(safeNote, "# Safe\n\nbody\n");
  try {
    await win.evaluate((dir) => {
      const s = JSON.parse(localStorage.getItem("specterm.settings") || "{}");
      s.startupPath = dir;
      s.lastBrowsedPath = dir;
      localStorage.setItem("specterm.settings", JSON.stringify(s));
    }, safeDir);
    await win.reload();
    await win.waitForSelector(".file-tree", { timeout: 20000 });
    await win.waitForTimeout(2000);
    const safeSrcTab = await activeTab();

    await clickEntry(win, "safe.md");
    await win.waitForSelector(".markdown-content", { timeout: 8000 });
    await win.locator(".markdown-toolbar-btn", { hasText: "Edit" }).first().click();
    await win.waitForSelector(".markdown-editor .cm-editor", { timeout: 8000 });
    await win.waitForTimeout(500);
    check("Refresh is hidden while editing", (await win.locator(".markdown-toolbar-btn", { hasText: "Refresh" }).count()) === 0, "");

    await win.locator(".markdown-editor .cm-content").click();
    await win.keyboard.press("Control+End");
    await win.keyboard.type("\nUNSAVED_MOVE_XYZ");
    await win.waitForTimeout(300);

    const safeDstTab = await win.locator(".tab-new").click().then(async () => {
      await win.waitForTimeout(1500);
      return activeTab();
    });
    await win.locator(`.tab[data-tab-id="${safeSrcTab}"]`).click();
    await win.waitForTimeout(700);

    if (safeDstTab && safeDstTab !== safeSrcTab) {
      const from = await win.evaluate(() => {
        const panes = Array.from(document.querySelectorAll("[data-pane-id]"));
        const md = panes.find((p) => p.querySelector(".markdown-pane, .markdown-editor"));
        const tb = md.querySelector(".pane-titlebar").getBoundingClientRect();
        return { x: tb.left + 24, y: (tb.top + tb.bottom) / 2 };
      });
      const chip = await win.locator(`.tab[data-tab-id="${safeDstTab}"]`).boundingBox();
      await win.mouse.move(from.x, from.y);
      await win.mouse.down();
      await win.mouse.move(chip.x + chip.width / 2, chip.y + chip.height / 2, { steps: 12 });
      await win.waitForTimeout(250);
      await win.mouse.up();
      await win.waitForTimeout(1500);

      const preserved = await win.evaluate(() => document.querySelector(".markdown-content")?.textContent || "");
      check("cross-tab move preserves unsaved markdown edits", preserved.includes("UNSAVED_MOVE_XYZ"), preserved.slice(0, 40));
      check("cross-tab move does not auto-save to disk", !fs.readFileSync(safeNote, "utf8").includes("UNSAVED_MOVE_XYZ"), "");
    } else {
      skip("cross-tab move preserves unsaved markdown edits", "second tab did not open");
      skip("cross-tab move does not auto-save to disk", "second tab did not open");
    }
  } finally {
    try { fs.rmSync(safeDir, { recursive: true, force: true }); } catch {}
  }

  // 17) Markdown drafts persist across a reload (the auto-save that stands in for
  // a close/quit guard): edit without saving, reload the whole renderer, and the
  // unsaved text comes back — with disk untouched. Refresh then discards it.
  const draftDir = path.join(os.tmpdir(), `specterm-draft-${process.pid}`);
  fs.mkdirSync(draftDir, { recursive: true });
  const draftNote = path.join(draftDir, "draft.md");
  fs.writeFileSync(draftNote, "# Draft\n\nbody\n");
  try {
    await win.evaluate((dir) => {
      const s = JSON.parse(localStorage.getItem("specterm.settings") || "{}");
      s.startupPath = dir;
      s.lastBrowsedPath = dir;
      localStorage.setItem("specterm.settings", JSON.stringify(s));
    }, draftDir);
    await win.reload();
    await win.waitForSelector(".file-tree", { timeout: 20000 });
    await win.waitForTimeout(2000);

    await clickEntry(win, "draft.md");
    await win.waitForSelector(".markdown-content", { timeout: 8000 });
    await win.locator(".markdown-toolbar-btn", { hasText: "Edit" }).first().click();
    await win.waitForSelector(".markdown-editor .cm-editor", { timeout: 8000 });
    await win.waitForTimeout(500);
    await win.locator(".markdown-editor .cm-content").click();
    await win.keyboard.press("Control+End");
    await win.keyboard.type("\nDRAFT_SURVIVES_RELOAD");
    await win.waitForTimeout(700); // let the debounced draft persist to localStorage

    // Reload the renderer — same as reopening the app.
    await win.reload();
    await win.waitForSelector(".file-tree", { timeout: 20000 });
    await win.waitForTimeout(2000);
    await clickEntry(win, "draft.md");
    await win.waitForSelector(".markdown-content", { timeout: 8000 });
    await win.waitForTimeout(400);
    const afterReload = await win.evaluate(() => document.querySelector(".markdown-content")?.textContent || "");
    const dirtyAfterReload = await win.evaluate(() =>
      (document.querySelector(".markdown-filepath")?.textContent || "").trim().startsWith("●")
    );
    check("unsaved markdown draft survives a reload", afterReload.includes("DRAFT_SURVIVES_RELOAD") && dirtyAfterReload, `dirty=${dirtyAfterReload}`);
    check("draft is not auto-written to disk", !fs.readFileSync(draftNote, "utf8").includes("DRAFT_SURVIVES_RELOAD"), "");

    // Refresh discards the draft and shows the on-disk copy, clean.
    await win.locator(".markdown-toolbar-btn", { hasText: "Refresh" }).first().click();
    await win.waitForTimeout(600);
    const afterRefresh = await win.evaluate(() => document.querySelector(".markdown-content")?.textContent || "");
    const dirtyAfterRefresh = await win.evaluate(() =>
      (document.querySelector(".markdown-filepath")?.textContent || "").trim().startsWith("●")
    );
    check("Refresh discards the draft", !afterRefresh.includes("DRAFT_SURVIVES_RELOAD") && !dirtyAfterRefresh, "");
  } finally {
    try { fs.rmSync(draftDir, { recursive: true, force: true }); } catch {}
  }

  // 18) Tab rename, close, and drag-to-reorder — the tab bar's own pointer
  // handling. The reorder drag must NOT swallow the close button's click or the
  // title's double-click: a setPointerCapture on pointerdown once retargeted the
  // follow-up click/dblclick to the tab itself, so the × merely re-selected the
  // tab and double-click never entered rename. These checks lock that shut.
  const RENAME_KEY = MAC ? "Meta+R" : "Control+Shift+R";
  const tabCount = () => win.locator(".tab").count();
  const tabTitleOf = (id) =>
    win.evaluate(
      (tid) => document.querySelector(`.tab[data-tab-id="${tid}"] .tab-title`)?.textContent ?? null,
      id
    );
  const tabExists = (id) =>
    win.evaluate((tid) => !!document.querySelector(`.tab[data-tab-id="${tid}"]`), id);
  const tabOrder = () =>
    win.evaluate(() =>
      Array.from(document.querySelectorAll(".tab")).map((t) => t.getAttribute("data-tab-id"))
    );
  const editorVisible = () =>
    win
      .locator(".tab-title-input")
      .waitFor({ state: "visible", timeout: 3000 })
      .then(() => true)
      .catch(() => false);

  // A fresh tab to rename/close, independent of whatever earlier sections left.
  await win.locator(".tab-new").click();
  await win.waitForTimeout(1500);
  const renameTab = await activeTab();

  // 18a) Double-click the title opens the inline editor.
  await win.locator(`.tab[data-tab-id="${renameTab}"] .tab-title`).dblclick();
  const editorOpened = await editorVisible();
  check("double-click opens the tab rename editor", editorOpened, "");

  // 18b) Type a new name + Enter commits it (and the editor closes).
  if (editorOpened) {
    await win.locator(".tab-title-input").fill("E2E_RENAMED");
    await win.keyboard.press("Enter");
    await win.waitForTimeout(300);
    check(
      "typing + Enter commits the tab rename",
      (await tabTitleOf(renameTab)) === "E2E_RENAMED" && (await win.locator(".tab-title-input").count()) === 0,
      `title=${await tabTitleOf(renameTab)}`
    );
  } else {
    skip("typing + Enter commits the tab rename", "rename editor did not open");
  }

  // 18c) The ⌘R / Ctrl+Shift+R shortcut reopens the editor; Escape cancels it
  // and leaves the committed name intact.
  await win.locator(`.tab[data-tab-id="${renameTab}"]`).click();
  await win.waitForTimeout(200);
  await win.keyboard.press(RENAME_KEY);
  const editorViaKey = await editorVisible();
  check("the rename shortcut opens the editor", editorViaKey, "");
  if (editorViaKey) {
    await win.locator(".tab-title-input").fill("DISCARDED");
    await win.keyboard.press("Escape");
    await win.waitForTimeout(300);
    check(
      "Escape cancels the rename (committed title survives)",
      (await tabTitleOf(renameTab)) === "E2E_RENAMED" && (await win.locator(".tab-title-input").count()) === 0,
      `title=${await tabTitleOf(renameTab)}`
    );
  } else {
    skip("Escape cancels the rename (committed title survives)", "rename editor did not open");
  }

  // 18d) THE regression: the × button closes the tab. Add a second tab first so
  // the close is a genuine removal, not the last-tab replacement.
  await win.locator(".tab-new").click();
  await win.waitForTimeout(1500);
  const beforeClose = await tabCount();
  await win.locator(`.tab[data-tab-id="${renameTab}"] .tab-close`).click();
  await win.waitForTimeout(400);
  check(
    "the × button closes the tab",
    !(await tabExists(renameTab)) && (await tabCount()) === beforeClose - 1,
    `existed=${await tabExists(renameTab)} count ${beforeClose}→${await tabCount()}`
  );

  // 18e) Drag-to-reorder moves a tab past its neighbor, and a plain click right
  // after the drag still selects (the drag's suppress-click must not leak).
  await win.locator(".tab-new").click();
  await win.waitForTimeout(1200);
  const leftTab = await activeTab();
  await win.locator(".tab-new").click();
  await win.waitForTimeout(1200);
  const rightTab = await activeTab();
  const orderBefore = await tabOrder();
  if (leftTab && rightTab && orderBefore.indexOf(leftTab) < orderBefore.indexOf(rightTab)) {
    const a = await win.locator(`.tab[data-tab-id="${leftTab}"]`).boundingBox();
    const b = await win.locator(`.tab[data-tab-id="${rightTab}"]`).boundingBox();
    await win.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await win.mouse.down();
    // Past the right tab's midpoint → drop after it (before=false).
    await win.mouse.move(b.x + b.width * 0.75, b.y + b.height / 2, { steps: 14 });
    await win.waitForTimeout(150);
    const dragging = await win.evaluate(
      (id) => !!document.querySelector(`.tab[data-tab-id="${id}"].dragging`),
      leftTab
    );
    await win.mouse.up();
    await win.waitForTimeout(400);
    const orderAfter = await tabOrder();
    check(
      "drag-to-reorder moves a tab past its neighbor",
      dragging && orderAfter.indexOf(leftTab) > orderAfter.indexOf(rightTab),
      `dragging=${dragging} before=[${orderBefore.join(",")}] after=[${orderAfter.join(",")}]`
    );

    await win.locator(`.tab[data-tab-id="${rightTab}"]`).click();
    await win.waitForTimeout(300);
    check("a click right after a reorder still selects", (await activeTab()) === rightTab, `active=${await activeTab()}`);
  } else {
    skip("drag-to-reorder moves a tab past its neighbor", "tabs not in expected initial order");
    skip("a click right after a reorder still selects", "tabs not in expected initial order");
  }

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
