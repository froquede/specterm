// Post-update local-clone sync (electron/repo-sync.cjs).
//
// This is the one thing the app does inside a directory the user did not point
// it at, without saying so, so the checks that matter are the refusals: a dirty
// tree, a diverged main, and a directory that only happens to share the name.
// Everything runs against real `git` in a throwaway sandbox — a mock would be
// asserting our idea of git's behaviour, which is exactly the thing at risk.
//
// No Electron here: repo-sync.cjs takes the userData directory as an argument
// precisely so it can be driven without an app.
//
// Run: node test/repo-sync.mjs
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { syncLocalRepo } = require(path.join(root, "electron", "repo-sync.cjs"));

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const git = (args, cwd) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
// Commits need an identity, and the machine running this may not have one.
const commit = (cwd, msg) => {
  git(["add", "-A"], cwd);
  git(["-c", "user.email=e2e@specterm", "-c", "user.name=e2e", "commit", "-m", msg], cwd);
};

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "specterm-repo-sync-"));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "specterm-udd-"));
// The cache file is the supported way to aim the sync at a directory; writing
// it keeps these checks off the home-directory scan, which depends on whatever
// the machine happens to have lying around.
const aim = (dir) =>
  fs.writeFileSync(path.join(userData, "local-repo.json"), JSON.stringify({ path: dir }));

try {
  // A bare remote whose *path* looks like the real one, since that is what the
  // origin check reads.
  const bare = path.join(sandbox, "froquede", "specterm.git");
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  git(["init", "--bare", "-b", "main", bare], sandbox);

  // A scratch clone used to publish upstream commits.
  const seed = path.join(sandbox, "seed");
  git(["clone", bare, seed], sandbox);
  fs.writeFileSync(path.join(seed, "a.txt"), "one\n");
  commit(seed, "one");
  git(["push", "origin", "main"], seed);

  const clone = path.join(sandbox, "specterm");
  git(["clone", bare, clone], sandbox);
  const cloneText = () => fs.readFileSync(path.join(clone, "a.txt"), "utf8");
  const publish = (msg) => {
    fs.appendFileSync(path.join(seed, "a.txt"), `${msg}\n`);
    commit(seed, msg);
    git(["push", "origin", "main"], seed);
  };

  // 1) The happy path: clean tree, upstream ahead.
  publish("two");
  aim(clone);
  let r = await syncLocalRepo(userData);
  check("clean clone fast-forwards", r.startsWith("updated"), r);
  check("clean clone has the new commit", cloneText().includes("two"));

  // 2) Uncommitted work — even a single untracked file — stops everything.
  publish("three");
  fs.writeFileSync(path.join(clone, "wip.txt"), "unsaved\n");
  aim(clone);
  r = await syncLocalRepo(userData);
  check("dirty tree is skipped", r.startsWith("skipped, working tree is dirty"), r);
  check("dirty tree keeps its untracked file", fs.existsSync(path.join(clone, "wip.txt")));
  check("dirty tree does not advance", !cloneText().includes("three"));
  fs.unlinkSync(path.join(clone, "wip.txt"));

  // 3) Parked on a feature branch: switch to main, pull, leave the branch be.
  git(["checkout", "-b", "feature"], clone);
  aim(clone);
  r = await syncLocalRepo(userData);
  check("a clean feature branch is moved to main", r.startsWith("updated"), r);
  check("HEAD ends on main", git(["rev-parse", "--abbrev-ref", "HEAD"], clone) === "main");
  check("the feature branch survives", git(["branch", "--list", "feature"], clone).includes("feature"));

  // 4) main with an unpushed commit: --ff-only must refuse rather than merge.
  publish("four");
  fs.appendFileSync(path.join(clone, "a.txt"), "local-only\n");
  commit(clone, "local");
  aim(clone);
  r = await syncLocalRepo(userData);
  check("diverged main refuses to merge", r.startsWith("skipped, main could not fast-forward"), r);
  check("diverged main keeps its local commit", git(["log", "-1", "--pretty=%s"], clone) === "local");
  check("diverged main is left on main, not detached", git(["rev-parse", "--abbrev-ref", "HEAD"], clone) === "main");

  // 5) A repo that is merely *called* specterm is not ours to pull.
  const decoy = path.join(sandbox, "decoy", "specterm");
  fs.mkdirSync(decoy, { recursive: true });
  git(["init", "-b", "main", decoy], sandbox);
  git(["remote", "add", "origin", "https://example.invalid/someone/notspecterm.git"], decoy);
  fs.writeFileSync(path.join(decoy, "b.txt"), "untouched\n");
  commit(decoy, "decoy");
  aim(decoy);
  r = await syncLocalRepo(userData);
  check("a foreign origin is rejected", !r.startsWith("updated"), r);
  check("the foreign repo is left alone", git(["log", "-1", "--pretty=%s"], decoy) === "decoy");

  // 6) A cached path that no longer exists must not throw — it falls back to
  // the scan, whose result depends on the machine, so only the shape is checked.
  aim(path.join(sandbox, "deleted"));
  r = await syncLocalRepo(userData);
  check("a stale cached path degrades to a scan", typeof r === "string" && r.length > 0, r);
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
}

console.log(`\n===== ${passed} passed, ${failed} failed =====`);
process.exit(failed ? 1 : 0);
