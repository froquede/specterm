// Diagrams found in terminal output — end to end, against the real app.
//
// Its own suite rather than a section of e2e.mjs for two reasons. The main
// suite is already close to its time budget, and this one needs the app
// launched under a **sandboxed HOME**: half of what it checks is the detector
// reading a Claude Code transcript, and writing a synthetic one into the
// developer's real ~/.claude would leave a fake session lying around in it.
//
// What each check is actually for:
//
//   1. The fence-less shape. Claude Code renders a fenced block *without* its
//      fences — the info string on its own line, the body under it, and prose
//      resuming at the same indentation. Nothing in that marks where the block
//      ends, so this is the check that the guess about the extent works and,
//      just as importantly, that it stops: a diagram that swallowed the
//      sentence after it would still draw, so the assertion is on node count.
//   2. The fenced shape, which is what every non-Claude program produces.
//   3. The transcript. The screen copy of a long line has been through Claude's
//      own hard wrap and is not what was written; the transcript is. The
//      transcript here deliberately says something the screen does not, so a
//      pass can only mean the exact source was used — with the same text in
//      both, this check would pass while that path was dead code.
//
// Run: node test/e2e-diagrams.mjs   (after `vite build`)
import { _electron as electron } from "playwright";
import { launchOptions } from "./launch.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const WIN = process.platform === "win32";

const started = Date.now();
const elapsed = () => ((Date.now() - started) / 1000).toFixed(1).padStart(6);
const log = (...a) => console.log(`[diagrams ${elapsed()}s]`, ...a);

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, skipped: false });
  log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const HARD_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 180000);
const hard =
  HARD_TIMEOUT_MS > 0 &&
  setTimeout(() => {
    console.error("[diagrams] HARD TIMEOUT");
    process.exit(2);
  }, HARD_TIMEOUT_MS);
if (hard) hard.unref();

// --- fixtures ---------------------------------------------------------------

const fixture = path.join(root, "test", "fixtures", "claude-rendered-diagram.txt");
const rendered = fs.readFileSync(fixture, "utf8");

// The same block as the transcript holds it: two-space render indent removed
// and the line Claude hard-wrapped put back together. One node is renamed, and
// that rename is the entire point — see the header.
const PROOF = "TRANSCRIPTPROOF";
const transcriptSource = rendered
  .split("\n")
  .slice(rendered.split("\n").findIndex((l) => l.trim() === "flowchart TD"))
  .slice(0, 21)
  .map((l) => l.replace(/^ {2}/, ""))
  .join("\n")
  .replace(/hospitalar\n· navarromed/, "hospitalar · navarromed")
  .replace("grupodimebras", PROOF);

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "specterm-dg-home-"));
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "specterm-dg-"));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "specterm-dg-work-"));

// Claude names a project directory for its path, with every separator dashed.
const projectDir = path.join(
  fakeHome,
  ".claude",
  "projects",
  workDir.replace(/[/\\]/g, "-")
);
fs.mkdirSync(projectDir, { recursive: true });
fs.writeFileSync(
  path.join(projectDir, `${randomUUID()}.jsonl`),
  [
    JSON.stringify({ type: "user", message: { content: "draw it" } }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: "Here it is:\n\n```mermaid\n" + transcriptSource + "\n```\n\nThat is the flow.",
          },
        ],
      },
    }),
  ].join("\n") + "\n"
);

// --- run --------------------------------------------------------------------

