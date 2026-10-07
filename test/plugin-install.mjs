// How a plugin's releases are read (electron/plugin-install.cjs): which tags
// are releases, which release an installed one may move to on its own, and
// which commit a ref names on the remote. The rules here decide what an
// automatic update installs without asking, so they are pinned down directly.
//
// Pure functions over tag lists and ls-remote output, plus one real git call
// against a throwaway local repo (the non-interactive environment the update
// check uses). No Electron.
//
// Run: node test/plugin-install.mjs
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { releaseVersion, prereleaseVersion, newestRelease, pickCommit, remoteCommit, remoteTags } = require(
  path.join(root, "electron", "plugin-install.cjs")
);

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const eq = (name, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  check(name, g === w, g === w ? "" : `got ${g} want ${w}`);
};

// --- release tags ---------------------------------------------------------
eq("a root plugin's release tag is v<semver>", releaseVersion("v1.2.3", ""), [1, 2, 3]);
eq("a subfolder plugin's carries the folder's name", releaseVersion("greet-v1.2.3", "apps/greet"), [1, 2, 3]);
eq("another folder's tag is not its release", releaseVersion("other-v1.2.3", "apps/greet"), null);
eq("a pre-release is not a release", releaseVersion("v2.0.0-rc.1", ""), null);
eq("but names the release it leads to", prereleaseVersion("v2.0.0-rc.1", ""), [2, 0, 0]);
eq("a release is not a pre-release", prereleaseVersion("v2.0.0", ""), null);

// --- what an installed release may move to on its own ----------------------
const tags = ["v0.2.0", "v0.2.1", "v0.3.0", "v1.3.0", "v1.4.2", "v2.0.0", "v2.1.0-rc.1", "notes"];
eq("from 1.x, the newest 1.x", newestRelease(tags, "", [1, 3, 0]), { tag: "v1.4.2", version: "1.4.2" });
eq("from 0.2.x, only 0.2.x: below 1.0 a minor can break", newestRelease(tags, "", [0, 2, 0]), { tag: "v0.2.1", version: "0.2.1" });
eq("with no constraint, the newest release, never a pre-release", newestRelease(tags, ""), { tag: "v2.0.0", version: "2.0.0" });
eq("nothing compatible", newestRelease(tags, "", [3, 0, 0]), null);

// --- which commit a ref names ---------------------------------------------
const lsRemote = [
  "1111111111111111111111111111111111111111\tHEAD",
  "2222222222222222222222222222222222222222\trefs/heads/feature/v1",
  "3333333333333333333333333333333333333333\trefs/heads/v1",
  "4444444444444444444444444444444444444444\trefs/tags/v1",
  "5555555555555555555555555555555555555555\trefs/tags/v1^{}",
  "6666666666666666666666666666666666666666\trefs/tags/light",
  "7777777777777777777777777777777777777777\trefs/heads/feature/light",
].join("\n");
eq("a branch wins over a tag of the same name", pickCommit(lsRemote, "v1"), "3333333333333333333333333333333333333333");
eq(
  "an annotated tag is its peeled commit",
  pickCommit(lsRemote.replace(/^.*refs\/heads\/v1$/m, ""), "v1"),
  "5555555555555555555555555555555555555555"
);
eq(
  "a lightweight tag is its own line, not a branch that ends the same way",
  pickCommit(lsRemote, "light"),
  "6666666666666666666666666666666666666666"
);
eq("no exact match is no commit", pickCommit(lsRemote, "missing"), null);
eq("no ref is the default branch", pickCommit(lsRemote, null), "1111111111111111111111111111111111111111");

// --- the non-interactive environment, against a real repo -----------------
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "specterm-plugin-install-"));
try {
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "f"), "x");
  git("add", ".");
  git("commit", "-qm", "one");
  git("tag", "v1.0.0");
  const head = git("rev-parse", "HEAD").toString().trim();
  const url = pathToFileURL(repo).href;
  eq("an unattended ls-remote lists the tags", await remoteTags(url, { interactive: false }), ["v1.0.0"]);
  eq("and finds a lightweight tag's commit", await remoteCommit(url, "v1.0.0", { interactive: false }), head);
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
