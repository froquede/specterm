// Installing an external plugin from a URL: what the user pastes in Settings >
// Plugins, turned into a git clone of one release. See "Distribution" in
// docs/plugin-architecture.md; plugins.cjs owns the folders and the state, this
// only reads the source and fetches it.
//
// What can be pasted:
//
//   https://github.com/owner/repo                  the newest release tag
//   https://github.com/owner/repo#v1.2.0           that tag (or branch)
//   https://github.com/owner/repo#v1.2.0:apps/x    a plugin in a subfolder
//   https://github.com/owner/repo/tree/v1.2.0/apps/x
//                                                  the same, as a browser link
//   git@github.com:owner/repo.git, ssh://…, file://…
//
// Cloning uses the user's own git and its credentials, so a private repo needs
// nothing from Specterm. Without a ref the newest release tag is taken, by the
// prefix the architecture fixes: `v<semver>` for a plugin at the repo's root,
// `<folder>-v<semver>` for one in a subfolder. A repo with no such tag installs
// its default branch, pinned to the commit it was at.

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const GIT_TIMEOUT_MS = 120_000;
const MAX_SOURCE = 500;
const REF_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/;
const URL_RE = /^(?:https?:\/\/|ssh:\/\/|git:\/\/|file:\/\/|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:)/;
// …/owner/repo/tree/<ref>[/<path>] on GitHub, …/-/tree/… on GitLab.
const TREE_RE = /^(https?:\/\/[^/]+\/[^/]+\/[^/]+?)(?:\.git)?\/(?:-\/)?tree\/([^/]+)(?:\/(.+?))?\/?$/;

// A subfolder inside the repo, normalised to forward slashes with no leading
// or trailing one. It must stay inside the clone.
function cleanSubdir(raw) {
  const parts = String(raw ?? "")
    .split(/[\\/]+/)
    .filter((p) => p && p !== ".");
  if (parts.some((p) => p === "..")) throw new Error("the folder must be inside the repository");
  return parts.join("/");
}

// What was pasted, as { url, ref | null, subdir }. Throws with a message the
// Settings field shows as is.
function parseSource(input) {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) throw new Error("paste the URL of the plugin's git repository");
  if (raw.length > MAX_SOURCE) throw new Error("that URL is too long");
  if (/\s/.test(raw)) throw new Error("the URL cannot contain spaces");

  const tree = TREE_RE.exec(raw.replace(/#.*$/, ""));
  if (tree) {
    return checked({ url: `${tree[1]}.git`, ref: decodeURIComponent(tree[2]), subdir: cleanSubdir(tree[3] && decodeURIComponent(tree[3])) });
  }

  const hash = raw.indexOf("#");
  const url = hash === -1 ? raw : raw.slice(0, hash);
  const fragment = hash === -1 ? "" : raw.slice(hash + 1);
  const colon = fragment.indexOf(":");
  const ref = colon === -1 ? fragment : fragment.slice(0, colon);
  const subdir = colon === -1 ? "" : fragment.slice(colon + 1);
  return checked({ url, ref: ref || null, subdir: cleanSubdir(subdir) });
}

function checked(source) {
  if (!URL_RE.test(source.url)) {
    throw new Error("that is not a git repository URL (https://, ssh://, git@host:owner/repo or file://)");
  }
  if (source.ref !== null && (!REF_RE.test(source.ref) || source.ref.includes(".."))) {
    throw new Error(`"${source.ref}" is not a valid tag or branch name`);
  }
  return source;
}

// The source as it reads back in Settings, and as pasting it again would
// install the same thing.
function describeSource({ url, ref, subdir }) {
  if (!ref && !subdir) return url;
  return `${url}#${ref ?? ""}${subdir ? `:${subdir}` : ""}`;
}

// The ssh command git would use, so the non-interactive one below can add to
// it rather than replace a user's own (a jump host, a key, a wrapper). Asked
// once per process, and only the first time an update runs unattended.
let sshCommand = null;
async function configuredSshCommand() {
  if (process.env.GIT_SSH_COMMAND) return process.env.GIT_SSH_COMMAND;
  sshCommand ??= git(["config", "--get", "core.sshCommand"]).then(
    (out) => out.trim() || "ssh",
    () => "ssh"
  );
  return sshCommand;
}

// No terminal to answer a prompt in: git would wait forever. With
// `interactive` (an install or an update the user just asked for), a
// credential helper with its own window (Git Credential Manager) still works.
// Without it (the update check, and what it installs on its own), nothing may
// ask: Git Credential Manager is told not to, and ssh runs in batch mode, so a
// repo that needs a sign-in fails with the reason instead of opening a window
// nobody asked for.
async function gitEnv(interactive) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C" };
  if (interactive) return env;
  return {
    ...env,
    GCM_INTERACTIVE: "never",
    GIT_SSH_COMMAND: `${await configuredSshCommand()} -o BatchMode=yes`,
  };
}

async function git(args, { cwd, interactive = true } = {}) {
  const env = await gitEnv(interactive);
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        windowsHide: true,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        env,
      },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        if (err.code === "ENOENT") return reject(new Error("git is not installed or not on the PATH; install git to add plugins"));
        if (err.killed) return reject(new Error(`git took longer than ${GIT_TIMEOUT_MS / 1000}s; check the URL and your connection`));
        reject(new Error(gitMessage(stderr) || err.message));
      }
    );
  });
}

