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

// Have the active-pane shell write its CWD to a temp file, then read it back.
async function terminalCwd(win, marker, timeoutMs = 12000) {
  const outFile = path.join(os.tmpdir(), `specterm_${marker}.txt`);
  try { fs.unlinkSync(outFile); } catch {}
  const cmd = WIN
    ? `(Get-Location).Path | Out-File -Encoding ascii -FilePath "${outFile}"`
    : `pwd > "${outFile}"`;
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

// Run against a throwaway Electron profile so the suite never touches the
// developer's real settings/favorites/theme (localStorage lives in userData).
const userDataDir = path.join(os.tmpdir(), `specterm-e2e-${process.pid}-${Date.now()}`);
fs.mkdirSync(userDataDir, { recursive: true });

// Which key splits a pane side-by-side. macOS uses the ⌘-scheme (⌘⇧D); Windows
// and Linux keep the original "kitty" chord (Ctrl+Shift+Enter). See keymap.ts.
const SPLIT_SIDE = process.platform === "darwin" ? "Meta+Shift+D" : "Control+Shift+Enter";

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

  // Boot terminal cwd == home (blank startupPath).
  await win.waitForTimeout(2500);
  const cwd0 = await terminalCwd(win, "boot");
  check("terminal spawns at home (blank startupPath)", eqPath(cwd0, home), `pty cwd=${cwd0}`);

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
  const cwdBoot = await terminalCwd(win, "startup");
  check("terminal spawns at configured startup path", eqPath(cwdBoot, STARTUP_TARGET), `pty cwd=${cwdBoot}`);

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
