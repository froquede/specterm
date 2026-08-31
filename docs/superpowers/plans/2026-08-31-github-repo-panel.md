# GitHub Repo Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third sidebar panel (alongside Files and Settings) that shows GitHub repo activity — the repo detected from the active pane's directory, plus a small pinned watchlist — using the `gh` CLI for all API access.

**Architecture:** Electron main (and a Tauri stub) shell out to `git`/`gh` via `execFile` and expose three new `Backend` methods (`gitRemoteInfo`, `ghStatus`, `ghRepoSnapshot`). A pure renderer-side parser turns a git remote URL into `{owner, repo}`. A new `stores/github.ts` module caches per-repo snapshots and polls every 5 minutes while the panel is mounted. `GithubPanel.tsx` is lazy-mounted exactly like `SettingsPanel`, toggled by a third icon in `TabBar`, occupying the same exclusive `sidebarView` slot as Files/Settings.

**Tech Stack:** SolidJS, TypeScript, Electron (`child_process.execFile`), the `gh` CLI (external, user-installed), `lucide-solid` icons.

**Spec:** `docs/superpowers/specs/2026-08-31-github-repo-panel-design.md`

## Global Constraints

- No GitHub token is ever stored or handled by specterm — every API call goes through the `gh` CLI, which owns its own auth (spec: "Authentication and data source").
- No GraphQL client — `gh`'s own `--json`-flagged subcommands are the only data source (spec: "Non-goals").
- No dedicated keybinding for the new panel — a toggle button only, matching the existing Settings toggle (spec: "Non-goals").
- The `githubWatchlist` setting is `string[]` of `"owner/repo"` entries, persisted and cross-window-synced exactly like every other field in `src/stores/settings.ts` (spec: "Settings").
- `SidebarView` becomes `"files" | "github" | "settings"`; Files/GitHub/Settings remain mutually exclusive — one field, not three booleans (spec: "UI").
- Every new `Backend` method must be implemented on both `ElectronBackend` and `TauriBackend` so the project keeps compiling; the Tauri side may stub GitHub methods as unavailable, matching how it already stubs `listDrives`, `notifyWaiting`, etc. — Electron is the shipping backend for this feature.

---

### Task 1: Backend contract — types and both backend implementations

**Files:**
- Modify: `src/types/index.ts:100` (`SidebarView`)
- Modify: `src/backends/types.ts` (new types + `Backend` interface)
- Modify: `src/backends/electron.ts` (new `SpectermAPI` members + `ElectronBackend` methods)
- Modify: `src/backends/tauri.ts` (new `TauriBackend` stub methods)
- Modify: `src/lib/sidebar-state.ts:18` (`VALID` list)

**Interfaces:**
- Produces: `GitRemoteInfo { remoteUrl: string; branch: string }`, `GhStatus { installed: boolean; authenticated: boolean }`, `GithubRepoSnapshot` (full shape below), and three `Backend` methods:
  - `gitRemoteInfo(cwd: string): Promise<GitRemoteInfo | null>`
  - `ghStatus(): Promise<GhStatus>`
  - `ghRepoSnapshot(owner: string, repo: string, branch?: string): Promise<GithubRepoSnapshot>`
  These are the exact names every later task calls.

- [ ] **Step 1: Add `GithubRepoSnapshot` and friends to `src/backends/types.ts`**

Add near the bottom of the file, just above `export interface Backend {`:

```ts
// Raw git-remote info for a directory, read straight off the local repo — no
// network call. `branch` is "" for a detached HEAD; `remoteUrl` is whatever
// `git remote get-url origin` printed, unparsed (see lib/github-remote.ts for
// turning it into an owner/repo).
export interface GitRemoteInfo {
  remoteUrl: string;
  branch: string;
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
// `gh` subcommands into a single IPC round trip.
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
```

- [ ] **Step 2: Add the three methods to the `Backend` interface**

In `src/backends/types.ts`, inside `export interface Backend { ... }`, add a new section right after the Filesystem block (after `onFsChange`/`onOpenPath`/`getHomePath`/`getHostname`/clipboard methods, before `// Window`):

```ts
  // --- GitHub panel -----------------------------------------------------
  //
  // All three are read-only, best-effort host calls. gitRemoteInfo needs
  // nothing but `git`; the other two need the `gh` CLI, already authenticated
  // by the user outside specterm — no token ever passes through here.

  // Local git remote/branch for a directory. null when the directory isn't
  // inside a git repo, or the repo has no `origin` remote.
  gitRemoteInfo(cwd: string): Promise<GitRemoteInfo | null>;
  // Whether `gh` is installed and authenticated, checked fresh each call —
  // cheap, and the answer can change any time outside the app.
  ghStatus(): Promise<GhStatus>;
  // Repo overview + open PRs + open issues + (when `branch` is given) that
  // branch's latest workflow run, in one call.
  ghRepoSnapshot(
    owner: string,
    repo: string,
    branch?: string
  ): Promise<GithubRepoSnapshot>;
```

- [ ] **Step 3: Widen `SidebarView`**

In `src/types/index.ts:100`, change:

```ts
export type SidebarView = "files" | "settings";
```

