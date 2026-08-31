# GitHub Repo Panel — Design

Status: approved for planning
Date: 2026-08-31

## Problem

Specterm has no way to see GitHub repo activity (open PRs, open issues, CI
status) without leaving the terminal. This adds a sidebar panel — a third
`SidebarView` alongside the existing Files and Settings panels — that shows
that information for the repo the active tab is sitting in, plus a small
watchlist of pinned repos.

## Non-goals (v1)

- No GraphQL client or GitHub token handling — auth is entirely delegated to
  the `gh` CLI the user already has configured.
- No dedicated keybinding — the existing sidebar toggle button pattern is
  reused.
- No push notifications for CI/PR/issue changes — polling only.
- No per-repo settings UI outside the panel itself (no new Settings section).

## Authentication and data source

All GitHub data is fetched by shelling out to the `gh` CLI from the host
process (Electron main / Tauri), via `execFile` — the same pattern already
used in `electron/main.cjs` for `ps`/`lsof` calls. Specterm never stores a
GitHub token or talks to the GitHub API directly; it reuses whatever `gh auth
login` session already exists on the machine. Commands used, all with
`--json` output so no text-scraping is needed:

- `gh --version` / `gh auth status` — availability/auth check
- `gh repo view <owner>/<repo> --json name,description,stargazerCount,forkCount,primaryLanguage,pushedAt`
- `gh pr list -R <owner>/<repo> --state open --json number,title,author,isDraft,reviewDecision,statusCheckRollup --limit 20`
- `gh issue list -R <owner>/<repo> --state open --json number,title,author,labels --limit 20`
- `gh run list -R <owner>/<repo> --branch <branch> --limit 1 --json status,conclusion,workflowName,url` (only when a branch is known, for the "current repo" section)

Repo detection for the active tab's working directory does not use `gh` at
all — it shells `git rev-parse --show-toplevel`, `git remote get-url origin`,
and `git branch --show-current`, then parses the GitHub `owner/repo` out of
the remote URL (supports both `https://github.com/owner/repo.git` and
`git@github.com:owner/repo.git` forms). A remote that isn't a `github.com`
URL, or a cwd that isn't inside a git repo, yields `null` and the "current
repo" section is hidden.

## Backend / IPC surface

Three new methods added to the `Backend` interface (`src/backends/types.ts`),
implemented in both `src/backends/electron.ts` (backed by new
`ipcMain.handle` entries in `electron/main.cjs`) and `src/backends/tauri.ts`
(backed by a Tauri command), matching the existing dual-backend pattern used
for every other host call:

```ts
ghStatus(): Promise<{ installed: boolean; authenticated: boolean }>;
detectRepo(cwd: string): Promise<{ owner: string; repo: string; branch: string } | null>;
ghRepoSnapshot(owner: string, repo: string, branch?: string): Promise<GithubRepoSnapshot>;
```

`GithubRepoSnapshot` (new type in `src/types/index.ts`):

```ts
interface GithubRepoSnapshot {
  name: string;
  description: string | null;
  stars: number;
  forks: number;
  language: string | null;
  pushedAt: string;
  openPRs: Array<{
    number: number;
    title: string;
    author: string;
    isDraft: boolean;
    reviewDecision: string | null;
    checksStatus: "pending" | "success" | "failure" | null;
    url: string;
  }>;
  openIssues: Array<{
    number: number;
    title: string;
    author: string;
    labels: string[];
    url: string;
  }>;
  branchRun: {
    status: string;
    conclusion: string | null;
    workflowName: string;
    url: string;
  } | null;
}
```

Each of `ghRepoSnapshot`'s underlying `gh` calls runs as its own `execFile`
in parallel (`Promise.all`) inside the single IPC handler, and the handler
combines them into one snapshot before returning to the renderer — the
renderer makes one call per repo per refresh, not four.

## Repo detection wiring ("current repo" section)

Driven by the active tab's pane cwd — the same cwd tracking already used to
seed the file tree and `OSC 7` handling. When the active tab changes, or its
cwd changes, the renderer calls `detectRepo(cwd)`. Result (or `null`) is
cached per tab so switching back to an already-visited tab doesn't refetch.

