# Specterm

A GPU-accelerated terminal emulator with split panes, tabs, markdown preview, and a file tree sidebar. Built with SolidJS and xterm.js on Electron.

## Features

- **Split panes** -- horizontal and vertical splits with draggable resize handles, drag-and-drop reordering via each pane's title-bar, and one-click/keyboard direction flipping. Aligned dividers move together; hold **Alt** to resize just one split
- **Tabs** -- create, close, and cycle through terminal tabs; drag a pane's title-bar onto another tab to move it there (the live terminal rides along)
- **Copy from full-screen programs** -- selecting text works even in a pane running Claude Code, vim or htop, which normally take the mouse away from the terminal (see [Selection and the mouse](#selection-and-the-mouse))
- **File sidebar** -- browse and `cd` from a filterable tree, pin favourites, and jump to them with `fav-1`, `fav-2`… from the filter box or straight from the shell prompt
- **Markdown preview & editor** -- render `.md` files inline with Mermaid diagram support, or toggle (`⌘E`) into a live-preview CodeMirror editor and save (`⌘S`) back to disk; installed builds also register as a `.md` handler, so you can *Open With → Specterm* (or double-click) a markdown file to open it in a new tab
- **Text & code viewer** -- open any other text file from the sidebar in a read-only, syntax-highlighted view with line numbers and find; binaries are declined and huge files are capped, so it never stalls the terminal
- **Themes** -- five built-ins plus a 325-scheme base16 gallery (and paste/file/drag import); recolors the terminal and the whole app at once
- **Configurable chrome** -- put the tab bar in any of the window's four corners, size it and the sidebar, or auto-hide the bar so the panes take the whole window
- **Find in terminal** -- search the scrollback of the active pane
- **WebGL rendering** -- GPU-accelerated terminal via xterm.js WebGL addon, with automatic recovery from a lost context
- **Splits inherit the directory** -- a new pane or tab opens where the pane you split from is, not back at the startup path. The shell's directory is read from its own process, so it works without configuring your shell; `OSC 7` (which zsh and fish send by default) is used as a faster signal when it's there
- **OSC protocol** -- captures title sequences and working directory updates
- **Session history** -- reopen the last closed tab or pane (`⌘⇧T` / `Ctrl+Shift+R`), repeatedly, walking back through what you closed; and pick your tabs, splits and directories back up where you left them after a restart. A pane that was running Claude Code remembers *which session*, so the restored terminal comes back with `claude --resume <id>` waiting at the prompt (or runs it, or ignores it -- your choice in Settings)
- **Optional tab-bar clock** -- off by default; when on, its format is a token string (`HH:mm`, `ddd DD/MM HH:mm`, `h:mm a`, `[at] HH:mm`) with a live preview in Settings. It wakes only when the displayed text would actually change -- once a minute unless the format shows seconds -- aligned to the boundary, and stops entirely while the window is hidden
- **Per-OS keybindings** -- macOS uses `⌘`; Linux/Windows keep the Kitty-style `Ctrl+Shift+<key>` scheme

## Keybindings

macOS uses the `⌘` command key. Linux and Windows use the Kitty-style
`Ctrl+Shift+<key>` scheme (there is no `⌘`, and this keeps bare `Ctrl+<key>`
free for terminal control codes).

| Action | macOS | Linux / Windows |
|---|---|---|
| New tab | `⌘T` | `Ctrl+Shift+T` |
| Reopen last closed tab / pane | `⌘⇧T` | `Ctrl+Shift+R` |
| Rename tab | `⌘R` | `F2` |
| Close tab | `⌘⇧W` | `Ctrl+Shift+Q` |
| Close pane | `⌘W` | `Ctrl+Shift+W` |
| Next / previous tab | `⌘⇧]` / `⌘⇧[` | `Ctrl+Shift+→` / `Ctrl+Shift+←` |
| Split — new pane stacked (below) | `⌘D` | `Ctrl+Shift+S` |
| Split — new pane side by side | `⌘⇧D` | `Ctrl+Shift+Enter` |
| Focus next / previous pane | `⌘⌥→` / `⌘⌥←` | `Ctrl+Shift+Alt+→` / `Ctrl+Shift+Alt+←` |
| Copy selection | `⌘C` | `Ctrl+Shift+C` |
| Paste — image inline when the clipboard holds only an image, else text | `⌘⇧V` | `Ctrl+Shift+V` |
| Paste as plain text | `⌘V` | `Ctrl+V` (xterm's own) |
| Paste an image inline into Claude Code | `⌃V` (Claude's own) | `Alt+V` |
| Find in terminal | `⌘F` | `Ctrl+Shift+F` |
| Toggle sidebar / search | `⌘B` | `Ctrl+Shift+B` |
| Toggle settings | `⌘,` | `Ctrl+Shift+,` |
| Increase / decrease font size | `⌘=` / `⌘-` | `Ctrl+Shift+=` / `Ctrl+Shift+-` |
| Reset font size | `⌘0` | `Ctrl+Shift+0` |

The markdown preview and the text/code viewer each have their own find box, on
the same `⌘F` / `Ctrl+Shift+F`, when that pane is focused. Fullscreen is the `⊞`
icon in the tab bar.

## Selection and the mouse

Full-screen programs — Claude Code, vim, htop, lazygit — turn on **mouse
tracking**, and at that point a terminal hands every button press to the program
and switches its own selection off: the drag belongs to the app. That's why you
normally can't select (and so can't copy) anything out of such a pane, and why
every terminal's answer is *"hold Shift"*.

Specterm tells the two intents apart instead:

| gesture | what happens |
|---|---|
| **click** | goes to the program — Claude keeps its clickable UI, hover highlighting and scroll |
| **drag** (past 3px) | becomes a local selection, and the program is told nothing |
| **Shift+drag** | xterm's own escape hatch — still works |
| **Alt+drag** | column (rectangular) selection |

Panes with no mouse tracking behave exactly as before. See
`src/lib/mouse-selection.ts`.

## Settings

Open with `⌘,` / `Ctrl+Shift+,`, or the ⚙ icon. Settings live in the sidebar and
share its slot with the file tree — opening one closes the other. There is no
**Save** button: changes persist as you make them, and a toast confirms once your
edits settle.

- **Theme** — see [Theming](#theming) below.
- **Terminal font** — any monospace family installed on the system.
- **Default terminal path** — where new terminals open and the file sidebar
  starts. Blank uses your home directory.
- **Unfocused pane opacity** — how far inactive split panes are washed out.
- **Window opacity** — whole-window transparency, so the desktop shows through
  the terminal. 100% is fully opaque (the default). Native on Windows/macOS; on
  Linux it needs a compositing window manager (most desktops — GNOME, KDE, etc.
  — qualify) and the `xprop` tool (from `x11-utils`, usually preinstalled).
- **Layout** — the tab bar's corner (a 2×2 grid of the window's corners), its
  height, the sidebar's width, and whether the bar auto-hides. The sidebar also
  resizes by dragging the strip beside it; double-click to reset.

## Theming

A theme drives both color surfaces at once — the xterm.js terminal palette and
the app chrome (tabs, sidebar, panes, markdown reader) — and the choice is
persisted.

Built-ins: Tokyo Night (default), Catppuccin Mocha, Gruvbox Dark, Nord, and
Catppuccin Latte (light).

**Gallery:** Settings → Theme → *Browse gallery* lists 325
[base16 / tinted-theming](https://github.com/tinted-theming/schemes) schemes
(bundled, works offline) with swatches and a filter — click to apply.

**Import your own:** add any base16 scheme three ways — *Paste…* (YAML or JSON,
the `base00`–`base0F` colors), *Open file…* (`.yaml`/`.json`), or just drag a
scheme file onto the window. base16 is the de-facto cross-editor terminal theme
format, so most schemes you'll find online work as-is. Imported themes are saved
locally and can be removed from the same panel.

The bundled gallery is generated by `scripts/fetch-base16-schemes.mjs` (run it
to refresh `src/data/base16-schemes.json` from upstream).

### How it works

- `src/lib/theme.ts` — the theme model (a 16-color ANSI palette + semantic UI
  roles), the built-in themes, the base16 importer, and the two converters
  (`themeToXterm`, `themeToCssVars`). Pure, no side effects.
- `src/stores/theme.ts` — active-theme state + persistence; applies the theme by
  writing CSS variables onto `:root` and pushing the palette into every live
  terminal.
- `src/styles/*.css` — the chrome reads `--bg`, `--fg`, `--accent`, `--ansi-*`,
  etc.; defaults (Tokyo Night) live in the `:root` block of `global.css`.
- `src/data/base16-schemes.json` — the bundled gallery, generated by
  `scripts/fetch-base16-schemes.mjs` from tinted-theming/schemes.

## Tech Stack

- **Frontend:** SolidJS + TypeScript + xterm.js (WebGL renderer)
- **Host:** Electron + node-pty
- **Build:** Vite
- **Markdown:** markdown-it + Mermaid
- **Tests:** Playwright, driving the real Electron binary

## Development

```bash
npm install
# Rebuild native modules (node-pty) against Electron's ABI — required after
# `npm install` / `npm ci`, or the PTY fails to load and terminals won't open.
npx electron-builder install-app-deps
npm run dev:electron
```

### Windows: PowerShell shell fix

`node-pty` needs a real shell to spawn. On Windows `process.env.SHELL` is
unset, so the old `SHELL || "/bin/bash"` fallback tried to launch a binary that
doesn't exist and the terminal died on open. The Electron main process
(`electron/main.cjs`) now resolves the shell per platform:

- **Windows:** `powershell.exe` (override with the `SPECTERM_SHELL` env var,
  e.g. point it at `pwsh.exe` for PowerShell 7).
- **macOS / Linux:** `$SHELL`, falling back to `/bin/bash`.

The native `node-pty` addon is also kept out of the asar archive
(`build.asarUnpack`) and must be rebuilt for Electron (see the
`install-app-deps` step above) for the PTY to load in the packaged app.

See [docs/windows-setup.md](docs/windows-setup.md) for further prerequisites and
troubleshooting.

## Tests

```bash
npm run test:e2e        # vite build + node test/e2e.mjs
```

An end-to-end suite that builds the app, launches the **real** Electron binary,
and drives the actual UI — clicks, keyboard, drag-and-drop — asserting on
observable behavior. It runs on Windows, macOS and Linux. See
[test/README.md](test/README.md).

## Releases

Distributable installers are built in CI by `.github/workflows/release.yml`:

- **Linux** → AppImage + `.deb` (built in an Ubuntu 20.04 container, so the
  native `node-pty` links against glibc 2.31 and runs on Ubuntu 20.04+)
- **Windows** → NSIS installer (`.exe`)
- **macOS** → `.dmg` + `.zip` (Apple silicon, unsigned)

Because the macOS build is unsigned, the first launch fails with *"Specterm is
damaged and can't be opened"* — Gatekeeper's message for a quarantined ad-hoc
bundle. Clear the quarantine attribute once after installing:

```bash
xattr -dr com.apple.quarantine /Applications/Specterm.app
```

See [docs/macos-install.md](docs/macos-install.md) for the full explanation and
what notarizing would take.

Versioning is **semantic** (`MAJOR.MINOR.FIX`). To cut a release: land the work
on `main`, bump `version` in `package.json`, update `CHANGELOG.md`, then push a
matching tag — the tag push is what triggers the build and publishes a GitHub
Release with every platform's assets.

```bash
# after bumping "version" in package.json (e.g. 0.12.0)
git commit -am "chore: release v0.12.0"
git push origin main
git tag -a v0.12.0 -m "v0.12.0"
git push origin refs/tags/v0.12.0
```

Two things the workflow won't do for you:

- **Push the tag by its full ref.** Release work is staged on a branch named
  after the version (`v0.12.0`), which collides with the tag of the same name —
  `git push origin v0.12.0` is ambiguous and fails with *"matches more than
  one"*. Use `refs/tags/…`, or delete the branch first.
- **Write the release notes.** The workflow only uploads the binaries; the
  GitHub Release body comes out empty. Fill it in afterwards
  (`gh release edit <tag> --notes-file …`).

## Project Structure

```
src/
  App.tsx                  # Root component, chrome layout, keybinding setup
  backends/                # Host abstraction (see "A note on Tauri" below)
  components/
    TabBar.tsx             # Tab strip + action icons
    SplitContainer.tsx     # Recursive split layout
    SplitHandle.tsx        # Draggable split divider
    Pane.tsx               # Pane router (terminal or markdown)
    TerminalPane.tsx       # xterm.js terminal instance
    TerminalSearch.tsx     # Find bar over the active terminal
    MarkdownPane.tsx       # Markdown renderer
    FileTree.tsx           # Sidebar file browser + favourites
    SettingsPanel.tsx      # Settings, in the sidebar slot
    SidebarResizeHandle.tsx
  lib/
    pty.ts                 # PTY spawn/write/resize API
    mouse-selection.ts     # Click-vs-drag selection over mouse-grabbing programs
    split-tree.ts          # Split tree data structure
    terminal-registry.ts   # Terminal instance tracking, font size/family
    theme.ts               # Theme model + base16 importer
    fonts.ts               # Installed monospace font detection
    platform.ts            # Host OS + the ⌘ → Ctrl+Shift translation
    fspath.ts              # Cross-platform paths + shell quoting
    markdown.ts            # markdown-it + Mermaid setup
    osc.ts                 # OSC sequence parser
  stores/
    tabs.ts                # Tab/pane/sidebar state
    settings.ts            # Persisted preferences
    theme.ts               # Active theme + persistence
    favorites.ts           # Pinned folders (fav-N)
    keybindings.ts         # Keyboard shortcut registry + per-OS resolver
    keymap.ts              # Declarative keymap (all shortcuts, macOS-first)
electron/
  main.cjs                 # Electron main process + IPC handlers
  preload.cjs              # Context bridge
test/
  e2e.mjs                  # Playwright end-to-end suite
```

### A note on Tauri

`src/backends/` abstracts the host behind an interface, and a Tauri v2
implementation exists alongside the Electron one (`src-tauri/`, plus the
`Dockerfile`). **It is not supported, and the app does not currently work on
it.** The Rust side registers only the four PTY commands; `get_home_path` — which
the backend invokes on startup — was never added, so the file sidebar can't even
resolve where to open. Drive enumeration is a stub, and the clipboard falls back
to `navigator.clipboard`, the exact path that made copy/paste unreliable on
Electron before v0.10.0.

**Ship and test on Electron.** The abstraction is kept because it costs little
and keeps host calls in one place, but the Tauri implementation is dormant, not
maintained. Reviving it means finishing the Rust commands first.

## License

MIT
