// Bringing a local clone of Specterm along when the app updates itself.
//
// The people most likely to hit "Check for updates" are the ones who also keep
// the source checked out somewhere, and after an update that checkout is a
// release behind the binary they are now running. This pulls it forward, once,
// right after an update finishes downloading — and does the whole thing without
// saying anything, because it is a side errand, not something the user asked
// for in that moment.
//
// Three rules make "silent" safe rather than reckless:
//
//   - It only ever touches a directory it has *proved* is a Specterm clone: the
//     name matches, it has a .git, and its `origin` remote points at a
//     repository called specterm. A directory that merely shares the name is
//     left alone.
//   - It refuses to run on a dirty tree. `git status --porcelain` says
//     anything at all → nothing happens. Uncommitted work is never at risk,
//     which matters doubly when nothing on screen would tell you it was.
//   - The pull is `--ff-only`. It can fast-forward `main`; it can never write a
//     merge commit, resolve a conflict, or leave the repo mid-rebase.
//
// Anything unexpected — no git on PATH, no `main` branch, a network failure, a
// diverged branch — is a skip, logged to the main process and nowhere else. A
// failed errand must not turn into a failed update.

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const REPO_DIR_NAME = "specterm";
// `origin` must look like <host>[:/]<owner>/specterm[.git]. Confirms the
// directory is a clone of *this* project before we run anything in it.
const ORIGIN_RE = /[/:][^/:]+\/specterm(\.git)?\/?$/i;

// Search budget. The scan runs at most once per install (the hit is cached) and
// only after an update download, but it still walks a home directory, so it is
// bounded on every axis rather than trusted to terminate quickly.
const MAX_DEPTH = 4; // ~/dev/work/clients/specterm still resolves
const MAX_DIRS = 4000;
const MAX_SCAN_MS = 3000;

// Directories that never contain a source checkout and can be enormous. Hidden
// directories are skipped wholesale (which also keeps us out of ~/.cache,
// ~/.local and friends) — with one exception, since a .git is how we recognize
// a candidate in the first place.
const SKIP_DIRS = new Set([
  "node_modules",
  "Library",
  "Applications",
  "AppData",
  "Trash",
  "snap",
  "flatpak",
  "go",
  "venv",
  "vendor",
  "target",
  "dist",
  "build",
  "OneDrive",
  "Dropbox",
]);

const GIT_TIMEOUT_MS = 15000;
const PULL_TIMEOUT_MS = 120000;

const log = (...a) => console.log("[repo-sync]", ...a);

// Run git and resolve — never reject. Every caller treats a non-zero exit the
// same way it treats a thrown error (skip), so collapsing the two here keeps
// the flow below free of try/catch noise.
function git(args, cwd, timeout = GIT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      // A pager or a credential prompt would hang this forever in a process
      // with no terminal attached.
      {
        cwd,
        timeout,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
      },
      (err, stdout) => {
        resolve({ ok: !err, out: String(stdout || "").trim() });
      }
    );
  });
}

async function isSpectermClone(dir) {
  if (!fs.existsSync(path.join(dir, ".git"))) return false;
  const remote = await git(["remote", "get-url", "origin"], dir);
  return remote.ok && ORIGIN_RE.test(remote.out);
}

// Breadth-first from the home directory, so the shallow, conventional spots
// (~/specterm, ~/Documents/specterm) are reached before anything buried.
async function scanForClone() {
  const home = os.homedir();
  const deadline = Date.now() + MAX_SCAN_MS;
  let visited = 0;
  let queue = [home];

  for (let depth = 0; depth <= MAX_DEPTH && queue.length; depth++) {
    const next = [];
    for (const dir of queue) {
      if (visited++ > MAX_DIRS || Date.now() > deadline) {
        log("scan budget exhausted");
        return null;
      }
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable (permissions, a dead symlink) — not our problem
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.name === REPO_DIR_NAME && (await isSpectermClone(full))) {
          return full;
        }
        next.push(full);
      }
    }
    queue = next;
  }
  return null;
}

// The scan result, remembered in userData so an update only pays for the walk
// once. Re-verified before use: a cached path can be moved, deleted, or have
// had its remote re-pointed since.
function cachePath(userDataDir) {
  return path.join(userDataDir, "local-repo.json");
}

async function readCache(userDataDir) {
  try {
    const raw = await fsp.readFile(cachePath(userDataDir), "utf8");
    const dir = JSON.parse(raw).path;
    return typeof dir === "string" && dir ? dir : null;
  } catch {
    return null;
  }
}

async function writeCache(userDataDir, dir) {
  try {
    await fsp.writeFile(
      cachePath(userDataDir),
      JSON.stringify({ path: dir }, null, 2)
    );
  } catch {
    // Not being able to remember costs one extra scan, nothing more.
  }
}

async function findClone(userDataDir) {
  const cached = await readCache(userDataDir);
  if (cached && (await isSpectermClone(cached))) return cached;
  const found = await scanForClone();
  if (found) await writeCache(userDataDir, found);
  return found;
}

/**
 * Fast-forward a local Specterm clone onto `main`, if there is one and it is
 * safe to touch. Resolves to a short status string for the log; never throws,
 * and never reports anything to the UI.
 */
async function syncLocalRepo(userDataDir) {
  const version = await git(["--version"], os.homedir());
  if (!version.ok) return "no git on PATH";

  const dir = await findClone(userDataDir);
  if (!dir) return "no local clone found";

  // Uncommitted work — including untracked files — means hands off.
  const status = await git(["status", "--porcelain"], dir);
  if (!status.ok) return `not a usable repo: ${dir}`;
  if (status.out) return `skipped, working tree is dirty: ${dir}`;

  // A clone that calls its default branch something else isn't ours to guess at.
  const hasMain = await git(["rev-parse", "--verify", "--quiet", "refs/heads/main"], dir);
  if (!hasMain.ok) return `skipped, no local main branch: ${dir}`;

  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], dir);
  if (branch.out !== "main") {
    const checkout = await git(["checkout", "main"], dir);
    if (!checkout.ok) return `skipped, could not check out main: ${dir}`;
  }

  // --ff-only: advance main or do nothing. Never a merge commit, never a
  // conflict left behind in a repo the user didn't know we were in.
  const pull = await git(["pull", "--ff-only"], dir, PULL_TIMEOUT_MS);
  if (!pull.ok) return `skipped, main could not fast-forward: ${dir}`;
  return `updated ${dir}`;
}

// One run per app launch. The updater can emit "downloaded" more than once
// (a second check after a failed install), and re-walking the home directory
// for each is waste.
let ran = false;

/** Fire-and-forget entry point for the updater's "downloaded" step. */
function syncLocalRepoAfterUpdate(userDataDir) {
  if (ran) return;
  ran = true;
  syncLocalRepo(userDataDir).then(
    (result) => log(result),
    (err) => log("failed:", err)
  );
}

module.exports = { syncLocalRepoAfterUpdate, syncLocalRepo };
