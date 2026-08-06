# Changelog

## Unreleased

### Added
- **Specterm has an app icon.** The builds shipped with Electron's default one:
  the dock, the taskbar, the installer and the .app bundle all showed the
  Electron atom. macOS gets a proper `.icns` drawn to Apple's icon grid (the
  artwork at 824 of a 1024 canvas, so it sits at the same visual size as
  everything beside it in the dock), Linux gets the full set of sizes, and
  Windows converts from the same png. `scripts/make-icons.sh` regenerates all of
  it from `build/icon.png`.
- **Drop a pane on the tab bar to give it a tab of its own.** Anywhere on the bar
  that isn't a tab chip — past the last tab, on the `+`, on the stretch the
  window drags by — is now a drop target: the bar lights up, a ghost chip shows
  where the tab will appear, and the live terminal moves across as it does for
  every other pane drag. Getting a pane into a new tab used to mean opening an
  empty tab first and then dragging onto its chip.
- **The window you're dragging onto lights up.** Take a tab or a pane over
  another Specterm window and it shows, across its whole surface, that releasing
  will drop the tab in there. It has no way of noticing on its own — every
  pointer event during a drag belongs to the window the gesture started in — so
  the source reports where the cursor is and the app passes it on to whatever is
  underneath.
- **Merge a torn-off window back.** Dropping a window's *only* tab onto another
  Specterm window now moves it there and closes the window it left. Previously
  that was refused along with every other last-tab move, so a window could be
  created by a drag but never undone by one. Dropping the only tab on empty
  desktop is still a no-op — that move would rebuild the same window a few
  pixels over and leave an empty one behind.

### Fixed
- The taskbar flash and dock badge for waiting panes reached a window that no
  longer existed after the multi-window change, so the call failed and nothing
  flashed. The flash now goes to the window whose panes are waiting, and the
  badge shows the total across every open window rather than whichever window
  reported last.
- A tab adopted from another window went to the front without recording where
  focus came from, so the previous-tab shortcut skipped past the tab you were
  just on.

## 0.16.0 — 2026-07-29

### Added
- **Multiple windows.** `⌘N` (`Ctrl+Shift+N`) opens another Specterm window,
  with its own tabs, splits and terminals. Windows are fully independent —
  closing one kills only its own shells — while theme, terminal font and pinned
  favourites stay in step across all of them the moment you change them
  anywhere. (Font *zoom* stays per-window, like a browser's.)
- **Tear a tab or a pane out into its own window.** Drag a tab — or any pane, by
  its title bar — past the edge of the window and let go. Drop it on another
  Specterm window and it moves in there; drop it anywhere else and it becomes a
  window of its own, opening where you released it. The shell comes along
  alive: the process is handed over rather than restarted, its scrollback is
  carried across, and anything it prints mid-move is buffered and replayed in
  order, so a running build doesn't lose a line. A full-screen program (vim,
  htop, Claude Code) redraws itself in the new window the same way it does on
  any terminal resize.
- **Panes that are waiting on you say so.** When Claude Code finishes a turn or
  stops to ask permission, a dot appears on its tab and on its pane's
  title-bar, and the dock/taskbar picks it up — so a session can run in another
  tab, or behind another window, without being checked on. The dot goes out the
  moment you focus the pane or type into it. A permission prompt is drawn in the
  accent colour and pulses; a finished turn is a quiet grey dot, because a
  screen full of finished sessions shouldn't blink at you.

  Settings → *Flag panes waiting on you* picks how it's found out. **"Detect
  it"** (the default) needs no setup: a Claude session that is working is never
  silent — it repaints a spinner several times a second — so a pane that was
  producing output steadily and has gone quiet is one that stopped for you. It
  reads timing only, never the screen, so nothing about it breaks when Claude
  rewords its footer. **"Let Claude say so"** is exact: it installs a
  `Notification` and a `Stop` hook into `~/.claude/settings.json`, each writing
  one escape sequence to the pane it runs in, which arrives instantly and can
  tell a permission prompt apart from a finished turn. The hooks touch nothing
  else in that file and can be removed from the same button; they need
  `/dev/tty`, so that mode is macOS/Linux only. **"Off"** watches nothing.

  A terminal bell flags a pane in either mode — it's what a program of any kind
  uses to ask to be looked at, so a `make` that ends with `\a` gets the same dot.