## Settings

One new persisted setting in `src/stores/settings.ts`:

```ts
githubWatchlist: string[]  // "owner/repo" entries, in display order
```

Follows the existing settings module's pattern (signal + localStorage
persistence under the `specterm.settings` key, backward compatible with
blobs that lack the field). No dedicated Settings-panel UI section — the
watchlist is managed entirely from the GitHub panel (add via a text input,
remove via a per-card ✕).

## New store: `src/stores/github.ts`

Solid store holding:

```ts
snapshots: Record<string, GithubRepoSnapshot | "loading" | "error">  // key = "owner/repo"
ghStatus: "checking" | "missing" | "unauthenticated" | "ready"
currentRepo: { owner: string; repo: string; branch: string } | null
```

Actions: `refresh(key)`, `refreshAll()`, `refreshCurrentRepo(cwd)`,
`addToWatchlist(key)`, `removeFromWatchlist(key)`.

Refresh cadence:
- Every 5 minutes for all watchlist entries plus the current repo (interval
  timer, only running while the GitHub panel exists in the DOM — cleared on
  unmount, same lifecycle discipline as other polling in the codebase, e.g.
  `stores/updater.ts`).
- On opening the panel, if the existing cache for a given key is older than
  30s.
- On active-tab change, re-run `detectRepo` for the new cwd; if it resolves
  to a repo whose cache is older than 30s, call `refresh(key)` for it (the
  same full-snapshot call used everywhere else — `gh`'s four subprocess
  calls are fast enough that a dedicated lighter fetch isn't worth a fourth
  backend method).
- Manual refresh button, both per-card and panel-wide.

## UI: `src/components/GithubPanel.tsx`

Mounted in `App.tsx` next to `FileTree`, gated by the same `<Show>` pattern
against `store.state.sidebarView === "github"`. `SidebarView`
(`src/types/index.ts`) becomes `"files" | "github" | "settings"`.
`TitleStrip.tsx` gets a third toggle icon (Files / GitHub / Settings), wired
to `store.toggleSidebarView("github")`, matching the existing two.

Layout, top to bottom:

1. **Current repo** (hidden entirely if `detectRepo` returned `null` for the
   active tab): repo name, branch name, a CI status pill
   (passed/failed/running/none, clickable → `openExternal` to the run URL),
   and — if one exists — a single line for the open PR on that branch.
2. **Watchlist**: an "add repo" text input (`owner/repo` format, validated
   loosely client-side) at the top, then one collapsible card per pinned
   entry: header row with name, star count, language dot, and PR/issue open
   counts as small badges; expanding a card lists PR/issue titles (PR rows
   show author + a small checks icon). Every title is a link via
   `openExternal`.

Empty/error states, all inline (no modal):
- `gh` not installed → short message + link to the `gh` install docs.
- `gh` installed but not authenticated → message pointing at `gh auth login`.
- A single repo's fetch failing (rate limit, network, repo renamed/deleted)
  → that card shows an inline retry, the rest of the panel keeps working.

Icons come from `lucide-solid` (existing dependency) — star, git-fork,
git-pull-request, circle-dot (issues), and check/x/loader for CI state.

## Testing

- Pure-function unit coverage for the git-remote-URL → `{owner, repo}`
  parser (HTTPS and SSH forms, plus non-GitHub remotes returning `null`) —
  this is the one piece of real parsing logic and is trivial to test in
  isolation.
- Manual smoke test in dev (`npm run dev:electron`) against a real repo with
  `gh` installed and authenticated: verify current-repo detection on tab
  switch, watchlist add/remove/persist across restart, and the three empty
  states (uninstalled/unauthenticated/fetch-error) by temporarily breaking
  each precondition.
- No new Playwright e2e test is planned for v1 — the existing e2e suite
  doesn't stub external CLI calls, and scripting a `gh`-authenticated
  environment inside CI is out of scope here; this is a manual-verification
  feature like the theme gallery.
