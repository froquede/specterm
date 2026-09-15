import { createEffect, createMemo, createSignal, For, Show, onCleanup } from "solid-js";
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
  IconFilePlus,
  IconFilePen,
  IconFileMinus,
} from "../lib/icons-lazy";
import { getBackend } from "../backends";
import type { GithubRepoSnapshot } from "../backends/types";
import { useTabStore } from "../stores/tabs";
import { useTerminalCwd } from "../lib/terminal-registry";
import "../styles/github-panel.css";
import { join, normalize, basename } from "../lib/fspath";
import {
  classifyGitStatus,
  type GitStatusCategory,
  type GitStatusFile,
} from "../lib/git-status";
import {
  ghCliStatus,
  currentRepo,
  currentWorkingTreeStatus,
  repoSnapshots,
  watchlist,
  refresh,
  refreshAll,
  refreshCurrentRepo,
  addToWatchlist,
  removeFromWatchlist,
  startGithubPolling,
} from "../stores/github";

interface GithubPanelProps {
  // Always opens as a new tab — see App.tsx's wiring to handleOpenFile.
  onOpenFile: (path: string) => void;
}

const STATUS_GROUPS: { category: GitStatusCategory; title: string }[] = [
  { category: "modified", title: "Modified" },
  { category: "new", title: "New" },
  { category: "deleted", title: "Deleted" },
];

function StatusIcon(props: { category: GitStatusCategory }) {
  return (
    <>
      <Show when={props.category === "modified"}>
        <IconFilePen size={13} stroke-width={ICON_STROKE} class="gh-status-icon-modified" />
      </Show>
      <Show when={props.category === "new"}>
        <IconFilePlus size={13} stroke-width={ICON_STROKE} class="gh-status-icon-new" />
      </Show>
      <Show when={props.category === "deleted"}>
        <IconFileMinus size={13} stroke-width={ICON_STROKE} class="gh-status-icon-deleted" />
      </Show>
    </>
  );
}

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
            void refresh(props.repoKey, undefined, { force: true });
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
          <button onClick={() => void refresh(props.repoKey, undefined, { force: true })}>Retry</button>
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

export default function GithubPanel(props: GithubPanelProps) {
  const store = useTabStore();
  const [addValue, setAddValue] = createSignal("");
  const [statusExpanded, setStatusExpanded] = createSignal(false);

  function openStatusFile(file: GitStatusFile) {
    const root = current()?.root;
    if (!root) return;
    props.onOpenFile(normalize(join(root, file.path)));
  }

  onCleanup(startGithubPolling());

  // Re-detects the repo whenever the active pane changes (tab switch, pane
  // focus change, split) or its shell changes directory — useTerminalCwd is
  // the reactive read, so a `cd` into another repo is picked up without
  // switching panes. See stores/github.ts's staleness check for why this
  // doesn't refetch `gh` on every one.
  // The memo matters: the cwd epoch bumps when *any* pane changes directory,
  // and only a change to the active pane's should spawn `git` again.
  const activePaneCwd = createMemo(() => {
    const paneId = store.activeTab?.activePaneId;
    return paneId ? useTerminalCwd(paneId) : null;
  });
  createEffect(() => {
    const cwd = activePaneCwd();
    if (cwd === null) return;
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
          onClick={() => void refreshAll({ force: true })}
        >
          <IconRefresh size={ICON_SIZE} stroke-width={ICON_STROKE} />
        </button>
      </div>

      <div class="github-panel-scroll">
        <Show when={ghCliStatus() === "checking"}>
          <div class="gh-empty-state">
            <p>Checking for the <code>gh</code> CLI…</p>
          </div>
        </Show>
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
              {/* Local `git status` — same cwd as the section above, no `gh`
                  involved, refreshed on the exact same cadence as the repo
                  detection itself (see refreshCurrentRepo). */}
              <Show when={currentWorkingTreeStatus()}>
                {(files) => (
                  <div class="gh-status-summary">
                    <div
                      class="gh-status-toggle"
                      onClick={() => setStatusExpanded((v) => !v)}
                    >
                      {files().length === 0
                        ? "Working tree clean"
                        : `${files().length} changed`}
                    </div>
                    <Show when={statusExpanded() && files().length > 0}>
                      <div class="gh-status-files">
                        <For each={STATUS_GROUPS}>
                          {(group) => {
                            const groupFiles = () =>
                              files().filter(
                                (f) => classifyGitStatus(f.status) === group.category
                              );
                            return (
                              <Show when={groupFiles().length > 0}>
                                <div class="gh-status-group-title">{group.title}</div>
                                <For each={groupFiles()}>
                                  {(f) => (
                                    <div
                                      class="gh-status-file"
                                      title={f.path}
                                      onClick={() => openStatusFile(f)}
                                    >
                                      <StatusIcon category={group.category} />
                                      <span class="gh-status-path">{basename(f.path)}</span>
                                    </div>
                                  )}
                                </For>
                              </Show>
                            );
                          }}
                        </For>
                      </div>
                    </Show>
                  </div>
                )}
              </Show>
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
