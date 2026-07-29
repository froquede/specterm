# E2E test suite

Two Playwright-driven end-to-end suites. Both build the app, launch the **real**
Electron binary, and drive the actual UI (clicks, keyboard, settings), asserting
on observable behavior.

- **`e2e.mjs`** — one long-lived launch. Covers the file sidebar, pane splits and
  drag-and-drop, the clipboard, the settings sidebar, and the tab-bar layout.
- **`e2e-session.mjs`** — session continuity, which needs the app closed and
  reopened repeatedly and so can't live in the suite above (it is already close to
  its time budget). Covers the two independent mechanisms: **detaching** (closing a
  window parks its shells instead of killing them; reattaching adopts the same
  PTYs) and the **on-disk snapshot** (layout, directories, names and each pane's
  serialized screen, replayed into fresh shells after a real quit).

Two traps `e2e-session.mjs` documents in its header and exists to stay out of,
because both produce a green run that proves nothing:

- A *backgrounded* probe (`( … ) &`) outlives the shell that started it, so it
  keeps running even when detaching is completely broken. Probes run in the
  foreground.
- A renderer-side `window.close()` goes through CDP and *destroys* the window,
  skipping the `close` event the whole detach path hangs off. Closes are driven
  through `BrowserWindow.close()`, the X button's path.

## Run

```bash
npm run test:e2e            # vite build + node test/e2e.mjs
npm run test:e2e:session    # vite build + node test/e2e-session.mjs
```

Exit code `0` = all checks passed, `1` = a check failed, `2` = hard timeout,
`3` = harness error. A summary line reports `N passed, N failed, N skipped` and
the platform. Screenshots (`shot-drives.png`, `shot-final.png`,
`shot-restored.png`) are written alongside for eyeballing.

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
