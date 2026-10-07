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

function git(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        windowsHide: true,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        // No terminal to answer a prompt in: git would wait forever. A
        // credential helper with its own window (Git Credential Manager) still
        // works, since the user asked for this install.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C" },
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

// Every tag in the repo, as git ls-remote lists them. The update check asks
// once per repo, however many plugins live in it.
async function remoteTags(url) {
  const out = await git(["ls-remote", "--tags", "--refs", "--", url]);
  return out
    .split("\n")
    .map((line) => line.split("\trefs/tags/")[1]?.trim())
    .filter(Boolean);
}

// The newest release tag for a plugin at `subdir` among `tags`, as
// { tag, version: "1.2.3" }, or null. With `major`, only that major's.
function newestRelease(tags, subdir, major = null) {
  let best = null;
  for (const tag of tags) {
    const v = releaseVersion(tag, subdir);
    if (v && (major === null || v[0] === major) && (!best || newer(v, best.v))) best = { tag, v };
  }
  return best && { tag: best.tag, version: best.v.join(".") };
}

async function newestTag(url, subdir) {
  return newestRelease(await remoteTags(url), subdir)?.tag ?? null;
}

// The commit a branch or tag (or, with no ref, the default branch) is at now.
async function remoteCommit(url, ref) {
  const out = await git(["ls-remote", "--", url, ref ?? "HEAD"]);
  const lines = out
    .split("\n")
    .map((l) => l.trim().split("\t"))
    .filter((l) => l.length === 2);
  // A name can match a branch and a tag; the branch wins, as in `git clone
  // --branch`. An annotated tag's peeled line (^{}) is its commit.
  const pick =
    lines.find(([, name]) => name === `refs/heads/${ref}`) ??
    lines.find(([, name]) => name === `refs/tags/${ref}^{}`) ??
    lines[0];
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
async function fetchSource(source, dest) {
  const ref = source.ref ?? (await newestTag(source.url, source.subdir));
  const args = ["-c", "core.symlinks=false", "clone", "--depth", "1", "--quiet"];
  if (ref) args.push("--branch", ref);
  args.push("--", source.url, dest);
  await git(args);
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
  remoteTags,
  newestRelease,
  remoteCommit,
  newer,
};
