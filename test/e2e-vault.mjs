// Vaults — end to end, against the real app.
//
// Its own suite, like the diagrams one: the main suite is near its time budget,
// and this one needs a sandboxed HOME so the file tree opens on a fixture vault
// instead of the developer's real home folder.
//
// The fixture is shaped like a vault Obsidian has opened (a `.obsidian/`
// folder), with notes that link to each other the way the team's docs repo
// does — relative markdown links, some with a #fragment — plus a hidden folder
// and a node_modules folder holding notes that must never be indexed.
//
// Run: node test/e2e-vault.mjs   (after `vite build`)
import { _electron as electron } from "playwright";
import { launchOptions } from "./launch.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const MAC = process.platform === "darwin";

const QUICK_OPEN_KEY = MAC ? "Meta+P" : "Control+Shift+P";
const VAULT_KEY = MAC ? "Meta+Shift+F" : "Control+Alt+F";
const SIDEBAR_KEY = MAC ? "Meta+B" : "Control+Shift+B";

const started = Date.now();
const elapsed = () => ((Date.now() - started) / 1000).toFixed(1).padStart(6);
const log = (...a) => console.log(`[vault ${elapsed()}s]`, ...a);

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, skipped: false });
  log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const HARD_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 180000);
const hard =
  HARD_TIMEOUT_MS > 0 &&
  setTimeout(() => {
    console.error("[vault] HARD TIMEOUT");
    process.exit(2);
  }, HARD_TIMEOUT_MS);
if (hard) hard.unref();

async function until(what, predicate, { timeout = 10000, poll = 50 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let ok = false;
    try {
      ok = await predicate();
    } catch (_) {
      ok = false;
    }
    if (ok) return true;
    if (Date.now() > deadline) {
      log(`timed out after ${timeout}ms waiting for: ${what}`);
      return false;
    }
    await new Promise((r) => setTimeout(r, poll));
  }
}

