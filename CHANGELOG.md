# Changelog

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