### Changed
- **A shell's output no longer round-trips through an array of numbers.** Every
  byte a terminal printed used to be boxed into a JS number, put in a plain
  array, and serialized element by element on its way to the renderer. It now
  crosses as bytes. This is the hottest path in the app — everything any shell
  prints goes through it — and it was the ceiling on how fast a pane could
  render a large `cat`, a verbose build, or a `git log`.
- **Session restore and the reopen-closed stack know about windows.** The saved
  session belongs to the window that restored it: it is the only one that writes
  it back, so a second window can't overwrite the snapshot with its own tabs, and
  opening one with `⌘N` gives you a plain terminal rather than a duplicate of
  everything already open. The closed-tab stack, by contrast, is deliberately
  shared — "reopen what I closed last" means the last thing closed anywhere —
  and is now read back from storage on every push and pop, so two windows can't
  drop each other's entries.

### Fixed
- **Windows: new panes and tabs inherit the directory again.** Windows has no
  `/proc` to read a shell's working directory from, so PowerShell is now asked to
  report it: both `pwsh` and the legacy `powershell.exe` get a prompt hook that
  emits `OSC 7`, the same sequence zsh and fish send by default and the renderer
  already understood. The `file:///C:/…` form it produces is normalized back to a
  real Windows path.
- **Terminal scroll position survives a tab switch.** Switching tabs moves the
  terminal element into a new container, which resets the DOM scrollbar to the
  top while xterm's own scroll position stays where it was — leaving the bar
  pinned at the top over correctly-rendered bottom content, and snapping to the
  top on the next scroll. The two are re-synced after the re-attach.

## 0.15.0 — 2026-07-27

### Added
- **Reopen what you closed.** **⌘⇧T** (`Ctrl+Shift+R` on Linux/Windows) brings
  back the last closed tab — or the last closed pane, whichever went more
  recently — and keeps walking back through the close order on repeated presses,
  25 deep and across restarts. A tab returns to the position it held; a pane
  returns to the tab it came from, or becomes a tab of its own if that tab is
  gone too. Panes come back with their layout, titles and working directories;
  the shells are new, since nothing that was running is restarted.
- **Reopen tabs on start.** The tabs, splits and directories you had open come
  back on the next launch (Settings → *Reopen tabs on start*, on by default). A
  renderer reload deliberately doesn't restore: the previous shells are still
  alive in that case, and restoring would spawn a second set beside them.
- **Restored panes remember Claude Code sessions.** A pane running Claude Code
  has its session identified while it runs, so the restored terminal comes back
  with `claude --resume <id>` ready at the prompt. Settings → *Resumable
  sessions* chooses between typing it (the default — a remembered session id may
  since have been deleted, so the command is left for you to confirm), running
  it, or ignoring it. The mechanism is generic: the history stores a provider,
  an id and a resume command, and Claude Code is simply the first provider.
  Detection is exact when Claude has a child process to read the session from,
  and falls back to the most recently active transcript for the pane's
  directory; Windows can't report a pane's processes at all, so panes there
  restore as plain shells.
- **An optional clock in the tab bar.** Off by default. The format is a token
  string rather than a locale preset — `HH:mm`, `ddd DD/MM HH:mm`, `h:mm a`,
  with `[bracketed]` literals — and Settings previews it as you type. It sits at
  the far end from the tabs, so it doesn't move as tabs open and close.

  It wakes only when the text it shows would change: once a minute for a format
  without seconds, aligned to the minute boundary rather than drifting off it,
  and once a second only if seconds are actually displayed. While the window is
  hidden it doesn't tick at all, resyncing when it comes back. Switched off,
  the component isn't mounted, so there is no timer at all.

