import { createSignal } from "solid-js";
import { getBackend } from "../backends";
import type { GithubRepoSnapshot } from "../backends/types";
import { parseGithubRemote } from "../lib/github-remote";
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
}

const [ghCliStatus, setGhCliStatus] = createSignal<GhCliStatus>("checking");
const [currentRepo, setCurrentRepo] = createSignal<DetectedRepo | null>(null);
const [repoSnapshots, setRepoSnapshots] = createSignal<
  Record<string, GithubRepoSnapshot | "loading" | "error">
>({});

export { ghCliStatus, currentRepo, repoSnapshots };
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
  const status = await backend.ghStatus();
  setGhCliStatus(
    !status.installed
      ? "missing"
      : !status.authenticated
        ? "unauthenticated"
        : "ready"
  );
  return status;
}

export async function refresh(key: string, branch?: string) {
  if (ghCliStatus() !== "ready") return;
  const [owner, repo] = key.split("/");
  if (!owner || !repo) return;

  setSnapshot(key, "loading");
  try {
    const backend = await getBackend();
    const snapshot = await backend.ghRepoSnapshot(owner, repo, branch);
    setSnapshot(key, snapshot);
    lastFetched.set(key, Date.now());
  } catch (_) {
    setSnapshot(key, "error");
  }
}

export async function refreshAll() {
  await checkGhStatus();
  if (ghCliStatus() !== "ready") return;
  const keys = watchlist();
  const current = currentRepo();
  const currentKey = current ? `${current.owner}/${current.repo}` : null;
  await Promise.all([
    ...keys.map((key) => refresh(key)),
    currentKey ? refresh(currentKey, current!.branch) : Promise.resolve(),
  ]);
}

// Re-detects the repo for `cwd` (the active pane's directory) and, if it
// resolves to a GitHub repo whose cache is stale, refreshes it. Called on
// every active-pane change — see GithubPanel's effect in Task 7.
export async function refreshCurrentRepo(cwd: string) {
  if (!cwd) {
    setCurrentRepo(null);
    return;
  }
  const backend = await getBackend();
  const info = await backend.gitRemoteInfo(cwd);
  if (!info) {
    setCurrentRepo(null);
    return;
  }
  const parsed = parseGithubRemote(info.remoteUrl);
  if (!parsed) {
    setCurrentRepo(null);
    return;
  }
  const detected: DetectedRepo = { ...parsed, branch: info.branch };
  setCurrentRepo(detected);

  const key = `${parsed.owner}/${parsed.repo}`;
  const age = Date.now() - (lastFetched.get(key) ?? 0);
  if (age > STALE_MS) await refresh(key, info.branch);
}

export function addToWatchlist(key: string) {
  const trimmed = key.trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(trimmed)) return; // loose owner/repo shape check
  if (watchlist().includes(trimmed)) return;
  setGithubWatchlist([...watchlist(), trimmed]);
  void refresh(trimmed);
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
  const id = window.setInterval(() => void refreshAll(), POLL_MS);
  return () => window.clearInterval(id);
}
