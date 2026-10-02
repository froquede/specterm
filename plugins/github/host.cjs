// The GitHub panel's host side: read-only `git` and `gh` calls, run in
// Specterm's plugin host process. git-remote-info and git-status-raw need only
// `git`; gh-status and gh-repo-snapshot need the `gh` CLI, which the user
// installs and authenticates outside Specterm, so no token ever passes through
// here. Moved from electron/main.cjs when the panel became a built-in plugin.

const { execFile } = require("child_process");

// Runs `cmd` and resolves with trimmed stdout, or rejects with the error
// (stdout/stderr attached) on a non-zero exit, spawn failure, or timeout.
// Every git/gh call below goes through this — args
// are always passed as an array, never interpolated into a shell string, so
// there is nothing here for a hostile "owner/repo" to inject into.
function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

function activate(ctx) {
  ctx.handle("git-remote-info", async (cwd) => {
    try {
      const [remoteUrl, branch, root] = await Promise.all([
        runCmd("git", ["-C", cwd, "remote", "get-url", "origin"]),
        runCmd("git", ["-C", cwd, "branch", "--show-current"]).catch(() => ""),
        runCmd("git", ["-C", cwd, "rev-parse", "--show-toplevel"]),
      ]);
      return { remoteUrl, branch, root };
    } catch (_) {
      // Not a git repo, or no `origin` remote — nothing to detect.
      return null;
    }
  });

  // Raw `git status --porcelain=v1` output for the working tree at `cwd`. No
  // parsing here on purpose — that logic lives in src/git-status.ts, where
  // it's plain testable TS instead of buried in this file.
  //
  // `--untracked-files=all` matters: without it, a new directory with no
  // tracked files in it collapses to one "?? somedir/" line instead of listing
  // what's actually inside — which the panel would otherwise render as a
  // clickable "file" that can't be opened, since it's a directory.
  //
  // Deliberately NOT routed through runCmd: its `stdout.trim()` strips the
  // leading space off the first line's status column (e.g. " M file" →
  // "M file"), which throws off every fixed-offset slice in parseGitStatus by
  // one character — silently mis-parsing only the first changed file. Trim
  // the trailing newline only; parseGitStatus already skips blank lines, so
  // there's nothing else here to clean up.
  ctx.handle("git-status-raw", (cwd) => {
    return new Promise((resolve) => {
      execFile(
        "git",
        ["-C", cwd, "status", "--porcelain=v1", "--untracked-files=all"],
        { timeout: 15000 },
        (err, stdout) => {
          // Not a git repo, or the command failed for some other reason.
          resolve(err ? null : stdout.replace(/\n$/, ""));
        }
      );
    });
  });

  ctx.handle("gh-status", async () => {
    try {
      await runCmd("gh", ["--version"]);
    } catch (_) {
      return { installed: false, authenticated: false };
    }
    try {
      // Writes its human-readable report to stderr; exit 0 means at least one
      // host is authenticated, which is all the panel needs to know.
      await runCmd("gh", ["auth", "status"]);
      return { installed: true, authenticated: true };
    } catch (_) {
      return { installed: true, authenticated: false };
    }
  });

  // gh's statusCheckRollup is an array of check-run/status-context objects.
  // Rolled up to one of three states: any real failure wins, anything still
  // running or unreported counts as pending, and an empty/all-success array is
  // success. No PR carries this field at all when the branch has no checks
  // configured, hence the two guards up front.
  function summarizeChecks(rollup) {
    if (!Array.isArray(rollup) || rollup.length === 0) return null;
    const bad = ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"];
    const pending = ["PENDING", "QUEUED", "IN_PROGRESS", "REQUESTED", "WAITING"];
    let sawPending = false;
    for (const check of rollup) {
      const state = String(check.conclusion || check.state || check.status || "").toUpperCase();
      if (bad.includes(state)) return "failure";
      if (pending.includes(state) || !state) sawPending = true;
    }
    return sawPending ? "pending" : "success";
  }

  ctx.handle("gh-repo-snapshot", async (owner, repo, branch) => {
    // The panel's watchlist accepts anything shaped like owner/repo, and a
    // name starting with "-" would reach `gh` as a flag. GitHub's own rule
    // for owner and repo names is narrower than that.
    const NAME = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
    if (!NAME.test(String(owner)) || !NAME.test(String(repo))) throw new Error("not a GitHub owner/repo");
    if (branch !== undefined && (typeof branch !== "string" || branch.startsWith("-"))) branch = undefined;
    const nwo = `${owner}/${repo}`;

    const [repoOut, prOut, issueOut, runOut] = await Promise.all([
      runCmd("gh", [
        "repo", "view", nwo, "--json",
        "name,description,stargazerCount,forkCount,primaryLanguage,pushedAt,url",
      ]),
      runCmd("gh", [
        "pr", "list", "-R", nwo, "--state", "open", "--json",
        "number,title,author,isDraft,reviewDecision,statusCheckRollup,url",
        "--limit", "20",
      ]),
      runCmd("gh", [
        "issue", "list", "-R", nwo, "--state", "open", "--json",
        "number,title,author,labels,url",
        "--limit", "20",
      ]),
      branch
        ? runCmd("gh", [
            "run", "list", "-R", nwo, "--branch", branch, "--limit", "1", "--json",
            "status,conclusion,workflowName,url",
          ]).catch(() => "[]")
        : Promise.resolve("[]"),
    ]);

    const repoJson = JSON.parse(repoOut);
    const prs = JSON.parse(prOut);
    const issues = JSON.parse(issueOut);
    const runs = JSON.parse(runOut);

    return {
      name: repoJson.name,
      description: repoJson.description || null,
      stars: repoJson.stargazerCount ?? 0,
      forks: repoJson.forkCount ?? 0,
      language: repoJson.primaryLanguage?.name ?? null,
      pushedAt: repoJson.pushedAt,
      url: repoJson.url,
      openPRs: prs.map((pr) => ({
        number: pr.number,
        title: pr.title,
        author: pr.author?.login ?? "unknown",
        isDraft: !!pr.isDraft,
        reviewDecision: pr.reviewDecision || null,
        checksStatus: summarizeChecks(pr.statusCheckRollup),
        url: pr.url,
      })),
      openIssues: issues.map((issue) => ({
        number: issue.number,
        title: issue.title,
        author: issue.author?.login ?? "unknown",
        labels: (issue.labels || []).map((l) => l.name),
        url: issue.url,
      })),
      branchRun: runs[0]
        ? {
            status: runs[0].status,
            conclusion: runs[0].conclusion || null,
            workflowName: runs[0].workflowName,
            url: runs[0].url,
          }
        : null,
    };
  });
}

module.exports = { activate };