let app;
try {
  app = await electron.launch(
    launchOptions(root, userDataDir, { env: { HOME: fakeHome } })
  );
  const win = await app.firstWindow();
  win.on("pageerror", (e) => log("PAGEERROR:", e.message));
  await win.waitForSelector(".app", { timeout: 20000 });
  await win.waitForSelector(".xterm-screen canvas", { timeout: 20000 });
  // The pty is spawned asynchronously and keystrokes that beat it are dropped.
  await win.waitForTimeout(2500);

  const type = async (cmd) => {
    await win.locator(".xterm-helper-textarea:visible").last().click({ force: true });
    await win.keyboard.type(cmd);
    await win.keyboard.press("Enter");
  };
  const chips = () => win.locator(".terminal-diagram-chip");
  const waitForChips = (n) =>
    chips()
      .nth(n - 1)
      .waitFor({ state: "visible", timeout: 12000 })
      .then(() => true, () => false);

  // The pane has to be *in* the project directory for its transcript to be
  // found — that is how Claude namespaces them.
  await type(WIN ? `Set-Location "${workDir}"` : `cd "${workDir}"`);
  await win.waitForTimeout(2200);

  await type(WIN ? `Get-Content "${fixture}"` : `cat "${fixture}"`);
  const chipShown = await waitForChips(1);
  check(
    "a mermaid block printed to the terminal gets a chip",
    chipShown,
    chipShown ? "" : "no .terminal-diagram-chip appeared"
  );

  if (chipShown) {
    // The transcript lookup is a file read that starts after the chip is up.
    await win.waitForTimeout(1500);
    await chips().first().click();
    const drawn = await win
      .locator(".diagram-overlay .mermaid-viewport svg")
      .first()
      .waitFor({ state: "visible", timeout: 25000 })
      .then(() => true, () => false);

    const svg = await win.evaluate(() => {
      const root = document.querySelector(".diagram-overlay .mermaid-viewport svg");
      return {
        nodes: root ? root.querySelectorAll(".node").length : 0,
        clusters: root ? root.querySelectorAll(".cluster").length : 0,
        text: root ? root.textContent ?? "" : "",
        error: document.querySelector(".diagram-overlay-error p")?.textContent ?? null,
      };
    });

    check(
      "clicking the chip draws the diagram over the pane",
      drawn && svg.nodes === 9 && svg.clusters === 2,
      `drawn=${drawn} nodes=${svg.nodes} clusters=${svg.clusters} error=${svg.error ?? "none"}`
    );
    check(
      "the prose after a fence-less block is not drawn as part of it",
      drawn && !/O ponto exato/.test(svg.text),
      svg.text.slice(0, 120)
    );
    check(
      "the source comes from the transcript, not from the wrapped screen copy",
      svg.text.includes(PROOF) && !svg.text.includes("grupodimebras"),
      `proof=${svg.text.includes(PROOF)} scraped=${svg.text.includes("grupodimebras")}`
    );

    await win.keyboard.press("Escape");
    await win.waitForTimeout(400);
    check(
      "Esc closes the overlay",
      (await win.locator(".diagram-overlay").count()) === 0,
      `${await win.locator(".diagram-overlay").count()} still up`
    );
  } else {
    for (const name of [
      "clicking the chip draws the diagram over the pane",
      "the prose after a fence-less block is not drawn as part of it",
      "the source comes from the transcript, not from the wrapped screen copy",
      "Esc closes the overlay",
    ]) {
      check(name, false, "no chip to click");
    }
  }

  // A real fenced block — what every program other than Claude Code emits.
  if (!WIN) {
    const fenced =
      "printf '%s\\n' '" +
      "```mermaid' 'sequenceDiagram' '  A->>B: hi' '  B-->>A: yo' '```'";
    await type(fenced);
    const secondChip = await waitForChips(2);
    check(
      "a fenced ```mermaid block gets its own chip",
      secondChip,
      `${await chips().count()} chip(s)`
    );
  } else {
    // PowerShell quoting of a backtick fence is its own puzzle and the shape
    // being checked is shell-independent; the POSIX run covers it.
    results.push({ name: "a fenced ```mermaid block gets its own chip", pass: true, skipped: true });
    log("SKIP  a fenced ```mermaid block gets its own chip — PowerShell quoting");
  }

  // A block that arrives in two pieces, with a gap between them longer than the
  // scan's quiet period, is one diagram and not two. This is what an agent
  // streaming its answer looks like from here — the first scan finds a block
  // that is genuinely half-written, and the entry has to grow rather than a
  // second chip appearing next to the first.
  //
  // A different diagram from the one above, deliberately: printing the *same*
  // block twice is, by the identity rule the detector uses, the same block, so
  // reusing the fixture would assert nothing about growth.
  if (!WIN) {
    const streamed = path.join(root, "test", "fixtures", "streamed-diagram.txt");
    const before = await chips().count();
    await type(`head -n 9 "${streamed}"; sleep 1.2; tail -n +10 "${streamed}"`);
    await win.waitForTimeout(3500);
    const after = await chips().count();
    check(
      "a block printed in two pieces gets one chip, not one per piece",
      after === before + 1,
      `${before} → ${after} chip(s)`
    );
  } else {
    results.push({
      name: "a block printed in two pieces gets one chip, not one per piece",
      pass: true,
      skipped: true,
    });
    log("SKIP  streamed block — no `sleep` in the default Windows shell");
  }

  await win.screenshot({ path: path.join(root, "test", "shot-diagrams.png") });
} catch (err) {
  console.error("[diagrams] ERROR:", err?.stack || err);
  results.push({ name: "suite ran", pass: false, skipped: false });
} finally {
  try {
    await Promise.race([app?.close(), new Promise((r) => setTimeout(r, 3000))]);
  } catch (_) {
    // Best effort; the kill below is the backstop.
  }
  try { app?.process().kill("SIGKILL"); } catch {}
  for (const dir of [userDataDir, fakeHome, workDir]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

const failed = results.filter((r) => !r.pass).length;
const skipped = results.filter((r) => r.skipped).length;
log(`\n===== ${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped =====`);
if (hard) clearTimeout(hard);
process.exit(failed === 0 ? 0 : 1);