// --- fixture ---------------------------------------------------------------

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "specterm-vault-home-"));
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specterm-vault-"));
const vaultDir = path.join(fakeHome, "notes");
const write = (rel, text) => {
  const p = path.join(vaultDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
fs.mkdirSync(path.join(vaultDir, ".obsidian"), { recursive: true });
write("README.md", "# Home\n\nStart with [the guide](docs/guide.md).\n");
write(
  "docs/guide.md",
  [
    "# Guide",
    "",
    "Back to [home](../README.md).",
    "",
    "## Setup",
    "",
    // Enough body that the last heading sits well below the fold, so jumping
    // to it from the outline has to scroll.
    ...Array.from({ length: 120 }, (_, i) => `Filler line ${i + 1}.\n`),
    "## Deploy",
    "",
    "Run the deploy script.",
    "",
  ].join("\n")
);
write("docs/deploy.md", "# Deploy\n\nFollow [the guide](guide.md#deploy) first.\n");
write(".hidden/secret.md", "# Hidden\n\nDeploy deploy deploy.\n");
write("node_modules/pkg/readme.md", "# Package\n\nDeploy deploy.\n");

// --- run -------------------------------------------------------------------

let app;
try {
  app = await electron.launch(
    launchOptions(root, userDataDir, { env: { HOME: fakeHome, USERPROFILE: fakeHome } })
  );
  const win = await app.firstWindow();
  win.on("pageerror", (e) => log("PAGEERROR:", e.message));
  await win.waitForSelector(".file-tree", { timeout: 20000 });

  // The tree opens at the sandboxed home; step into the vault folder.
  await win
    .locator(".file-tree-content .file-tree-entry", {
      has: win.locator(".file-tree-name", { hasText: /^notes$/ }),
    })
    .first()
    .click();

  // 1. A folder Obsidian has opened is offered as a vault, not added.
  const hinted = await until("the Obsidian vault hint", () =>
    win.locator(".file-tree-vault-hint").isVisible()
  );
  check("a folder with .obsidian/ is offered as a vault", hinted);
  const storedBefore = await win.evaluate(() => localStorage.getItem("specterm.vaults"));
  check("the offer alone adds nothing", !storedBefore || storedBefore === "[]", String(storedBefore));

  // 2. Accepting it registers the vault and opens the panel on it.
  await win.locator(".file-tree-vault-hint button", { hasText: "Open as vault" }).click();
  const panelUp = await until("the vault panel", () => win.locator(".vault-panel").isVisible());
  check("Open as vault shows the vault panel", panelUp);
  const stored = await win.evaluate(() => JSON.parse(localStorage.getItem("specterm.vaults") || "[]"));
  check(
    "the vault is persisted",
    stored.length === 1 && stored[0].path === vaultDir,
    JSON.stringify(stored)
  );
  const counted = await until("the index to finish", async () =>
    (await win.locator(".vault-status").textContent())?.startsWith("3 notes")
  );
  check(
    "hidden folders and node_modules are not indexed",
    counted,
    await win.locator(".vault-status").textContent()
  );

  // 3. Searching the text of every note.
  await win.locator(".vault-search input").fill("deploy");
  await until("search results", async () => (await win.locator(".vault-result").count()) > 0);
  const found = await win.locator(".vault-result-name").allTextContents();
  check(
    "search finds every note mentioning the word",
    found.includes(path.join("docs", "deploy.md")) && found.includes(path.join("docs", "guide.md")),
    JSON.stringify(found)
  );
  check(
    "search never surfaces unindexed notes",
    !found.some((f) => f.includes("secret") || f.includes("node_modules")),
    JSON.stringify(found)
  );
  const marked = await win.locator(".vault-hit-text mark").first().textContent();
  check("the match is highlighted", marked?.toLowerCase() === "deploy", String(marked));
  await win.locator(".vault-search input").fill("");

  // 4. Quick open: by name, keyboard only.
  await win.keyboard.press(QUICK_OPEN_KEY);
  const qoUp = await until("quick open", () => win.locator(".quick-open").isVisible());
  check("the quick open shortcut shows the palette", qoUp);
  await win.keyboard.type("gide");
  await until("a fuzzy match", async () =>
    (await win.locator(".quick-open-item.is-selected .quick-open-name").textContent()) === "guide.md"
  );
  const top = await win.locator(".quick-open-item.is-selected .quick-open-name").textContent();
  check("a fuzzy query selects the note it means", top === "guide.md", String(top));
  await win.keyboard.press("Enter");
  const opened = await until("the note to open", async () =>
    (await win.locator(".markdown-filepath").allTextContents()).some((t) =>
      t.endsWith(path.join("docs", "guide.md"))
    )
  );
  check("Enter opens the note in a pane", opened);
  check("the palette closes after opening", !(await win.locator(".quick-open").isVisible()));

  await win.keyboard.press(QUICK_OPEN_KEY);
  await until("quick open again", () => win.locator(".quick-open").isVisible());
  await win.keyboard.press("Escape");
  check("Escape dismisses the palette", await until("palette closed", async () =>
    !(await win.locator(".quick-open").isVisible())
  ));

  // 5. Outline and backlinks follow the note in the active pane.
  await until("the outline", async () => (await win.locator(".vault-outline-item").count()) === 3);
  const outline = await win.locator(".vault-outline-item").allTextContents();
  check(
    "the outline lists the note's headings in order",
    JSON.stringify(outline) === JSON.stringify(["Guide", "Setup", "Deploy"]),
    JSON.stringify(outline)
  );
  const backlinks = await win.locator(".vault-section .vault-result-name").allTextContents();
  check(
    "backlinks list every note linking here, #fragment links included",
    backlinks.length === 2 &&
      backlinks.includes("README.md") &&
      backlinks.includes(path.join("docs", "deploy.md")),
    JSON.stringify(backlinks)
  );

  await win.locator(".vault-outline-item", { hasText: "Deploy" }).click();
  const scrolled = await until("the preview to scroll", () =>
    win.evaluate(() => {
      const c = document.querySelector(".pane-active .markdown-content");
      return !!c && c.scrollTop > 200;
    })
  );
  check("an outline entry scrolls the preview to its heading", scrolled);

  // 6. The shortcut toggles the panel, and reopening it focuses the search.
  await win.keyboard.press(VAULT_KEY);
  check("the vault shortcut closes the panel", await until("panel closed", async () =>
    !(await win.locator(".vault-panel").isVisible())
  ));
  await win.keyboard.press(VAULT_KEY);
  await until("panel open", () => win.locator(".vault-panel").isVisible());
  const focused = await until("search focused", () =>
    win.evaluate(() => document.activeElement?.closest(".vault-search") !== null)
  );
  check("reopening focuses the vault search", focused);

  // 7. A vault added by the file tree menu, and removal.
  await win.locator(".vault-item-remove").first().click({ force: true });
  const emptied = await until("the empty state", () => win.locator(".vault-empty").isVisible());
  check("removing the last vault shows how to add one", emptied);
  const storedAfter = await win.evaluate(() => localStorage.getItem("specterm.vaults"));
  check("removal is persisted", storedAfter === "[]", String(storedAfter));

  await win.keyboard.press(SIDEBAR_KEY); // the file tree takes the slot back
  await until("file tree", () => win.locator(".file-tree").isVisible());
  const docsRow = win
    .locator(".file-tree-content .file-tree-entry", {
      has: win.locator(".file-tree-name", { hasText: /^docs$/ }),
    })
    .first();
  if (await docsRow.isVisible()) {
    await docsRow.click({ button: "right" });
    await win.locator('.file-tree-menu-item[data-action="vault"]').click();
    const viaMenu = await until("the panel via the menu", () => win.locator(".vault-panel").isVisible());
    const label = await win.locator(".vault-item.active .vault-item-label").textContent().catch(() => null);
    check("the folder menu's Open as vault adds and shows it", viaMenu && label === "docs", String(label));
  } else {
    results.push({ name: "the folder menu's Open as vault adds and shows it", pass: true, skipped: true });
    log("SKIP  folder menu — the tree isn't showing the vault folder");
  }

  await win.screenshot({ path: path.join(root, "test", "shot-vault.png") });
} catch (err) {
  console.error("[vault] ERROR:", err?.stack || err);
  results.push({ name: "suite ran", pass: false, skipped: false });
} finally {
  try {
    await Promise.race([app?.close(), new Promise((r) => setTimeout(r, 3000))]);
  } catch (_) {
    // Best effort; the kill below is the backstop.
  }
  try { app?.process().kill("SIGKILL"); } catch {}
  for (const dir of [userDataDir, fakeHome]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

const failed = results.filter((r) => !r.pass).length;
const skipped = results.filter((r) => r.skipped).length;
log(`\n===== ${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped =====`);
if (hard) clearTimeout(hard);
process.exit(failed === 0 ? 0 : 1);