// git's last "fatal:" line is the one that says what went wrong.
function gitMessage(stderr) {
  const lines = String(stderr ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const fatal = lines.filter((l) => /^(fatal|error):/i.test(l)).pop() ?? lines.pop();
  if (!fatal) return "";
  const text = fatal.replace(/^(fatal|error):\s*/i, "");
  if (/could not read Username|Authentication failed|terminal prompts disabled/i.test(text)) {
    return "git could not sign in to that repository; check that you have access to it";
  }
  if (/Remote branch .* not found/i.test(text)) return text.replace(/^Remote branch/i, "no tag or branch");
  return `git: ${text}`;
}

// A plugin's release tags carry a prefix: `v` at the repo's root,
// `<folder>-v` for one in a subfolder.
const tagPrefix = (subdir) => (subdir ? `${path.posix.basename(subdir)}-v` : "v");

// The version a release tag names, as [major, minor, patch], or null for any
// other tag. Pre-releases are null too: they are installed only by asking.
function releaseVersion(tag, subdir) {
  const prefix = tagPrefix(subdir);
  if (typeof tag !== "string" || !tag.startsWith(prefix)) return null;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(tag.slice(prefix.length));
  return m ? m.slice(1).map(Number) : null;
}

// The release a pre-release tag leads up to (`v2.0.0-rc.1` -> [2, 0, 0]), or
// null. A plugin installed at one is offered that release, or a newer one,
// once it is out.
function prereleaseVersion(tag, subdir) {
  const prefix = tagPrefix(subdir);
  if (typeof tag !== "string" || !tag.startsWith(prefix)) return null;
  const m = /^(\d+)\.(\d+)\.(\d+)-[0-9A-Za-z.-]+$/.exec(tag.slice(prefix.length));
  return m ? m.slice(1).map(Number) : null;
}

// Every tag in the repo, as git ls-remote lists them. The update check asks
// once per repo, however many plugins live in it.
async function remoteTags(url, { interactive = true } = {}) {
  const out = await git(["ls-remote", "--tags", "--refs", "--", url], { interactive });
  return out
    .split("\n")
    .map((line) => line.split("\trefs/tags/")[1]?.trim())
    .filter(Boolean);
}

// The newest release tag for a plugin at `subdir` among `tags`, as
// { tag, version: "1.2.3" }, or null. With `compatibleWith` (a version), only
// the releases semver says are compatible with it: the same major, and below
// 1.0.0 the same minor too, since there a minor is allowed to break.
function newestRelease(tags, subdir, compatibleWith = null) {
  const compatible = (v) =>
    !compatibleWith || (v[0] === compatibleWith[0] && (compatibleWith[0] !== 0 || v[1] === compatibleWith[1]));
  let best = null;
  for (const tag of tags) {
    const v = releaseVersion(tag, subdir);
    if (v && compatible(v) && (!best || newer(v, best.v))) best = { tag, v };
  }
  return best && { tag: best.tag, version: best.v.join(".") };
}

async function newestTag(url, subdir, opts) {
  return newestRelease(await remoteTags(url, opts), subdir)?.tag ?? null;
}

// The commit a branch or tag (or, with no ref, the default branch) is at now.
async function remoteCommit(url, ref, { interactive = true } = {}) {
  const out = await git(["ls-remote", "--", url, ref ?? "HEAD"], { interactive });
  return pickCommit(out, ref);
}

// ls-remote matches its pattern against the end of every ref name, so asking
// for `v1` also lists `refs/heads/feature/v1`. Only an exact name counts. A
// name can match a branch and a tag; the branch wins, as in `git clone
// --branch`. An annotated tag's peeled line (^{}) is its commit; a lightweight
// tag has only the one line.
function pickCommit(out, ref) {
  const lines = String(out)
    .split("\n")
    .map((l) => l.trim().split("\t"))
    .filter((l) => l.length === 2);
  const named = (name) => lines.find(([, n]) => n === name);
  const pick = ref
    ? named(`refs/heads/${ref}`) ?? named(`refs/tags/${ref}^{}`) ?? named(`refs/tags/${ref}`)
    : named("HEAD");
  return pick?.[0] ?? null;
}

function newer(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// Clones `source` into `dest` (which must not exist) and returns the folder the
// plugin is in plus the ref and commit it was installed at. Symlinks in the
// repo are checked out as plain files: the plugin scheme serves files from the
// plugin's folder, and a link would let it serve any file on disk.
async function fetchSource(source, dest, { interactive = true } = {}) {
  const ref = source.ref ?? (await newestTag(source.url, source.subdir, { interactive }));
  const args = ["-c", "core.symlinks=false", "clone", "--depth", "1", "--quiet"];
  if (ref) args.push("--branch", ref);
  args.push("--", source.url, dest);
  await git(args, { interactive });
  const commit = (await git(["rev-parse", "HEAD"], { cwd: dest })).trim();
  const dir = source.subdir ? path.join(dest, ...source.subdir.split("/")) : dest;
  const stat = await fs.promises.stat(dir).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`the repository has no folder "${source.subdir}"`);
  return { dir, ref, commit };
}

module.exports = {
  parseSource,
  describeSource,
  fetchSource,
  releaseVersion,
  prereleaseVersion,
  remoteTags,
  newestRelease,
  remoteCommit,
  pickCommit,
  newer,
};
