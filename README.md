# Specterm

A GPU-accelerated terminal emulator with split panes, tabs, markdown preview, and a file tree sidebar. Built with SolidJS and xterm.js, running on both Tauri (native) and Electron backends.

## Features

- **Split panes** -- horizontal and vertical splits with draggable resize handles, drag-and-drop reordering via each pane's title-bar, and one-click/keyboard direction flipping
- **Tabs** -- create, close, and cycle through terminal tabs
- **Markdown preview** -- render `.md` files inline with Mermaid diagram support
- **File tree sidebar** -- browse and open files from the working directory
- **Dual backend** -- runs on Tauri v2 (Rust) or Electron (Node.js + node-pty)
- **WebGL rendering** -- GPU-accelerated terminal via xterm.js WebGL addon
- **OSC protocol** -- captures title sequences and working directory updates
- **Kitty-style keybindings** -- all shortcuts use `Ctrl+Shift+<key>`

## Keybindings

| Shortcut | Action |
|---|---|
| `⌘T` | New tab |
| `⌘W` | Close pane |
| `⌘⇧W` | Close tab |
| `⌘⇧]` / `⌘⇧[` | Next/previous tab |
| `⌘⇧D` | Split horizontally (stacked) |
| `⌘D` | Split vertically (side by side) |
| `⌘⌥→` / `⌘⌥←` | Focus next/previous grid (pane) |
| `⌘C` | Copy selection |
| `⌘V` | Paste |
| `⌘B` | Toggle sidebar |
| `⌘⇧B` | Open sidebar + focus search |
| `⌘F` | Find in markdown preview |
| `⌘=` / `⌘-` | Increase / decrease font size |
| `⌘0` | Reset font size |

## Tech Stack

- **Frontend:** SolidJS + TypeScript + xterm.js
- **Native backend:** Tauri v2 (Rust shell plugin)
- **Desktop backend:** Electron + node-pty
- **Build:** Vite
- **Markdown:** markdown-it + Mermaid

## Development

### Electron (recommended for dev)

```bash
npm install
# Rebuild native modules (node-pty) against Electron's ABI — required after
# `npm install` / `npm ci`, or the PTY fails to load and terminals won't open.
npx electron-builder install-app-deps
npm run dev:electron
```

#### Windows: PowerShell shell fix

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

### Tauri

Requires Rust and Tauri v2 CLI.

```bash
npm install
npm run tauri dev
```

On Windows, see [docs/windows-setup.md](docs/windows-setup.md) for prerequisites
and troubleshooting.

### Docker build (Tauri AppImage)

```bash
docker build --output=. .
```

## Releases

Distributable installers are built in CI by `.github/workflows/release.yml`:

- **Windows** → NSIS installer (`.exe`)
- **macOS** → `.dmg` + `.zip` (Apple silicon, unsigned)

Versioning is **semantic** (`MAJOR.MINOR.FIX`). To cut a release, bump
`version` in `package.json`, then commit and push a matching tag — the tag push
triggers the build and publishes a GitHub Release with both platforms' assets:

```bash
# after bumping "version" in package.json (e.g. 0.2.0)
git commit -am "release: v0.2.0"
git tag v0.2.0
git push origin main --tags
```

`build.yml` runs the Tauri/Linux CI on every push/PR to `main` (no release).

## Project Structure

```
src/
  App.tsx                  # Root component, keybinding setup
  backends/                # Platform abstraction (Tauri / Electron)
  components/
    TabBar.tsx             # Tab strip
    SplitContainer.tsx     # Recursive split layout
    SplitHandle.tsx        # Draggable split divider
    Pane.tsx               # Pane router (terminal or markdown)
    TerminalPane.tsx       # xterm.js terminal instance
    MarkdownPane.tsx       # Markdown renderer
    FileTree.tsx           # Sidebar file browser
  lib/
    pty.ts                 # PTY spawn/write/resize API
    split-tree.ts          # Split tree data structure
    terminal-registry.ts   # Terminal instance tracking
    markdown.ts            # markdown-it + Mermaid setup
    osc.ts                 # OSC sequence parser
  stores/
    tabs.ts                # Tab/pane state management
    keybindings.ts         # Keyboard shortcut registry
electron/
  main.cjs                 # Electron main process + IPC handlers
  preload.cjs              # Context bridge
src-tauri/                 # Tauri v2 Rust backend
```

## License

MIT
