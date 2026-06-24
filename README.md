# Specterm

A GPU-accelerated terminal emulator with split panes, tabs, markdown preview, and a file tree sidebar. Built with SolidJS and xterm.js, running on both Tauri (native) and Electron backends.

## Features

- **Split panes** -- horizontal and vertical splits with draggable resize handles
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
| `Ctrl+Shift+T` | New tab |
| `Ctrl+Shift+Q` | Close tab |
| `Ctrl+Shift+Right/Left` | Next/previous tab |
| `Ctrl+Shift+Enter` | Split horizontally |
| `Ctrl+Shift+\` | Split vertically |
| `Ctrl+Shift+W` | Close pane |
| `Ctrl+Shift+C` | Copy selection |
| `Ctrl+Shift+V` | Paste |
| `Ctrl+Shift+B` | Toggle sidebar |

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
npm run dev:electron
```

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
