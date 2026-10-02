// What host.cjs returns. Moved from src/backends/types.ts with the panel.

// Raw git-remote info for a directory, read straight off the local repo — no
// network call. `branch` is "" for a detached HEAD; `remoteUrl` is whatever
// `git remote get-url origin` printed, unparsed (see github-remote.ts for
// turning it into an owner/repo).
export interface GitRemoteInfo {
  remoteUrl: string;
  branch: string;
  // The repo's top-level directory — `git status --porcelain` reports every
  // path relative to this, not to whatever cwd it was invoked from, so
  // resolving a changed file back to an absolute path needs it.
  root: string;
}

// Whether the `gh` CLI is usable at all. `authenticated` is only meaningful
// when `installed` is true.
export interface GhStatus {
  installed: boolean;
  authenticated: boolean;
}

export interface GithubPullRequest {
  number: number;
  title: string;
  author: string;
  isDraft: boolean;
  reviewDecision: string | null;
  checksStatus: "pending" | "success" | "failure" | null;
  url: string;
}

export interface GithubIssue {
  number: number;
  title: string;
  author: string;
  labels: string[];
  url: string;
}

export interface GithubBranchRun {
  status: string;
  conclusion: string | null;
  workflowName: string;
  url: string;
}

// One repo's worth of data for the panel, assembled host-side from several
// `gh` subcommands into a single round trip.
export interface GithubRepoSnapshot {
  name: string;
  description: string | null;
  stars: number;
  forks: number;
  language: string | null;
  pushedAt: string;
  url: string;
  openPRs: GithubPullRequest[];
  openIssues: GithubIssue[];
  branchRun: GithubBranchRun | null;
}
