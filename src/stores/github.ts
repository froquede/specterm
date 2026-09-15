import { createSignal } from "solid-js";
import { getBackend } from "../backends";
import type { GithubRepoSnapshot } from "../backends/types";
import { parseGithubRemote } from "../lib/github-remote";
import { parseGitStatus, type GitStatusFile } from "../lib/git-status";
import { githubWatchlist, setGithubWatchlist } from "./settings";

// Snapshot cache and GitHub-CLI status for the sidebar panel. Lives outside
// the panel component (same reasoning as stores/updater.ts): the 5-minute
// poll should survive the panel being closed and reopened, picking up right
// where it left off rather than re-fetching everything on every toggle.

export type GhCliStatus = "checking" | "missing" | "unauthenticated" | "ready";

export interface DetectedRepo {
  owner: string;
  repo: string;
  branch: string;
  // The repo's top-level directory — see GitRemoteInfo for why. Used to
  // resolve a changed file's repo-relative path back to an absolute one.
  root: string;
}

const [ghCliStatus, setGhCliStatus] = createSignal<GhCliStatus>("checking");
const [currentRepo, setCurrentRepo] = createSignal<DetectedRepo | null>(null);
const [repoSnapshots, setRepoSnapshots] = createSignal<
  Record<string, GithubRepoSnapshot | "loading" | "error">
>({});
// The current repo's working-tree status (git-only, no `gh`) — null while
// unknown/not-a-repo, [] for a clean tree. Refreshed in lockstep with
// currentRepo itself; see refreshCurrentRepo.
const [currentWorkingTreeStatus, setCurrentWorkingTreeStatus] = createSignal<
  GitStatusFile[] | null
>(null);

export { ghCliStatus, currentRepo, repoSnapshots, currentWorkingTreeStatus };
export const watchlist = githubWatchlist;

// Last successful (or failed) fetch time per key, so the panel/tab-switch/open
// refresh triggers can skip a repo that was just fetched instead of hammering
// `gh` on every trivial re-render.
const lastFetched = new Map<string, number>();
const STALE_MS = 30_000;

function setSnapshot(
  key: string,
  value: GithubRepoSnapshot | "loading" | "error"
) {
  setRepoSnapshots((prev) => ({ ...prev, [key]: value }));
}

export async function checkGhStatus() {
  const backend = await getBackend();
  try {
    const status = await backend.ghStatus();
    setGhCliStatus(
      !status.installed
        ? "missing"
        : !status.authenticated
          ? "unauthenticated"
          : "ready"
    );
    return status;
  } catch (_) {
    // The IPC call itself failed (not just "gh missing") — degrade to a
    // visible "missing" state rather than leaving the panel stuck on
    // "checking" forever with no explanation.
    setGhCliStatus("missing");
    return { installed: false, authenticated: false };
  }
}

// Staleness-gated by default: a call within STALE_MS of the last successful
// fetch for this key is a no-op, so reopening the panel or a poll tick that
// lands right after a fresh fetch doesn't hammer `gh` for nothing. Pass
// `{ force: true }` for an explicit user action (a click on a refresh/retry
// button, or the interval poll tick) that must always go through.
export async function refresh(
  key: string,
  branch?: string,
  opts: { force?: boolean } = {}
) {
  if (ghCliStatus() !== "ready") return;
  const [owner, repo] = key.split("/");
  if (!owner || !repo) return;

  if (!opts.force) {
    const age = Date.now() - (lastFetched.get(key) ?? 0);
    if (age <= STALE_MS) return;
  }

  // Only an empty card shows "Loading…". A repo already on screen keeps its
  // last data while the refetch runs, so the 5-minute poll doesn't blank every
  // card; an error still replaces it, since stale data would read as current.
  if (typeof repoSnapshots()[key] !== "object") setSnapshot(key, "loading");
  try {
    const backend = await getBackend();
    const snapshot = await backend.ghRepoSnapshot(owner, repo, branch);
    setSnapshot(key, snapshot);
    lastFetched.set(key, Date.now());
  } catch (_) {
    setSnapshot(key, "error");
  }
}

export async function refreshAll(opts: { force?: boolean } = {}) {
  await checkGhStatus();
  if (ghCliStatus() !== "ready") return;
  const current = currentRepo();
  const currentKey = current ? `${current.owner}/${current.repo}` : null;
  // Exclude the current repo from the watchlist pass: fetched twice (once
  // with its branch, once without), whichever lands last wins, and the
  // branchless one wipes the CI pill.
  const keys = watchlist().filter((key) => key !== currentKey);
  await Promise.all([
    ...keys.map((key) => refresh(key, undefined, opts)),
    currentKey ? refresh(currentKey, current!.branch, opts) : Promise.resolve(),
  ]);
}

// Re-detects the repo for `cwd` (the active pane's directory) and hands off
// to refresh()'s own staleness gate — see the comment there for why this no
// longer duplicates that check itself.
// Every await below can be overtaken by a newer call (a quick pane switch, a
// `cd` right after another), and a slow `git` answering for the old directory
// must not overwrite the new one. Each call takes a generation number and
// drops its results once a later call has started.
let detectGeneration = 0;

export async function refreshCurrentRepo(cwd: string) {
  const generation = ++detectGeneration;
  const stale = () => generation !== detectGeneration;
  if (!cwd) {
    setCurrentRepo(null);
    setCurrentWorkingTreeStatus(null);
    return;
  }
  const backend = await getBackend();
  const info = await backend.gitRemoteInfo(cwd);
  if (stale()) return;
  if (!info) {
    setCurrentRepo(null);
    setCurrentWorkingTreeStatus(null);
    return;
  }
  const parsed = parseGithubRemote(info.remoteUrl);
  if (!parsed) {
    setCurrentRepo(null);
    setCurrentWorkingTreeStatus(null);
    return;
  }
  const detected: DetectedRepo = { ...parsed, branch: info.branch, root: info.root };
  setCurrentRepo(detected);

  // git-only, no `gh` needed — fetched every time the repo itself is
  // re-detected (tab/pane switch, `cd`), same cadence as detection, no
  // separate polling infra.
  const rawStatus = await backend.gitStatusRaw(cwd);
  if (stale()) return;
  setCurrentWorkingTreeStatus(rawStatus !== null ? parseGitStatus(rawStatus) : null);

  const key = `${parsed.owner}/${parsed.repo}`;
  await refresh(key, info.branch);
}

export function addToWatchlist(key: string) {
  const trimmed = key.trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(trimmed)) return; // loose owner/repo shape check
  if (watchlist().includes(trimmed)) return;
  setGithubWatchlist([...watchlist(), trimmed]);
  void refresh(trimmed, undefined, { force: true });
}

export function removeFromWatchlist(key: string) {
  setGithubWatchlist(watchlist().filter((k) => k !== key));
}

// Started on GithubPanel mount, stopped on unmount. Refreshes everything
// (watchlist + current repo) every 5 minutes while the panel is open; a
// closed panel has no timer running at all.
const POLL_MS = 5 * 60 * 1000;

export function startGithubPolling(): () => void {
  void refreshAll();
  const id = window.setInterval(() => void refreshAll({ force: true }), POLL_MS);
  return () => window.clearInterval(id);
}
