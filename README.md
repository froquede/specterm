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
| `⌘T` | New tab |
| `⌘W` | Close pane |
| `⌘⇧W` | Close tab |
| `⌘⇧]` / `⌘⇧[` | Next/previous tab |
| `⌘⇧D` | Split horizontally (stacked) |
| `⌘D` | Split vertically (side by side) |
| `⌘C` | Copy selection |
| `⌘V` | Paste |
| `⌘B` | Toggle sidebar |
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
npm run dev:electron
```

### Tauri

Requires Rust and Tauri v2 CLI.

```bash
npm install
npm run tauri dev
```

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
