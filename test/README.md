# E2E test suite

Four Playwright-driven end-to-end suites. Each builds the app, launches the
**real** Electron binary, and drives the actual UI (clicks, keyboard, settings),
asserting on observable behavior.

- **`e2e.mjs`** — one long-lived launch. Covers the file sidebar, pane splits and
  drag-and-drop, the clipboard, the settings sidebar (including rebinding a
  shortcut and then pressing the new chord to prove it took), and the tab-bar
  layout.
- **`e2e-windows.mjs`** — multi-window behaviour: tearing a tab out into a window
  of its own, dropping it onto another, and settings/theme changes propagating to
  every open window.
- **`e2e-session.mjs`** — session continuity, which needs the app closed and
  reopened repeatedly and so can't live in the suite above (it is already close to
  its time budget). Covers the two independent mechanisms: **detaching** (closing a
  window parks its shells instead of killing them; reattaching adopts the same
  PTYs) and the **on-disk snapshot** (layout, directories, names and each pane's
  serialized screen, replayed into fresh shells after a real quit), that every window
  comes back at the bounds it had, that a wedged renderer can't orphan shells, that
  Alt+F4 quits rather than detaching, and the custom title bar — which lives here
  rather than in the main suite because turning it off only takes effect on the
  *next* window.

- **`e2e-diagrams.mjs`** — mermaid blocks found in terminal output: the chip, the
  overlay, and where the diagram's text came from. Separate because it runs the
  app under a **sandboxed `HOME`** — half of what it covers is the detector
  recovering the exact source from a Claude Code transcript, and a synthetic
  transcript has no business being written into the developer's real
  `~/.claude`. The transcript it plants deliberately names a node the screen
  does not, so the check can only pass if that path actually ran; with identical
  text in both it would go green over dead code.

Two traps `e2e-session.mjs` documents in its header and exists to stay out of,
because both produce a green run that proves nothing:

- A *backgrounded* probe (`( … ) &`) outlives the shell that started it, so it
  keeps running even when detaching is completely broken. Probes run in the
  foreground.
- A renderer-side `window.close()` goes through CDP and *destroys* the window,
  skipping the `close` event the whole detach path hangs off. Closes are driven
  through `BrowserWindow.close()`, the X button's path.

- **`perf-boot.mjs`** — the startup budget, for the *instant to open* pillar. Boots
  cold (nothing stored) against boots restoring a real 8-tab session with ~2MB of
  saved screens, and fails if the delta exceeds `PERF_MAX_DELTA_MS` (default
  400ms). Measured at **+34ms** on the dev machine, and that number is load-bearing:
  it is only that small because of two deliberate choices the harness exists to
  protect. The window's saved layout is collected *synchronously* by the preload, so
  the first tab is built with nothing awaited in front of the first shell. The
  screens are read *lazily* — nothing touches the file until a pane has mounted and
  asks for its own, which is after its canvas exists.

  Both were regressions this harness caught. Fetching the layout over an async IPC
  cost ~25ms (a dynamic `import()` of the backend module, in front of the first tab —
  the exact thing `windowBoot()` in `src/backends/index.ts` documents as the one
  startup property worth protecting). Reading the screens during hydration cost
  ~100ms more, two megabytes crossing IPC on the thread trying to paint.

  It logs what each boot actually saw (`layout=…B tabs=…`) on every run, because
  its first two versions silently measured a cold boot twice — seeding the layout
  and killing the app loses Chromium's LocalStorage flush, and closing the app
  gracefully runs the exit save, which overwrites the seeded layout. The session is
  now built by the app through the UI, and only the screens file is inflated.

## Run

```bash
npm run test:e2e:all        # vite build + all three suites, in parallel
npm run test:e2e            # vite build + node test/e2e.mjs
npm run test:e2e:session    # vite build + node test/e2e-session.mjs
npm run test:e2e:windows    # vite build + node test/e2e-windows.mjs
npm run test:perf           # vite build + node test/perf-boot.mjs
```

## They don't take your keyboard

Every harness launches through `test/launch.mjs`, which sets
`SPECTERM_BACKGROUND_WINDOWS=1`. The app then shows its windows *inactive* (see
`raise()` in `electron/main.cjs`) — they appear, they render, they are driveable
and screenshottable, they just never pull focus off whatever you were doing.
Between them the suites open and close a few dozen windows over a few minutes,
and without this, running the tests is something you can only do when you have
nothing else to do.

It comes with three Chromium switches, and they are not optional. A window that
never gets focus is a window Chromium considers occluded, and it throttles
occluded renderers to about a frame a second — which turns a 150ms CSS
transition into two seconds and a green suite into a red one that says nothing
about the app. `--disable-renderer-backgrounding`,
`--disable-backgrounding-occluded-windows` and
`--disable-features=CalculateNativeWinOcclusion` switch that off.

`SPECTERM_TEST_FOREGROUND=1` gives the old behaviour back, which is what you
want when you'd rather watch a run happen than read about it afterwards.

## Runtime

The suites wait on the app, not on the clock. That is the whole story of why
they finish when they do, and it is worth stating because the obvious way to
write these — sleep two seconds after opening a tab, sleep two seconds after a
split — is what they used to do. A fixed sleep is the slowest machine the suite
might ever run on, and every machine pays it on every run; `e2e.mjs` alone spent
about three and a half minutes of a four-minute run waiting for things that had
already finished.

So each suite has an `until(what, predicate)` helper, and the waits say what
they are waiting for: the pane count to go up and every terminal to have
painted, the window to be gone, the shell's tick file to have two lines in it.
The old duration survives as the deadline, so a genuinely slow machine behaves
exactly as it did; and a wait that never comes true now fails *there*, naming
the condition, instead of sailing on to fail somewhere else as a mystery.

A few waits are still fixed, and they are the ones that are measuring time
rather than passing it: that a seconds-granularity clock format ticks, that a
minute-granularity one doesn't, that a debounced toast withholds itself and then
appears, that a shell kept running while nothing was watching it. Those aren't
slack.

`test/run-all.mjs` (`npm run test:e2e:all`) runs the three suites at once. They
are independent — each launches its own Electron on its own throwaway
`--user-data-dir`, which is what Electron's single-instance lock keys on — so
the cost is the longest suite rather than the sum of all three. Each suite's
output is buffered and printed in one block when it finishes, since three of
them narrating into the same terminal is unreadable.

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
must instead put the text on the OS clipboard. A double-click must select the
word under it — it is the same held-back press, and forwarding it as a plain
click is what used to make double-clicking select nothing.

One case turns motion reporting on (`?1003`) as well, because that is what makes
a *finished* selection fragile: xterm reports every pointer move to the program,
treats a report as user input, and clears the selection on user input — so
simply moving the mouse afterwards threw the selection away. The check selects,
moves the pointer, and requires the text to still be there.

That makes the check self-contained. One extra case runs the same drag against a
real `claude` session — the program the bug was reported against — and is
**skipped when the `claude` CLI isn't on `PATH`**, so the suite still passes on a
machine or CI box without it.