### Changed
- **Renaming a tab is now `F2` on Linux/Windows** (macOS keeps `⌘R`), freeing
  `Ctrl+Shift+R` for reopen. `Ctrl+Shift+T` stays *new tab*, as in every other
  terminal — and bare `Ctrl+T` stays out of reach on purpose, since it's
  readline's transpose-chars. `F2` steps aside whenever a full-screen program
  owns the pane (it's on the alternate screen buffer), so it still reaches
  htop's Setup and mc's menu; it renames only at a shell prompt.

### Performance
The session history is built to cost nothing when it isn't doing anything:
- A pane's pty output path is untouched unless that specific pane owes a resume
  command. Output is the hottest path in the app — every echoed keystroke, every
  line of a build log — and a restore can only ever happen once, so it has no
  business being checked there for the life of the process.
- The "what was open" snapshot is serialized behind a debounce (a divider drag
  writes the store on every mousemove) and skipped entirely when the result is
  byte-identical to what's already stored, since `localStorage.setItem` is
  synchronous on the same thread that draws the terminal. With *Reopen tabs on
  start* off, no snapshot is ever built.
- Session detection walks the kernel's per-process child lists down from each
  shell rather than enumerating every process on the machine. The scan runs in
  the main process, which is also where the ptys live, and flooding libuv's
  (four-thread) pool there stalls terminal I/O app-wide. It also skips ticks
  while the window is hidden, and doesn't run at all with *Resumable sessions*
  set to "Ignore them".

## 0.14.0 — 2026-07-24

### Added
- **Splits and new tabs open where you already are.** A new pane inherits the
  working directory of the pane it was split from, instead of dropping you back
  at the configured startup path. The directory is read from the shell's own
  process (`/proc` on Linux, `lsof` on macOS), so it works without configuring
  your shell; when the shell sends `OSC 7` — zsh and fish do by default, and most
  prompt frameworks add it — that report is preferred, since it arrives the
  moment the directory changes and costs nothing. A report naming another host
  (an ssh session) is dropped rather than pointing a local pane at a path that
  only exists on the remote machine. Windows can't report a shell's live
  directory without a native call into the process, so inheritance there still
  falls back to the startup path.
- **Select & copy the input composer.** **⌘⇧A** (Ctrl+Shift+A on Linux/Windows)
  highlights just the Claude Code prompt box the cursor is in and copies the
  typed text, instead of a plain select-all grabbing the whole scrollback. At a
  bare shell prompt it falls back to the cursor's logical line. Bare `Ctrl+A`
  stays free for readline's "beginning of line", and `⌘A` for the markdown
  editor's own select-all.

### Fixed
- **Closing a pane or tab returns focus to where you came from.** Closing the
  active pane handed focus to the first leaf of the split tree, so splitting off
  a pane and closing it dropped you on the top-left pane rather than the one you
  were working in; closing a tab had the same shape one level up, picking the
  replacement by index. Both now keep a most-recently-used focus history and hand
  focus to the most recent survivor, falling back to the old position rule only
  when nothing was focused before.
- **`cd fav-N` on Windows lands in the favorite path again.** The expansion
  injects a PowerShell one-liner into the input line in a single burst, and
  ConPTY/PSReadLine strips the lone backslashes out of it — `C:\Users\x` reached
  `Set-Location` as `C:Usersx`, so the jump silently failed. The path is now
  emitted forward-slashed, which PowerShell accepts as a separator and which
  survives injection intact. Linux and macOS were never affected.
- **Same-origin reloads stay in the window.** `will-navigate` compared full URLs,
  so any same-origin navigation (a trailing slash, a hash change, the dev
  server's reload) counted as an external link and fired `openExternal` — which
  in development looped the default browser and stalled the renderer. It now
  compares origins, and only a genuinely different http(s) origin goes out.

## 0.13.0 — 2026-07-22

### Added
- **In-app updates.** A new **Updates** section at the bottom of Settings runs
  the whole cycle from one button: *Check for updates* → *New vX available* →
  a 0–100% download bar → *Restart Specterm?*. Specterm checks GitHub once on
  each cold start; every step after that is user-initiated — nothing downloads
  or installs behind your back. On Windows and Linux the install rides on
  electron-updater; on macOS, where the builds are unsigned, Specterm downloads
  the release itself, verifies it against the published sha512, and swaps the
  app in place only after the replacement is confirmed — so a failed or
  interrupted update can never leave you without a working app.

## 0.12.1 — 2026-07-17

### Fixed
- **Renaming and closing a tab work again.** The v0.12.0 drag-to-reorder
  captured the pointer on `pointerdown`, which made the browser retarget the
  follow-up `click`/`dblclick` to the tab itself — so the **×** button only
  re-selected the tab instead of closing it, and **double-clicking** a tab never
  opened the rename editor. Reorder now tracks the drag with window listeners
  and no pointer capture, leaving a plain click or double-click untouched.
- **End-to-end coverage for the tab bar.** New tests drive rename (double-click
  and the ⌘R / Ctrl+Shift+R shortcut, plus Enter-commit and Escape-cancel),
  closing via the × button, and drag-to-reorder — so this regression can't
  return silently.

## 0.12.0 — 2026-07-17

### Added
- **Window opacity.** A Settings slider makes the whole window translucent so
  the desktop shows through the terminal. Default 100% (opaque), floored at 30%
  so the window can never become invisible. Native on Windows/macOS; on Linux/X11
  it sets `_NET_WM_WINDOW_OPACITY` (via `xprop`) for a compositing WM to render,
  and no-ops cleanly where that isn't available.
- **Text & code viewer.** Any non-markdown file opens from the sidebar in a
  read-only, syntax-highlighted view with line numbers and find. Binaries are
  declined and oversized files capped, and the highlighter (highlight.js) is
  lazy-loaded — the terminal never pays for it until a file is opened.
- **Markdown editor.** Toggle the markdown pane (**Cmd+E**) between the rendered
  preview and a live-preview CodeMirror editor; **Cmd+S** saves back to disk,
  with a dirty indicator in between. CodeMirror is lazy-loaded on the first edit,
  so it stays out of the startup bundle. Unsaved edits auto-persist as a local
  draft, so they survive a tab move, a reload, or closing the app — and are never
  auto-written to the file itself.
- **Move a pane between tabs.** Drag a pane's title-bar onto another tab's chip
  to detach it into that tab — the live terminal (PTY and scrollback) rides
  along. The target chip highlights while the pane hovers it.
- **Open `.md` files from the OS.** Installed builds register as a Markdown
  handler, so *Open With → Specterm* (or double-click) opens a markdown file in a
  new tab. A single-instance lock forwards a second launch's file to the running
  window instead of opening a duplicate.
- **Inline tab rename and drag-to-reorder.** Double-click a tab to rename it in
  place (tmux-style: the name then sticks against shell-driven title updates
  until cleared), and drag tabs along the bar to reorder them.
- **Sidebar right-click menu.** The file tree gains a context menu, including
  **Reveal in Finder / Explorer / file manager** to jump from a path straight to
  the native OS file browser, and "open a terminal here".
- **Spatial pane focus.** **Alt+Arrow** moves focus to the pane visually adjacent
  in that direction (all four directions), rather than by tree order.

## 0.11.1 — 2026-07-15

### Fixed
- **The Linux `.deb` no longer aborts at launch on Ubuntu 23.10+/24.04** with
  "The SUID sandbox helper binary was found, but is not configured correctly".
  electron-builder's default postinst decides whether to give `chrome-sandbox`
  the setuid-root bit by probing user namespaces — but that probe runs as root
  at install time, and root can create user namespaces even where the kernel's
  AppArmor policy (`kernel.apparmor_restrict_unprivileged_userns=1`, default-on
  since 24.04) blocks them for the unprivileged user who actually runs the app.
  It therefore shipped `chrome-sandbox` non-setuid and the app crashed. The
  `.deb` now sets it setuid-root unconditionally — the universal fallback that
  works with or without user namespaces, exactly as Google Chrome's own `.deb`
  does — so the sandbox stays on.
- **The Linux AppImage no longer aborts on those same kernels.** An AppImage
  mounts its payload `nosuid`, so a setuid `chrome-sandbox` is impossible there;
  it depends entirely on user namespaces. When those are blocked, the AppImage
  now drops the renderer sandbox at startup so the terminal still launches,
  keeping it on everywhere the sandbox can actually work.

## 0.11.0 — 2026-07-13

### Added
- Settings moved from a modal into a sidebar, sharing its slot with the file
  tree (opening one evicts the other). Changes persist as you make them — there
  is no Save button; a toast confirms once your edits settle. Reach it with the
  gear or **Cmd+,** / **Ctrl+Shift+,**.
- The tab bar can sit in any of the window's four corners. Which edge it sits on
  (top/bottom) and which side its tabs and icons hug (left/right) are independent
  choices, picked from a 2x2 grid of miniatures in the new **Layout** settings
  group.
- Tab bar height (24–56px) and sidebar width (200–640px) are configurable. The
  sidebar is also resizable by dragging the strip between it and the panes;
  double-click to reset. Sidebar width now survives a restart (it never used to).
- The tab bar can auto-hide: the panes take the whole window and the bar slides
  off its edge, leaving a peek strip that brings it back when you reach for it.

### Changed
- The file sidebar's breadcrumb path now sits directly on top of the listing it
  labels, below the filter. The favourites strip takes the top of the sidebar,
  where jump targets belong.
- Base16 themes get their dividers back: `border` now derives from base02 rather
  than base01, which was indistinguishable from the chrome it was drawn against.

### Fixed
- **You can now copy from a pane running Claude Code** — or vim, htop, lazygit.
  Those programs turn on mouse tracking, and at that point xterm hands every
  button press to the program and switches its own selection off: the drag
  belongs to the app, so it never became a selection and there was nothing for
  the copy shortcut to read. Specterm now tells the two intents apart — a click
  still reaches the program (Claude keeps its clickable UI, hover and scroll),
  while a drag past 3px becomes a local selection you can copy. Holding Shift
  (xterm's own escape hatch) still works.
- Esc now closes the settings sidebar even while the terminal holds keyboard
  focus, which it usually does.
- The settings panel no longer probes every installed monospace font and builds
  the 325-scheme theme gallery on every app boot — it's mounted only while open.

## 0.10.0 — 2026-07-06

### Added
- Snapped divider resize — dragging a split handle now moves the whole
  continuous divider line it belongs to, so aligned dividers across stacked
  splits resize together (a full column widens, or a full row grows taller)
  instead of only the single pane boundary under the cursor. Works on both axes
  (side-by-side and stacked dividers). Hold **Alt** while dragging to fall back
  to the previous behaviour and resize just that one split independently.
- End-to-end coverage for both modes on both axes: a plain drag moving every
  aligned divider together, and an Alt-drag moving only the grabbed one.

### Changed
- Unified UI fade timing to `0.2s ease` across panes, tabs, split handles, and
  controls — including the opacity fade as focus moves between panels. The
  pane-focus fades run faster (`0.1s`) since switching panes is a constant
  action. (The drag-follow drop preview stays snappy at `0.08s`.)

### Fixed
- Copy/paste is now reliable. Copy (and paste) went through `navigator.clipboard`
  in the renderer, which Electron rejects when the window isn't focused and gates
  behind permissions — so copies silently failed to reach the OS clipboard (text
  pasted only inside the app, or not at all, including between panes). Clipboard
  text now goes through the Electron main process, which always hits the real OS
  clipboard. Native text fields (sidebar/settings) are unaffected — the app still
  yields to native editing there.
- Panes no longer stay blank after a WebGL context loss. Chromium force-kills the
  oldest of its ~16 WebGL contexts under memory pressure (typically the first
  pane, and often noticed after a relayout like toggling the sidebar or resizing
  panes); the terminal was then left with no renderer and sat blank until an
  unrelated redraw. It now re-establishes its renderer on the next frame. Both
  fixes ship with end-to-end regression coverage.

## 0.9.0 — 2026-07-04

### Added
- Windows partition navigation — the file sidebar can now cross into any drive.
  Going up past a drive root opens a "This PC" view listing every mounted volume
  (C:, D:, …); previously the tree was stuck on the drive the app runs from.
- Configurable default terminal path (Settings) — new terminals and the sidebar
  open here; blank uses the home directory. The sidebar reopens at the
  last-browsed folder, falling back to the configured path, then home.
- "Open terminal here" sidebar control — cd the active terminal into the folder
  currently browsed in the tree.
- Clickable breadcrumb path, Backspace / ← to go up a level, a graceful "can't
  read this folder" state, and Windows-aware `~` / backslash path display.
- Cross-platform end-to-end test suite (`npm run test:e2e`) that drives the real
  app against a throwaway profile.

### Fixed
- File-tree `cd` (favorites, the new "open terminal here", and `cd fav-N`) did
  nothing on Windows PowerShell: the command was submitted with `\n` and quoted
  for POSIX shells. It's now submitted with a carriage return and quoted/escaped
  per host shell (PowerShell `Set-Location` / `Test-Path`).
- `cd fav-N` expansion clears the typed line with backspaces instead of Ctrl-U
  (`\x15`), which PowerShell's PSReadLine ignores — so it works on Windows too.

## 0.8.2 — 2026-07-03

### Added
- `cd fav-N` expansion — typing `cd fav-1` (or any favorite index) at the shell
  prompt now expands to a real `cd` into the path pinned at that 1-based
  favorite, mirroring the sidebar-search `fav-N` token. A real directory named
  `fav-N` in the current folder wins: the shell tries it first
  (`cd fav-N 2>/dev/null || cd '<favpath>'`) and only falls back to the favorite
  path when that fails. Only plain-typed lines expand — arrows, history recall
  and tab-completion leave the line untouched

## 0.8.1 — 2026-07-02

### Fixed
- Splitting a pane, opening a tab, toggling the sidebar and refitting terminals
  on window resize all stopped working after the first pane teardown. The pane
  component's cleanup read `props.id`, a reactive getter that dereferences the
  backing split-tree leaf — already `null` once the pane is unmounting (e.g. a
  split replaces the leaf with a split subtree). The resulting
  `Cannot read properties of null (reading 'id')` threw inside Solid's disposal
  and poisoned the whole reactive render, freezing every subsequent update. The
  id is now captured once at mount, since a pane's id never changes for its
  lifetime

## 0.7.0 — 2026-06-30

### Added
- Color themes — pick from five built-ins (Tokyo Night, Catppuccin Mocha,
  Gruvbox Dark, Nord, Catppuccin Latte) in the Settings panel. The choice is
  persisted and recolors both the terminal and the whole app at once
- Theme gallery — browse and apply 325 bundled base16 schemes from Settings,
  with a name filter and color swatches. Bundled offline (no network needed);
  refresh with `node scripts/fetch-base16-schemes.mjs`
- base16 theme import — three ways to add your own: paste a scheme (YAML/JSON),
  open a `.yaml`/`.json` file, or drag a scheme file onto the window. Imported
  themes can be removed
- Light-theme support — the chrome now adapts to light palettes (Catppuccin
  Latte ships as the first light built-in)

### Changed
- The Tokyo Night palette is no longer hardcoded: the app chrome is driven by
  CSS variables on `:root` and the terminal palette comes from a single theme
  model (`src/lib/theme.ts`), so a theme change updates every surface in sync

## 0.6.1 — 2026-06-29

### Added
- Settings panel (⚙ icon, `⌘,` shortcut) with a customizable, persisted
  unfocused-pane opacity

### Fixed
- Fullscreen works again on Electron (it was calling the Tauri window API, which
  doesn't exist in the main build) — window controls now go through the backend
- Settings slider: dragging the handle is no longer cancelled on every move
  (rewriting `value` during the `input` event was killing the drag in Chromium)

### Changed
- Active pane has no border anymore — focus is signaled solely by dimming the
  others (Ghostty-style)

## 0.3.0 — 2026-06-26

### Added
- Drag-and-drop to reorder panes + a button to toggle the split orientation
- Per-pane title bars
- Windows support (native shell resolution in the Tauri backend)
- File tree with search, keyboard navigation and autocomplete
- macOS install scripts (`install:mac`)

### Fixed
- Terminals turning into a white screen when exceeding the WebGL context limit
  (they now fall back to the DOM renderer instead of freezing)
- Focus moves to the newly created pane on split
- Pane title (e.g. Claude's `/rename`) preserved across remounts
- Duplicate `mac` key in `package.json`

### Changed
- Unified `⌘B`: opens the sidebar + focuses search, or closes it
- Local shortcuts preserved; upstream split shortcuts (`⌘⇧S`, `⌘⇧↵`) not
  adopted (see `docs/decisao-atalhos.md`)
