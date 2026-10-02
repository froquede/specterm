import { createRoot, createSignal } from "solid-js";
import type { PluginPanelApi } from "../../../src/components/PluginView";
import type { GhStatus, GitRemoteInfo, GithubRepoSnapshot } from "./types";
import { parseGithubRemote } from "./github-remote";
import { parseGitStatus, type GitStatusFile } from "./git-status";

// Snapshot cache and GitHub-CLI status for the panel. Module-level on purpose:
// Specterm keeps this module loaded after the view closes, so the cache
// survives the panel being closed and reopened and picks up where it left off
// instead of re-fetching everything on every toggle. Moved from
// src/stores/github.ts when the panel became a built-in plugin.

export type GhCliStatus = "checking" | "missing" | "unauthenticated" | "ready";

export interface DetectedRepo {
  owner: string;
  repo: string;
  branch: string;
  // The repo's top-level directory — see GitRemoteInfo for why. Used to
  // resolve a changed file's repo-relative path back to an absolute one.
  root: string;
}

// Owned by a root that lives as long as the module: these signals outlast
// every mount of the panel.
const state = createRoot(() => {
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
  const [watchlist, setWatchlistSignal] = createSignal<string[]>([]);
  return {
    ghCliStatus,
    setGhCliStatus,
    currentRepo,
    setCurrentRepo,
    repoSnapshots,
    setRepoSnapshots,
    currentWorkingTreeStatus,
    setCurrentWorkingTreeStatus,
    watchlist,
    setWatchlistSignal,
  };
});

export const { ghCliStatus, currentRepo, repoSnapshots, currentWorkingTreeStatus, watchlist } = state;

// The panel that is mounted now. Every call goes through its api; between
// mounts there is nothing to call with, and nothing runs.
let api: PluginPanelApi | null = null;

const asList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** Attach to a mounted panel. Returns the detach for its cleanup. */
export function attach(panelApi: PluginPanelApi): () => void {
  api = panelApi;
  state.setWatchlistSignal(asList(panelApi.storage.get("watchlist")));
  // Another window changed the watchlist.
  const offStorage = panelApi.storage.onChange((key, value) => {
    if (key === "watchlist") state.setWatchlistSignal(asList(value));
  });
  return () => {
    offStorage();
    if (api === panelApi) api = null;
  };
}

function setWatchlist(list: string[]) {
  state.setWatchlistSignal(list);
  api?.storage.set("watchlist", list);
}

// Last successful (or failed) fetch time per key, so the panel/tab-switch/open
// refresh triggers can skip a repo that was just fetched instead of hammering
// `gh` on every trivial re-render.
const lastFetched = new Map<string, number>();
const STALE_MS = 30_000;

function setSnapshot(key: string, value: GithubRepoSnapshot | "loading" | "error") {
  state.setRepoSnapshots((prev) => ({ ...prev, [key]: value }));
}

export async function checkGhStatus() {
  if (!api) return;
  try {
    const status = (await api.invoke("gh-status")) as GhStatus;
    state.setGhCliStatus(
      !status.installed ? "missing" : !status.authenticated ? "unauthenticated" : "ready"
    );
  } catch (_) {
    // The call itself failed (not just "gh missing") — degrade to a visible
    // "missing" state rather than leaving the panel stuck on "checking"
    // forever with no explanation.
    state.setGhCliStatus("missing");
  }
}

// Staleness-gated by default: a call within STALE_MS of the last successful
// fetch for this key is a no-op, so reopening the panel or a poll tick that
// lands right after a fresh fetch doesn't hammer `gh` for nothing. Pass
// `{ force: true }` for an explicit user action (a click on a refresh/retry
// button, or the interval poll tick) that must always go through.
export async function refresh(key: string, branch?: string, opts: { force?: boolean } = {}) {
  if (state.ghCliStatus() !== "ready" || !api) return;
  const [owner, repo] = key.split("/");
  if (!owner || !repo) return;

  if (!opts.force) {
    const age = Date.now() - (lastFetched.get(key) ?? 0);
    if (age <= STALE_MS) return;
  }

  // Only an empty card shows "Loading…". A repo already on screen keeps its
  // last data while the refetch runs, so the 5-minute poll doesn't blank every
  // card; an error still replaces it, since stale data would read as current.
  if (typeof state.repoSnapshots()[key] !== "object") setSnapshot(key, "loading");
  try {
    const snapshot = (await api.invoke("gh-repo-snapshot", owner, repo, branch)) as GithubRepoSnapshot;
    setSnapshot(key, snapshot);
    lastFetched.set(key, Date.now());
  } catch (_) {
    setSnapshot(key, "error");
  }
}

export async function refreshAll(opts: { force?: boolean } = {}) {
  await checkGhStatus();
  if (state.ghCliStatus() !== "ready") return;
  const current = state.currentRepo();
  const currentKey = current ? `${current.owner}/${current.repo}` : null;
  // Exclude the current repo from the watchlist pass: fetched twice (once
  // with its branch, once without), whichever lands last wins, and the
  // branchless one wipes the CI pill.
  const keys = state.watchlist().filter((key) => key !== currentKey);
  await Promise.all([
    ...keys.map((key) => refresh(key, undefined, opts)),
    currentKey ? refresh(currentKey, current!.branch, opts) : Promise.resolve(),
  ]);
}

// Re-detects the repo for `cwd` (the active pane's directory) and hands off
// to refresh()'s own staleness gate.
// Every await below can be overtaken by a newer call (a quick pane switch, a
// `cd` right after another), and a slow `git` answering for the old directory
// must not overwrite the new one. Each call takes a generation number and
// drops its results once a later call has started.
let detectGeneration = 0;

export async function refreshCurrentRepo(cwd: string | null) {
  const generation = ++detectGeneration;
  const stale = () => generation !== detectGeneration;
  const clear = () => {
    state.setCurrentRepo(null);
    state.setCurrentWorkingTreeStatus(null);
  };
  if (!cwd || !api) return clear();
  const info = (await api.invoke("git-remote-info", cwd)) as GitRemoteInfo | null;
  if (stale()) return;
  if (!info) return clear();
  const parsed = parseGithubRemote(info.remoteUrl);
  if (!parsed) return clear();
  const detected: DetectedRepo = { ...parsed, branch: info.branch, root: info.root };
  state.setCurrentRepo(detected);

  // git-only, no `gh` needed — fetched every time the repo itself is
  // re-detected (tab/pane switch, `cd`), same cadence as detection, no
  // separate polling infra.
  const rawStatus = (await api?.invoke("git-status-raw", cwd)) as string | null;
  if (stale()) return;
  state.setCurrentWorkingTreeStatus(rawStatus != null ? parseGitStatus(rawStatus) : null);

  await refresh(`${parsed.owner}/${parsed.repo}`, info.branch);
}

export function addToWatchlist(key: string) {
  const trimmed = key.trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(trimmed)) return; // loose owner/repo shape check
  if (state.watchlist().includes(trimmed)) return;
  setWatchlist([...state.watchlist(), trimmed]);
  void refresh(trimmed, undefined, { force: true });
}

export function removeFromWatchlist(key: string) {
  setWatchlist(state.watchlist().filter((k) => k !== key));
}

// Started on mount, stopped on unmount. Refreshes everything (watchlist +
// current repo) every 5 minutes while the panel is open; a closed panel has no
// timer running at all.
const POLL_MS = 5 * 60 * 1000;

export function startGithubPolling(): () => void {
  void refreshAll();
  const id = window.setInterval(() => void refreshAll({ force: true }), POLL_MS);
  return () => window.clearInterval(id);
}