to:

```ts
export type SidebarView = "files" | "github" | "settings";
```

- [ ] **Step 4: Add `"github"` to the sidebar-state allowlist**

In `src/lib/sidebar-state.ts:18`, change:

```ts
const VALID: readonly (SidebarView | null)[] = ["files", "settings", null];
```

to:

```ts
const VALID: readonly (SidebarView | null)[] = ["files", "github", "settings", null];
```

- [ ] **Step 5: Implement the three methods on `ElectronBackend`**

In `src/backends/electron.ts`, add the three GitHub types to the `import type { ... } from "./types"` block at the top (alongside the existing `FileEntry, FileEntryStats, ...`):

```ts
  GitRemoteInfo,
  GhStatus,
  GithubRepoSnapshot,
```

Add the matching three lines to the `SpectermAPI` interface (right after `clipboardWriteText`):

```ts
  gitRemoteInfo(cwd: string): Promise<GitRemoteInfo | null>;
  ghStatus(): Promise<GhStatus>;
  ghRepoSnapshot(
    owner: string,
    repo: string,
    branch?: string
  ): Promise<GithubRepoSnapshot>;
```

Add the three method implementations to the `ElectronBackend` class body (right after `clipboardWriteText`):

```ts
  async gitRemoteInfo(cwd: string): Promise<GitRemoteInfo | null> {
    return this.api.gitRemoteInfo(cwd);
  }

  async ghStatus(): Promise<GhStatus> {
    return this.api.ghStatus();
  }

  async ghRepoSnapshot(
    owner: string,
    repo: string,
    branch?: string
  ): Promise<GithubRepoSnapshot> {
    return this.api.ghRepoSnapshot(owner, repo, branch);
  }
```

- [ ] **Step 6: Stub the three methods on `TauriBackend`**

In `src/backends/tauri.ts`, add the three types to the existing `import type { ... } from "./types"` block. Then add, right after `clipboardWriteText`:

```ts
  // No Tauri commands for git/gh yet — Electron is the shipping target for
  // this feature (same reasoning as listDrives/notifyWaiting above). A
  // "not installed" answer keeps the panel's empty state truthful rather
  // than silently hanging.
  async gitRemoteInfo(_cwd: string): Promise<GitRemoteInfo | null> {
    return null;
  }

  async ghStatus(): Promise<GhStatus> {
    return { installed: false, authenticated: false };
  }

  async ghRepoSnapshot(
    _owner: string,
    _repo: string,
    _branch?: string
  ): Promise<GithubRepoSnapshot> {
    throw new Error("GitHub data is not available on this backend");
  }
```

- [ ] **Step 7: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors. (`window.specterm.gitRemoteInfo` etc. don't exist at runtime yet — that's Task 2 — but nothing here calls them yet, so this is purely a type-level check.)

- [ ] **Step 8: Commit**

```bash
git add src/types/index.ts src/backends/types.ts src/backends/electron.ts src/backends/tauri.ts src/lib/sidebar-state.ts
git commit -m "feat: add GitHub backend contract (types + electron/tauri stubs)"
```

---

### Task 2: Electron host — `git`/`gh` IPC handlers

**Files:**
- Modify: `electron/preload.cjs` (expose the three channels)
- Modify: `electron/main.cjs` (implement the three `ipcMain.handle`s)

**Interfaces:**
- Consumes: nothing from earlier tasks (plain JS, no TS imports).
- Produces: the `gitRemoteInfo(cwd)` / `ghStatus()` / `ghRepoSnapshot(owner, repo, branch)` promises that Task 1's `ElectronBackend` already calls through `window.specterm`.

- [ ] **Step 1: Add a small `execFile`-as-promise helper to `main.cjs`**

Add near the top of `electron/main.cjs`, after the existing `const { execFile, spawn } = require("child_process");` line:

```js
// Runs `cmd` and resolves with trimmed stdout, or rejects with the error
// (stdout/stderr attached) on a non-zero exit, spawn failure, or timeout.
// Every git/gh call in the GitHub panel IPC below goes through this — args
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
```

- [ ] **Step 2: Add the `git-remote-info` handler**

Add near the other filesystem/git-adjacent handlers in `main.cjs` (e.g. right after the `get-hostname` handler):

```js
// === GitHub panel IPC ===
//
// git-remote-info needs only `git`, already required for anything specterm
// does with a repo. gh-status/gh-repo-snapshot need the `gh` CLI, which the
// user installs and authenticates outside the app — see runCmd above for why
// none of this is a shell-injection risk.

ipcMain.handle("git-remote-info", async (_event, cwd) => {
  try {
    const [remoteUrl, branch] = await Promise.all([
      runCmd("git", ["-C", cwd, "remote", "get-url", "origin"]),
      runCmd("git", ["-C", cwd, "branch", "--show-current"]).catch(() => ""),
    ]);
    return { remoteUrl, branch };
  } catch (_) {
    // Not a git repo, or no `origin` remote — nothing to detect.
    return null;
  }
});
```

- [ ] **Step 3: Add the `gh-status` handler**

```js
ipcMain.handle("gh-status", async () => {
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
```

