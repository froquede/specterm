# E2E test suite

`e2e.mjs` is a Playwright-driven end-to-end suite. It builds the app, launches
the **real** Electron binary, and drives the actual UI (clicks, keyboard,
settings), asserting on observable behavior. It covers the file sidebar, pane
splits and drag-and-drop, the clipboard, the settings sidebar, and the tab-bar
layout.

## Run

```bash
npm run test:e2e        # vite build + node test/e2e.mjs
```

Exit code `0` = all checks passed, `1` = a check failed, `2` = hard timeout,
`3` = harness error. A summary line reports `N passed, N failed, N skipped` and
the platform. Screenshots (`shot-drives.png`, `shot-final.png`) are written
alongside for eyeballing.

## Cross-platform

The suite runs on **Windows, macOS, and Linux** — it branches on
`process.platform`:

| Concern            | Windows                          | macOS / Linux                    |
| ------------------ | -------------------------------- | -------------------------------- |
| Above the root     | `This PC` drive list (C:, D:, …) | walk up to `/`, can't go higher  |
| Shell              | PowerShell (`Set-Location`)      | `$SHELL` (`cd`)                   |
| Startup-path probe | `C:\Windows`                     | `/usr`                           |
| Home breadcrumb    | `This PC` + `~`                  | `~`                              |

Shared checks (home start, breadcrumb, `..`, enter-subdir, cd control, keyboard
up-nav, startup-path persistence + spawn) run identically on all three.

## How terminal cwd is verified

xterm renders to a WebGL canvas, so there's no scrapeable DOM text. Instead the
suite has the shell write its own working directory to a temp file
(`pwd` / `(Get-Location).Path`) and reads it back from Node — renderer- and
shell-agnostic ground truth. New tabs spawn their pty lazily, so the
startup-path check reloads the window and reads the boot terminal (a single,
deterministic terminal) rather than racing a freshly-created tab.

## How mouse capture is verified

A program that turns on mouse tracking (Claude Code, vim, htop) takes the drag
away from the terminal, and xterm switches its own selection off — which is why
a plain drag over such a pane used to select nothing. The suite proves both
halves of the fix against the program's own stdin rather than guessing from the
UI: it runs a recorder in the pane that enables mouse tracking and writes back
whatever the terminal sends it (`stty raw; cat > file`). A click must arrive as
exactly one SGR press/release pair; a drag must arrive as nothing at all, and
must instead put the text on the OS clipboard.

That makes the check self-contained. One extra case runs the same drag against a
real `claude` session — the program the bug was reported against — and is
**skipped when the `claude` CLI isn't on `PATH`**, so the suite still passes on a
machine or CI box without it.
