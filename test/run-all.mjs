// Run every e2e suite at once.
//
// They are *almost* independent: each launches its own Electron on its own
// throwaway `--user-data-dir`, which is also what the single-instance lock keys
// on, so nothing they store can reach each other. Run back to back they cost the
// sum of their Electron startups and suites; run together they cost the longest
// one.
//
// The exception is the OS clipboard, and it is the one piece of global state
// none of the per-run isolation covers. Two suites here read the terminal by
// selecting it and copying — write an `<<EMPTY>>` sentinel, press the copy
// chord, read the clipboard back — and there is exactly one clipboard on the
// machine. Run in parallel, a write from one lands between the other's copy and
// its read, and the check fails holding the *other suite's* text. Their windows
// genuinely overlap: e2e's first copy check is ~22s in, and e2e-windows reaches
// its scrollback check at about the same point.
//
// So clipboard suites run one at a time, in a chain that races alongside
// everything else. It costs the length of the shorter clipboard suite in wall
// clock and buys a run that means something. (This is also why two `run-all`s,
// or a stray `node test/e2e.mjs` beside one, will still collide — the
// serialization is within a run, not across the machine.)
//
// Output is buffered per suite and printed in one block when that suite
// finishes, rather than interleaved line by line — three suites narrating at
// once into the same terminal is unreadable, and the per-line elapsed times
// stop meaning anything.
//
// Run: node test/run-all.mjs   (after `vite build`)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const SUITES = [
  // `clipboard: true` — reads the terminal by copying it, so it owns the OS
  // clipboard for its whole run and cannot share the machine with another such
  // suite. See the header.
  { name: "e2e", file: "e2e.mjs", clipboard: true },
  { name: "session", file: "e2e-session.mjs" },
  { name: "windows", file: "e2e-windows.mjs", clipboard: true },
  { name: "diagrams", file: "e2e-diagrams.mjs" },
  // Not an Electron suite — it drives electron/repo-sync.cjs against real git
  // in a temp sandbox, so it costs seconds and runs alongside the rest for free.
  { name: "repo-sync", file: "repo-sync.mjs" },
  // Not an Electron suite — pure functions from src/lib/paste.ts, imported as
  // TypeScript. Node 22 strips types behind a flag (unflagged from 23), hence
  // the `node` argument this one suite needs. It costs milliseconds.
  { name: "paste", file: "paste.mjs", node: ["--experimental-strip-types"] },
];

const started = Date.now();
const secs = (ms) => (ms / 1000).toFixed(1);

function run({ name, file, node = [] }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [...node, path.join(__dirname, file)], {
      cwd: root,
      env: process.env,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => {
      const took = Date.now() - t0;
      console.log(
        `\n${"=".repeat(72)}\n=== ${name} — ${code === 0 ? "PASS" : `FAIL (exit ${code})`} in ${secs(took)}s\n${"=".repeat(72)}`
      );
      console.log(out.trimEnd());
      resolve({ name, code, took });
    });
  });
}

// The clipboard suites, one after another; everything else all at once. Both
// halves start now and finish whenever they finish.
async function runChain(suites) {
  const out = [];
  for (const suite of suites) out.push(await run(suite));
  return out;
}

const exclusive = SUITES.filter((s) => s.clipboard);
const parallel = SUITES.filter((s) => !s.clipboard);
console.log(
  `[all] starting ${parallel.length} suites in parallel` +
    (exclusive.length
      ? `, ${exclusive.length} serialized for the clipboard (${exclusive
          .map((s) => s.name)
          .join(" → ")})`
      : "")
);

const [chained, loose] = await Promise.all([
  runChain(exclusive),
  Promise.all(parallel.map(run)),
]);

// Report in the order the suites are declared, not the order they finished, so
// the summary block reads the same from one run to the next.
const byName = new Map([...chained, ...loose].map((r) => [r.name, r]));
const results = SUITES.map((s) => byName.get(s.name));

const wall = Date.now() - started;
console.log(`\n${"-".repeat(72)}`);
for (const r of results) {
  console.log(
    `  ${r.code === 0 ? "PASS" : "FAIL"}  ${r.name.padEnd(10)} ${secs(r.took).padStart(7)}s`
  );
}
const serial = results.reduce((a, r) => a + r.took, 0);
console.log(
  `  wall clock ${secs(wall)}s (${secs(serial)}s if these had run one after another)`
);

process.exit(results.every((r) => r.code === 0) ? 0 : 1);