- [ ] **Step 4: Add the `gh-repo-snapshot` handler**

```js
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

ipcMain.handle("gh-repo-snapshot", async (_event, owner, repo, branch) => {
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
```

- [ ] **Step 5: Expose the three channels in `preload.cjs`**

In `electron/preload.cjs`, inside the `contextBridge.exposeInMainWorld("specterm", { ... })` object, add near `getHostname`:

```js
  // GitHub panel
  gitRemoteInfo: (cwd) => ipcRenderer.invoke("git-remote-info", cwd),
  ghStatus: () => ipcRenderer.invoke("gh-status"),
  ghRepoSnapshot: (owner, repo, branch) =>
    ipcRenderer.invoke("gh-repo-snapshot", owner, repo, branch),
```

- [ ] **Step 6: Manual verification**

Run: `npm run dev:electron`

Once the window is open, open its DevTools (it's the Electron renderer window — `Ctrl+Shift+I` / `Cmd+Option+I`) and in the console run:

```js
await window.specterm.ghStatus()
```
Expected: `{ installed: true, authenticated: true }` if `gh` is installed and logged in on this machine (or `{ installed: false, authenticated: false }` / `{ installed: true, authenticated: false }` otherwise — any of the three shapes confirms the handler works).

```js
await window.specterm.gitRemoteInfo(process.cwd ? process.cwd() : "/home/nexfar/Desktop/specterm")
```
Expected: `{ remoteUrl: "...", branch: "..." }` for this repo's own checkout.

If `gh` is installed and authenticated, also run:
```js
await window.specterm.ghRepoSnapshot("froquede", "specterm")
```
Expected: an object with `name: "specterm"`, `openPRs`, `openIssues`, etc.

- [ ] **Step 7: Commit**

```bash
git add electron/preload.cjs electron/main.cjs
git commit -m "feat: add git/gh IPC handlers for the GitHub panel"
```

---

### Task 3: Pure GitHub remote-URL parser

**Files:**
- Create: `src/lib/github-remote.ts`

**Interfaces:**
- Produces: `parseGithubRemote(url: string): { owner: string; repo: string } | null`, used by Task 5's `stores/github.ts`.

- [ ] **Step 1: Write a throwaway TDD check (not committed)**

Create a scratch file to drive development — this project has no unit-test runner, so this file is deleted once the implementation passes; the permanent regression coverage for this logic is the e2e check in Task 8.

Create `/tmp/check-github-remote.mjs`:

```js
import { parseGithubRemote } from "/home/nexfar/Desktop/specterm/src/lib/github-remote.ts";

const cases = [
  ["https://github.com/acme/widgets.git", { owner: "acme", repo: "widgets" }],
  ["https://github.com/acme/widgets", { owner: "acme", repo: "widgets" }],
  ["git@github.com:acme/widgets.git", { owner: "acme", repo: "widgets" }],
  ["ssh://git@github.com/acme/widgets.git", { owner: "acme", repo: "widgets" }],
  ["https://gitlab.com/acme/widgets.git", null],
  ["not a url at all", null],
];

let failed = 0;
for (const [input, expected] of cases) {
  const got = parseGithubRemote(input);
  const pass = JSON.stringify(got) === JSON.stringify(expected);
  console.log(pass ? "PASS" : "FAIL", input, "->", JSON.stringify(got));
  if (!pass) failed++;
}
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --experimental-strip-types /tmp/check-github-remote.mjs`
Expected: FAIL — `src/lib/github-remote.ts` doesn't exist yet (module resolution error).

- [ ] **Step 3: Write the implementation**

Create `src/lib/github-remote.ts`:

```ts
// Turns a git remote URL into a GitHub owner/repo pair, or null if it isn't
// a github.com remote at all. Handles the three shapes `git remote get-url`
// actually prints: https, the git@ scp-like form, and explicit ssh://.
export function parseGithubRemote(
  url: string
): { owner: string; repo: string } | null {
  const clean = url.trim().replace(/\.git$/, "");

  const patterns = [
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/,
    /^git@github\.com:([^/]+)\/([^/]+)$/,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(clean);
    if (match) return { owner: match[1], repo: match[2] };
  }
  return null;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --experimental-strip-types /tmp/check-github-remote.mjs`
Expected: all six cases PASS, exit code 0.

- [ ] **Step 5: Clean up the scratch file and verify the real build**

Run: `rm /tmp/check-github-remote.mjs && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/github-remote.ts
git commit -m "feat: add GitHub remote URL parser"
```

---

### Task 4: `githubWatchlist` setting

**Files:**
- Modify: `src/stores/settings.ts`

**Interfaces:**
- Produces: `githubWatchlist(): string[]` signal, `setGithubWatchlist(v: string[]): void`, used by Task 5's `stores/github.ts`.

- [ ] **Step 1: Add the field to `Persisted` and `DEFAULTS`**

In `src/stores/settings.ts`, add to the `Persisted` interface (after `clockFormat: string;`):

```ts
  githubWatchlist: string[];
```

Add to `DEFAULTS` (after `clockFormat: CLOCK_FORMAT_DEFAULT,`):

```ts
  githubWatchlist: [],
```

- [ ] **Step 2: Validate it on load**

In `load()`, add to the returned object (after the `clockFormat` field):

```ts
      githubWatchlist: Array.isArray(p.githubWatchlist)
        ? p.githubWatchlist.filter((v) => typeof v === "string")
        : DEFAULTS.githubWatchlist,
```

- [ ] **Step 3: Add the signal**

After `const [clockFormat, setClockFormatSignal] = createSignal(initial.clockFormat);`, add:

```ts
const [githubWatchlist, setGithubWatchlistSignal] = createSignal(
  initial.githubWatchlist
);
```

Add `githubWatchlist,` to the `export { ... }` block right below it.

- [ ] **Step 4: Persist and sync it**

In `persist()`, add to the JSON object (after `clockFormat: clockFormat(),`):

```ts
        githubWatchlist: githubWatchlist(),
```

In `reloadFromStorage()`, add (after `setClockFormatSignal(p.clockFormat);`):

```ts
  setGithubWatchlistSignal(p.githubWatchlist);
```

- [ ] **Step 5: Add the setter**

Add near the other setters (after `setClockFormat`):

```ts
// --- GitHub watchlist -------------------------------------------------------

export function setGithubWatchlist(v: string[]) {
  // Dedupe and drop blanks — the add-repo input in the panel already validates
  // format, this is just the last line of defense against a corrupt blob.
  const cleaned = [...new Set(v.map((s) => s.trim()).filter(Boolean))];
  setGithubWatchlistSignal(cleaned);
  persist();
}
```

- [ ] **Step 6: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/stores/settings.ts
git commit -m "feat: add githubWatchlist setting"
```

---

### Task 5: `stores/github.ts` — snapshot cache and refresh actions

**Files:**
- Create: `src/stores/github.ts`

**Interfaces:**
- Consumes: `getBackend()` (`src/backends`), `parseGithubRemote` (Task 3), `githubWatchlist`/`setGithubWatchlist` (Task 4), `GithubRepoSnapshot`/`GitRemoteInfo`/`GhStatus` types (Task 1).
- Produces (all consumed by Task 7's `GithubPanel.tsx`):
  - `ghCliStatus(): "checking" | "missing" | "unauthenticated" | "ready"`
  - `currentRepo(): { owner: string; repo: string; branch: string } | null`
  - `repoSnapshots(): Record<string, GithubRepoSnapshot | "loading" | "error">`
  - `watchlist(): string[]` (re-export of `githubWatchlist` for convenience)
  - `refreshCurrentRepo(cwd: string): Promise<void>`
  - `refresh(key: string): Promise<void>`
  - `refreshAll(): Promise<void>`
  - `addToWatchlist(key: string): void`
  - `removeFromWatchlist(key: string): void`
  - `startGithubPolling(): () => void` (call on panel mount, call the returned function on unmount)

- [ ] **Step 1: Write the store**

Create `src/stores/github.ts`:

```ts
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
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/stores/github.ts
git commit -m "feat: add GitHub snapshot store with 5-minute polling"
```

---

### Task 6: Icons

**Files:**
- Modify: `src/lib/icons.ts` (chrome-tier toggle icon)
- Modify: `src/lib/icons-lazy.ts` (panel-internal icons)

**Interfaces:**
- Produces: `IconGithubPanel` (from `src/lib/icons`), `IconGitFork`, `IconGitPullRequest`, `IconCircleDot`, `IconCircleCheck`, `IconCircleX`, `IconLoaderCircle` (from `src/lib/icons-lazy`) — all consumed by Task 7.

- [ ] **Step 1: Add the chrome-tier toggle icon**

lucide-solid has no literal "GitHub" brand glyph (brand marks were dropped from the icon set); `git-branch` is the closest generic stand-in and matches the git-prefixed family already used elsewhere in this panel. Add to `src/lib/icons.ts`, after `export { default as IconSettings } from "lucide-solid/icons/settings";`:

```ts
export { default as IconGithubPanel } from "lucide-solid/icons/git-branch";
```

- [ ] **Step 2: Add the panel-internal icons**

`src/lib/icons-lazy.ts` currently opens with a comment scoped to "the settings panel"; the GitHub panel is now also lazy-mounted, so update the comment's first line from:

```ts
// Icons reachable only from the settings panel.
```

to:

```ts
// Icons reachable only from a lazily-mounted panel (Settings, GitHub).
```

Then add, at the end of the file:

```ts
export { default as IconGitFork } from "lucide-solid/icons/git-fork";
export { default as IconGitPullRequest } from "lucide-solid/icons/git-pull-request";
export { default as IconCircleDot } from "lucide-solid/icons/circle-dot";
export { default as IconCircleCheck } from "lucide-solid/icons/circle-check";
export { default as IconCircleX } from "lucide-solid/icons/circle-x";
export { default as IconLoaderCircle } from "lucide-solid/icons/loader-circle";
```

- [ ] **Step 3: Verify the build resolves every icon path**

Run: `npx tsc --noEmit && npx vite build`
Expected: both succeed — a typo'd `lucide-solid/icons/...` path fails module resolution at build time.

- [ ] **Step 4: Commit**

```bash
git add src/lib/icons.ts src/lib/icons-lazy.ts
git commit -m "feat: add icons for the GitHub panel"
```

---

### Task 7: `GithubPanel` component and wiring into `App`/`TabBar`

**Files:**
- Create: `src/components/GithubPanel.tsx`
- Create: `src/styles/github-panel.css`
- Modify: `src/index.tsx` (import the new stylesheet)
- Modify: `src/components/TabBar.tsx` (third toggle button)
- Modify: `src/App.tsx` (lazy-mount the panel, wire the toggle)

**Interfaces:**
- Consumes: everything from Tasks 1, 3, 4, 5, 6; `useTabStore()` (`src/stores/tabs.ts`) for the active pane; `getTerminalCwd` (`src/lib/terminal-registry.ts`) for that pane's live directory; `backend.openExternal` (already on `Backend`) for outbound links.

- [ ] **Step 1: Write `GithubPanel.tsx`**

Create `src/components/GithubPanel.tsx`:

```tsx
import { createEffect, createSignal, For, Show, onCleanup } from "solid-js";
import {
  IconStar,
  IconRefresh,
  ICON_SIZE,
  ICON_STROKE,
} from "../lib/icons";
import {
  IconGitFork,
  IconGitPullRequest,
  IconCircleDot,
  IconCircleCheck,
  IconCircleX,
  IconLoaderCircle,
} from "../lib/icons-lazy";
import { getBackend } from "../backends";
import type { GithubRepoSnapshot } from "../backends/types";
import { useTabStore } from "../stores/tabs";
import { getTerminalCwd } from "../lib/terminal-registry";
import {
  ghCliStatus,
  currentRepo,
  repoSnapshots,
  watchlist,
  refresh,
  refreshCurrentRepo,
  addToWatchlist,
  removeFromWatchlist,
  startGithubPolling,
} from "../stores/github";

function openLink(url: string) {
  void getBackend().then((b) => b.openExternal(url));
}

function ChecksIcon(props: { status: "pending" | "success" | "failure" | null }) {
  return (
    <Show when={props.status}>
      <Show when={props.status === "success"}>
        <IconCircleCheck size={13} stroke-width={ICON_STROKE} class="gh-check-ok" />
      </Show>
      <Show when={props.status === "failure"}>
        <IconCircleX size={13} stroke-width={ICON_STROKE} class="gh-check-fail" />
      </Show>
      <Show when={props.status === "pending"}>
        <IconLoaderCircle size={13} stroke-width={ICON_STROKE} class="gh-check-pending" />
      </Show>
    </Show>
  );
}

function RepoCard(props: { repoKey: string; onRemove?: () => void }) {
  const [expanded, setExpanded] = createSignal(false);
  const snapshot = () => repoSnapshots()[props.repoKey];

  return (
    <div class="gh-card">
      <div class="gh-card-header" onClick={() => setExpanded((v) => !v)}>
        <span class="gh-card-name">{props.repoKey}</span>
        <Show when={typeof snapshot() === "object"}>
          {(() => {
            const s = snapshot() as GithubRepoSnapshot;
            return (
              <span class="gh-card-badges">
                <span class="gh-badge"><IconStar size={12} stroke-width={ICON_STROKE} />{s.stars}</span>
                <span class="gh-badge"><IconGitFork size={12} stroke-width={ICON_STROKE} />{s.forks}</span>
                <span class="gh-badge"><IconGitPullRequest size={12} stroke-width={ICON_STROKE} />{s.openPRs.length}</span>
                <span class="gh-badge"><IconCircleDot size={12} stroke-width={ICON_STROKE} />{s.openIssues.length}</span>
              </span>
            );
          })()}
        </Show>
        <button
          class="gh-card-refresh"
          title="Refresh"
          onClick={(e) => {
            e.stopPropagation();
            void refresh(props.repoKey);
          }}
        >
          <IconRefresh size={12} stroke-width={ICON_STROKE} />
        </button>
        <Show when={props.onRemove}>
          <button
            class="gh-card-remove"
            title="Remove from watchlist"
            onClick={(e) => {
              e.stopPropagation();
              props.onRemove?.();
            }}
          >
            ×
          </button>
        </Show>
      </div>
      <Show when={snapshot() === "loading"}>
        <div class="gh-card-status">Loading…</div>
      </Show>
      <Show when={snapshot() === "error"}>
        <div class="gh-card-status gh-card-error">
          Couldn't load this repo.
          <button onClick={() => void refresh(props.repoKey)}>Retry</button>
        </div>
      </Show>
      <Show when={expanded() && typeof snapshot() === "object"}>
        {(() => {
          const s = snapshot() as GithubRepoSnapshot;
          return (
            <div class="gh-card-body">
              <For each={s.openPRs}>
                {(pr) => (
                  <div class="gh-item" onClick={() => openLink(pr.url)}>
                    <ChecksIcon status={pr.checksStatus} />
                    <span class="gh-item-title">
                      #{pr.number} {pr.title}
                    </span>
                    <span class="gh-item-meta">{pr.author}</span>
                  </div>
                )}
              </For>
              <For each={s.openIssues}>
                {(issue) => (
                  <div class="gh-item" onClick={() => openLink(issue.url)}>
                    <IconCircleDot size={13} stroke-width={ICON_STROKE} />
                    <span class="gh-item-title">
                      #{issue.number} {issue.title}
                    </span>
                    <span class="gh-item-meta">{issue.author}</span>
                  </div>
                )}
              </For>
              <Show when={s.openPRs.length === 0 && s.openIssues.length === 0}>
                <div class="gh-card-status">Nothing open.</div>
              </Show>
            </div>
          );
        })()}
      </Show>
    </div>
  );
}

export default function GithubPanel() {
  const store = useTabStore();
  const [addValue, setAddValue] = createSignal("");

  onCleanup(startGithubPolling());

  // Re-detects the repo whenever the active pane changes (tab switch, pane
  // focus change, split) — see stores/github.ts's staleness check for why
  // this doesn't refetch on every render.
  const activePaneId = () => store.activeTab?.activePaneId;
  createEffect(() => {
    const paneId = activePaneId();
    if (!paneId) return;
    const cwd = getTerminalCwd(paneId);
    void refreshCurrentRepo(cwd);
  });

  function submitAdd(e: Event) {
    e.preventDefault();
    addToWatchlist(addValue());
    setAddValue("");
  }

  const current = () => currentRepo();
  const currentKey = () => {
    const c = current();
    return c ? `${c.owner}/${c.repo}` : null;
  };
  const currentSnapshot = () => {
    const key = currentKey();
    return key ? repoSnapshots()[key] : undefined;
  };

  return (
    <div class="github-panel" role="complementary" aria-label="GitHub">
      <div class="github-panel-header">
        <span class="github-panel-title">GitHub</span>
        <button
          class="gh-card-refresh"
          title="Refresh all"
          onClick={() => {
            const c = current();
            if (c) void refresh(`${c.owner}/${c.repo}`, c.branch);
            for (const key of watchlist()) void refresh(key);
          }}
        >
          <IconRefresh size={ICON_SIZE} stroke-width={ICON_STROKE} />
        </button>
      </div>

      <div class="github-panel-scroll">
        <Show when={ghCliStatus() === "missing"}>
          <div class="gh-empty-state">
            <p>The <code>gh</code> CLI isn't installed.</p>
            <a onClick={() => openLink("https://cli.github.com/")}>
              Install GitHub CLI →
            </a>
          </div>
        </Show>
        <Show when={ghCliStatus() === "unauthenticated"}>
          <div class="gh-empty-state">
            <p>
              <code>gh</code> is installed but not logged in. Run{" "}
              <code>gh auth login</code> in a terminal, then reopen this panel.
            </p>
          </div>
        </Show>

        {/* Independent of ghCliStatus on purpose: detecting the repo and its
            branch only needs `git` (see stores/github.ts's refreshCurrentRepo),
            not `gh` — so this must not disappear just because `gh` is missing
            or unauthenticated. Only the CI-status pill inside it needs a real
            snapshot, and its own <Show> below already guards on that. */}
        <Show when={current()}>
          {(c) => (
            <div class="github-panel-section">
              <div class="github-panel-section-title">Current repo</div>
              <div class="gh-current-repo">
                <span class="gh-current-repo-name">
                  {c().owner}/{c().repo}
                </span>
                <span class="gh-current-repo-branch">{c().branch}</span>
                <Show
                  when={
                    typeof currentSnapshot() === "object" &&
                    (currentSnapshot() as GithubRepoSnapshot).branchRun
                  }
                >
                  {(() => {
                    const run = (currentSnapshot() as GithubRepoSnapshot).branchRun!;
                    return (
                      <span
                        class="gh-ci-pill"
                        onClick={() => openLink(run.url)}
                        title={run.workflowName}
                      >
                        <ChecksIcon
                          status={
                            run.status !== "completed"
                              ? "pending"
                              : run.conclusion === "success"
                                ? "success"
                                : "failure"
                          }
                        />
                        {run.status !== "completed" ? "running" : run.conclusion}
                      </span>
                    );
                  })()}
                </Show>
              </div>
            </div>
          )}
        </Show>

        <Show when={ghCliStatus() === "ready"}>
          <div class="github-panel-section">
            <div class="github-panel-section-title">Watchlist</div>
            <form class="gh-add-form" onSubmit={submitAdd}>
              <input
                type="text"
                placeholder="owner/repo"
                value={addValue()}
                onInput={(e) => setAddValue(e.currentTarget.value)}
              />
              <button type="submit">Add</button>
            </form>
            <For each={watchlist()}>
              {(key) => (
                <RepoCard repoKey={key} onRemove={() => removeFromWatchlist(key)} />
              )}
            </For>
            <Show when={watchlist().length === 0}>
              <div class="gh-card-status">No repos pinned yet.</div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write `src/styles/github-panel.css`**

Create `src/styles/github-panel.css`:

```css
/* GitHub panel — shares the .app-body sidebar slot with the file tree and
   settings (mutually exclusive). Same width contract as .settings-sidebar:
   no floor of its own, so switching panels at a narrow width doesn't shove
   the terminal grid sideways. */
.github-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: var(--sidebar-width);
  background: var(--bg);
  border-right: 1px solid var(--border);
  color: var(--fg);
  overflow: hidden;
  flex-shrink: 0;
}

.github-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 11px 16px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.github-panel-title {
  font-weight: 600;
}

.github-panel-scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 8px 12px 16px;
}

.github-panel-section {
  margin-top: 14px;
}

.github-panel-section-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--fg-muted);
  margin-bottom: 6px;
}

.gh-empty-state {
  padding: 12px 4px;
  color: var(--fg-muted);
  font-size: 13px;
  line-height: 1.5;
}
.gh-empty-state a {
  color: var(--accent);
  cursor: pointer;
}
.gh-empty-state code {
  background: var(--bg-chrome);
  padding: 1px 4px;
  border-radius: 3px;
}

.gh-current-repo {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
}
.gh-current-repo-name {
  font-weight: 600;
}
.gh-current-repo-branch {
  color: var(--fg-muted);
  font-family: monospace;
}

.gh-ci-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  padding: 1px 6px;
  border-radius: 10px;
  background: var(--bg-chrome);
}

.gh-add-form {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
}
.gh-add-form input {
  flex: 1;
  background: var(--bg-chrome);
  border: 1px solid var(--border);
  color: var(--fg);
  border-radius: 4px;
  padding: 4px 6px;
  font-size: 12px;
}
.gh-add-form button {
  background: var(--bg-chrome);
  border: 1px solid var(--border);
  color: var(--fg);
  border-radius: 4px;
  padding: 4px 8px;
  cursor: pointer;
}

.gh-card {
  border: 1px solid var(--border);
  border-radius: 6px;
  margin-bottom: 6px;
  overflow: hidden;
}
.gh-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  cursor: pointer;
  background: var(--bg-chrome);
}
.gh-card-header:hover {
  background: var(--bg-hover);
}
.gh-card-name {
  font-weight: 600;
  font-size: 12px;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gh-card-badges {
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: var(--fg-muted);
}
.gh-badge {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.gh-card-refresh,
.gh-card-remove {
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  padding: 2px;
  line-height: 1;
}
.gh-card-refresh:hover,
.gh-card-remove:hover {
  color: var(--fg);
}
.gh-card-status {
  padding: 8px;
  font-size: 12px;
  color: var(--fg-muted);
}
.gh-card-error {
  display: flex;
  align-items: center;
  gap: 8px;
}
.gh-card-error button {
  background: var(--bg-chrome);
  border: 1px solid var(--border);
  color: var(--fg);
  border-radius: 4px;
  padding: 2px 6px;
  cursor: pointer;
}
.gh-card-body {
  border-top: 1px solid var(--border);
}
.gh-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  font-size: 12px;
  cursor: pointer;
}
.gh-item:hover {
  background: var(--bg-hover);
}
.gh-item-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gh-item-meta {
  color: var(--fg-muted);
  flex-shrink: 0;
}
.gh-check-ok { color: var(--accent); }
.gh-check-fail { color: #e5484d; }
.gh-check-pending { color: var(--fg-muted); }
```

- [ ] **Step 3: Import the stylesheet**

In `src/index.tsx`, add after `import "./styles/file-tree.css";`:

```ts
import "./styles/github-panel.css";
```

- [ ] **Step 4: Add the third toggle button to `TabBar`**

In `src/components/TabBar.tsx`, add `IconGithubPanel` to the `../lib/icons` import list (alongside `IconSettings`).

Add two props to `TabBarProps` (after `onOpenSettings: () => void;`):

```ts
  onToggleGithub: () => void;
  githubOpen: boolean;
```

Add a third button in the `.tab-actions` block, right after the settings button (`</button>` that closes the `tab-settings` button, before `</div>` that closes `.tab-actions`):

```tsx
        <button
          class="tab-icon-btn tab-github"
          classList={{ active: props.githubOpen }}
          onClick={props.onToggleGithub}
          aria-pressed={props.githubOpen}
          title={`${props.githubOpen ? "Hide" : "Open"} GitHub panel`}
        >
          <IconGithubPanel size={ICON_SIZE} stroke-width={ICON_STROKE} />
        </button>
```

- [ ] **Step 5: Wire it into `App.tsx`**

In `src/App.tsx`, add a lazy import right after `const SettingsPanel = lazy(() => import("./components/SettingsPanel"));`:

```ts
const GithubPanel = lazy(() => import("./components/GithubPanel"));
```

Add a `githubOpen`/`toggleGithub` pair right after `toggleSettings`'s definition:

```ts
  const githubOpen = () => store.state.sidebarView === "github";

  function toggleGithub() {
    store.toggleSidebarView("github");
    if (!githubOpen()) focusActivePane();
  }
```

Pass the two new props into `<TabBar ... />` (alongside `onOpenSettings={toggleSettings}` and `settingsOpen={settingsOpen()}`):

```tsx
        onToggleGithub={toggleGithub}
        githubOpen={githubOpen()}
```

Mount the panel in `.app-body`, right after the `<Show when={settingsOpen()}>...</Show>` block that wraps `SettingsPanel`:

```tsx
        <Show when={githubOpen()}>
          <Suspense>
            <GithubPanel />
          </Suspense>
        </Show>
```

- [ ] **Step 6: Manual verification**

Run: `npm run dev:electron`

1. Click the new GitHub-panel icon in the tab bar (next to the settings gear). Expected: the panel opens in the sidebar slot, the file tree/settings panel (whichever was open) closes.
2. If `gh` isn't installed on this machine: expected the "isn't installed" empty state with the install link. If installed but not logged in: expected the `gh auth login` message.
3. If `gh` is installed and authenticated: type `froquede/specterm` into the "owner/repo" field and click Add. Expected: a card appears, shows star/fork/PR/issue counts within a few seconds, and expanding it lists open PRs/issues. Click the × on the card — expected it disappears and does not reappear after closing and reopening the panel (persisted via `githubWatchlist`).
4. With a terminal pane `cd`'d into this specterm checkout (or any local GitHub-hosted repo) as the active pane: expected the "Current repo" section shows `owner/repo` and the branch name.
5. Toggle the panel closed and reopen it after more than 30 seconds: expected the current-repo and watchlist cards refresh (visible as a brief "Loading…" on each card, or just updated data).

- [ ] **Step 7: Commit**

```bash
git add src/components/GithubPanel.tsx src/styles/github-panel.css src/index.tsx src/components/TabBar.tsx src/App.tsx
git commit -m "feat: add GitHub panel to the sidebar"
```

---

### Task 8: Hermetic e2e coverage for repo detection

**Files:**
- Modify: `test/e2e.mjs`

**Interfaces:**
- Consumes: the running app's `.github-panel`/`.gh-current-repo-*` DOM (Task 7), `.tab-github` toggle button (Task 7). No `gh` CLI or network access needed — this exercises only `gitRemoteInfo` + `parseGithubRemote` end to end, via a local git repo built with the same `fs.mkdtempSync` pattern already used elsewhere in this file (see the existing `workDir` fixture near the Claude-session tests).

- [ ] **Step 1: Add the test function**

In `test/e2e.mjs`, add a new async function near the other feature-test functions (matching the file's existing `async function testXxx(win) { ... }` shape — place it after whichever such function currently sits last before the file's run-all dispatcher):

```js
// GitHub panel: current-repo detection is hermetic (git only, no `gh`/network),
// so this is the one part of the feature real CI can verify. It builds a throw-
// away repo with a fake github.com remote, cds a terminal into it, and checks
// the panel's "Current repo" line — proving detectRepo's remote-URL parsing
// (src/lib/github-remote.ts) end to end without ever calling `gh`.
async function testGithubPanelCurrentRepo(win) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "specterm-gh-"));
  execSync("git init -q", { cwd: repoDir });
  execSync("git remote add origin https://github.com/acme/widgets.git", { cwd: repoDir });
  execSync("git checkout -q -b feature/panel-test", { cwd: repoDir });
  // A repo needs a commit before `git branch --show-current` is meaningful on
  // some git versions' fresh-init state.
  fs.writeFileSync(path.join(repoDir, "README.md"), "test fixture\n");
  execSync("git add README.md && git -c user.email=t@e.st -c user.name=t commit -q -m init", {
    cwd: repoDir,
  });

  await win.keyboard.type(`cd ${repoDir}`);
  await win.keyboard.press("Enter");
  // Give the OSC7/probe cwd update (see terminal-registry.ts's scheduleCwdRefresh)
  // time to land before the panel reads it.
  await win.waitForTimeout(1800);

  await win.evaluate(() => document.querySelector(".tab-github")?.click());
  await win.waitForTimeout(500);

  const state = await win.evaluate(() => ({
    name: document.querySelector(".gh-current-repo-name")?.textContent ?? null,
    branch: document.querySelector(".gh-current-repo-branch")?.textContent ?? null,
  }));

  check(
    "GitHub panel detects the repo from the active pane's cwd",
    state.name === "acme/widgets",
    `got name="${state.name}"`
  );
  check(
    "GitHub panel shows the current branch",
    state.branch === "feature/panel-test",
    `got branch="${state.branch}"`
  );

  await win.evaluate(() => document.querySelector(".tab-github")?.click());
  fs.rmSync(repoDir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Call it from the suite's run sequence**

Find where the existing per-feature test functions are invoked in sequence (grep `test/e2e.mjs` for the block of `await testXxx(win);` calls) and add:

```js
  await testGithubPanelCurrentRepo(win);
```

in that sequence, after whichever test currently runs last before the results summary.

- [ ] **Step 3: Run the suite**

Run: `npm run test:e2e`
Expected: the new checks (`GitHub panel detects the repo from the active pane's cwd`, `GitHub panel shows the current branch`) both PASS, and no prior check regresses.

- [ ] **Step 4: Commit**

```bash
git add test/e2e.mjs
git commit -m "test: add hermetic e2e coverage for GitHub panel repo detection"
```
