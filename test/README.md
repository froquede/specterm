# E2E test suite

`e2e.mjs` is a Playwright-driven end-to-end suite for the FileTree sidebar. It
builds the app, launches the **real** Electron binary, and drives the actual UI
(clicks, keyboard, settings), asserting on observable behavior.

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
