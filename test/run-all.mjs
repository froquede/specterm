// Run every e2e suite at once.
//
// There are three of them and they are independent: each launches its own
// Electron on its own throwaway `--user-data-dir`, which is also what the
// single-instance lock keys on, so nothing they do can reach each other. Run
// back to back they cost the sum of three Electron startups and three suites;
// run together they cost the longest one.
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
  { name: "e2e", file: "e2e.mjs" },
  { name: "session", file: "e2e-session.mjs" },
  { name: "windows", file: "e2e-windows.mjs" },
  { name: "diagrams", file: "e2e-diagrams.mjs" },
  // Not an Electron suite — it drives electron/repo-sync.cjs against real git
  // in a temp sandbox, so it costs seconds and runs alongside the rest for free.
  { name: "repo-sync", file: "repo-sync.mjs" },
  // Not an Electron suite — pure functions from src/lib/paste.ts, imported as
  // TypeScript. Node 22 strips types behind a flag (unflagged from 23), hence
  // the `node` argument this one suite needs. It costs milliseconds.
  { name: "paste", file: "paste.mjs", node: ["--experimental-strip-types"] },
  // Not an Electron suite either — the argv classifier from
  // electron/open-paths.cjs, required straight in. Milliseconds.
  { name: "open-paths", file: "open-paths.mjs" },
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

console.log(`[all] starting ${SUITES.length} suites in parallel`);
const results = await Promise.all(SUITES.map(run));

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
