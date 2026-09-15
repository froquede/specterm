# Specterm

A GPU-accelerated terminal emulator for running coding agents in parallel.
Sessions survive closing the window, panes tell you when an agent is waiting, and
markdown renders inline. SolidJS + xterm.js on Electron — Linux, macOS, Windows.

![Specterm — three agents running in their own panes, dividers dragged on both axes, panes swapped by their title-bars, a Mermaid diagram rendered in a tab of its own, a theme change recolouring everything at once, and each agent flagging its pane as it finishes](docs/assets/specterm.gif)

## Install

Grab a build from [Releases](https://github.com/froquede/specterm/releases):
AppImage or `.deb` on Linux, `.exe` on Windows, `.dmg` on macOS (`arm64` for Apple silicon, `x64` for Intel).

macOS is unsigned, so clear the quarantine flag once after installing:

```bash
xattr -dr com.apple.quarantine /Applications/Specterm.app
```

## Features

Splits with draggable dividers, tabs, and multiple windows — with tabs that tear
off, move between windows and merge back, and panes that become tabs of their own
by being dropped on the tab bar. A filterable file sidebar with pinned favourites.
Markdown preview and editor with Mermaid, an image viewer you can zoom and pan,
and a syntax-highlighted viewer for everything else — from the sidebar, or by
naming the file on the command line.
Mermaid blocks that go past in *terminal output* are drawn too:
a chip appears beside the block and clicking it opens the diagram over the pane.
Find in scrollback, WebGL rendering, five built-in themes plus a 325-scheme
base16 gallery, and a tab bar that stands in for the title bar.
Closing a window (or quitting) while a build, a test run or a Claude session is
still going asks first, naming what is running — read from the shells' own child
processes, so a window of idle prompts still closes on one click.

## Keybindings

macOS uses `⌘`. Linux and Windows use the Kitty-style `Ctrl+Shift+<key>` scheme,
which keeps bare `Ctrl+<key>` free for terminal control codes.

These are the defaults, and all of them are rebindable: **Settings →
Keybindings** lists the whole table, and clicking a chord records whatever you
press next. **Backspace** switches a shortcut off entirely, handing its keys
back to the terminal; **Esc** backs out; pressing a row's original chord clears
the override. Bare keys and lone `Ctrl+<key>` chords are refused — those are the
control codes the shell needs — but function keys are fair game. Overrides are
stored under `specterm.keybindings` as `{ "tab.new": { "key": "t", "ctrl": true,
"shift": true } }`, keyed by the action's stable id, so a default that moves in a
later version doesn't take your setting with it.

| Action | macOS | Linux / Windows |
|---|---|---|
| New window | `⌘N` | `Ctrl+Shift+N` |
| New tab | `⌘T` | `Ctrl+Shift+T` |
| Reopen last closed tab / pane | `⌘⇧T` | `Ctrl+Shift+R` |
| Rename tab | `⌘R` | `F2` |
| Close tab | `⌘⇧W` | `Ctrl+Shift+Q` |
| Close pane | `⌘W` | `Ctrl+Shift+W` |
| Next / previous tab | `⌘⇧]` / `⌘⇧[` | `Ctrl+Shift+→` / `Ctrl+Shift+←` |
| Next / previous tab (also) | `Ctrl+Tab` / `Ctrl+⇧Tab` | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Split — stacked | `⌘D` | `Ctrl+Shift+S` |
| Split — side by side | `⌘⇧D` | `Ctrl+Shift+Enter` |
| Focus pane left/right/up/down | `⌥`+arrow | `⌥`+arrow |
| Go to a pane waiting on you | `⌘⇧U` | `Ctrl+Shift+U` |
| Copy selection | `⌘C` | `Ctrl+Shift+C` |
| Paste (image inline if the clipboard holds only an image) | `⌘⇧V` | `Ctrl+Shift+V` |
| Paste as plain text | `⌘V` | `Ctrl+V` |
| Paste an image into Claude Code | `⌃V` | `Alt+V` |
| Find in terminal | `⌘F` | `Ctrl+Shift+F` |
| Toggle sidebar / search | `⌘B` | `Ctrl+Shift+B` |
| Toggle settings | `⌘,` | `Ctrl+Shift+,` |
| Markdown / text file: edit / save | `⌘E` / `⌘S` | `Ctrl+Shift+E` / `Ctrl+S` |
| Text file: toggle line comment | `⌘/` | `Ctrl+/` |
| Font size up / down / reset | `⌘=` / `⌘-` / `⌘0` | `Ctrl+Shift+=` / `-` / `0` |
| Quit (ends detached sessions) | `⌘Q` | `Alt+F4` |

## Behaviours worth knowing

**Selection over mouse-tracking programs.** Full-screen programs turn on mouse
tracking, and a terminal then hands them every button press — which is why you
normally can't select text out of Claude Code or vim, and why every terminal's
answer is *"hold Shift"*. Specterm tells the two intents apart: a **click** goes
to the program, a **drag** past 3px becomes a local selection. `Shift+drag` still
works, `Alt+drag` selects a column. See `src/lib/mouse-selection.ts`.

**Moving tabs between windows.** Drag a tab — or a pane by its title-bar — past
the window edge. Release over another Specterm window to move it there, anywhere
else to make it a new window. The window under the cursor lights up across its
whole surface: it can't feel the drag itself — the pointer belongs to the window
the gesture started in — so the app tells it where the cursor is. The shell is
handed over still running: its scrollback is serialized and replayed, and
anything it prints mid-move is buffered and written back in order. It goes both
ways: dropping a window's only tab onto another window merges it back, and the
window it left closes itself.

**Moving a pane out of its split.** Drop a pane on the **tab bar** — anywhere
that isn't a tab chip — and it gets a tab of its own. Drop it on a chip and it
joins that tab; drop it back over the panes and it splits or swaps as usual.

**Splits inherit the directory.** A new pane opens where the pane you split from
is. Read from the shell's own process, so it works without configuring anything;
`OSC 7` (which zsh and fish send by default) is used as a faster hint when present.

**Opening a file from outside.** `specterm notes.md`, `specterm shot.png`, a
double-click on a registered type, an "Open With" — they all land in a new tab,
routed exactly the way clicking that file in the sidebar is: markdown to the
preview, an image to the image viewer, anything else to the text viewer, which
refuses binaries on its own. Relative paths resolve against the shell you typed
them in, several files open as several tabs, and a directory or a typo'd
filename is ignored rather than guessed at — you get the terminal you asked for.
If Specterm is already running, the file opens in the window you are looking at
instead of starting a second app. See `electron/open-paths.cjs`.

**Zooming a picture.** The image viewer and both places diagrams are drawn share
one viewport: the **wheel** (or a trackpad pinch) zooms toward the pointer,
**drag** pans, and **double-click** goes back to where you started. Images open
fitted to the pane and their toolbar carries the same thing as buttons, plus
*1:1* for one image pixel per screen pixel. Nothing is bound to a key — `⌘=` /
`⌘-` / `⌘0` are the terminal font size, app-wide, and a viewer that quietly took
them while it happened to be focused would be the worse surprise. See
`src/lib/pan-zoom.ts`.

**Waiting panes.** Four independent signals — the standard `OSC 9`/`777`/`99`
notification sequences, the terminal bell, output-timing detection for Claude
Code, and Claude's own hooks. Three of them need no setup. Optional desktop
notifications are off by default. See [docs/waiting-panes.md](docs/waiting-panes.md).

**Updating also updates your checkout.** When an update finishes downloading,
Specterm looks for a local clone of itself — a directory named `specterm` within
four levels of your home directory whose `origin` really points at this
repository — and fast-forwards it onto `main`. Silently, once per launch, and
only when it is safe: a dirty working tree is left completely alone, the pull is
`--ff-only` so it can never merge or conflict, and a checkout parked on another
branch has `main` advanced behind it without its working tree or its `HEAD`
being touched. No clone, no `git`, no network — it skips. See
`electron/repo-sync.cjs`.

**Editing markdown.** Inside the markdown *editor*, `⌘V`/`⌘C`/`⌘X`
(`Ctrl+V`/`Ctrl+C`/`Ctrl+X`) act on the document rather than the terminal behind
it, and right-clicking offers the same.

**Closing with something still running.** A window's terminals die with it, so
closing one — or quitting — while a build, a test run or a Claude session is in
flight asks first, naming what is running. The answer comes from the shells' own
child processes, not from "are there tabs open", so a window of idle prompts
closes on one click. A window that parks its session instead (background
sessions, on by default) kills nothing and never asks.

**Theming.** Themes drive the terminal palette and the app chrome at once.
Settings → Theme → *Browse gallery* has 325 bundled
[base16](https://github.com/tinted-theming/schemes) schemes; you can also paste,
open or drag in your own.

## Development

```bash
npm install
# Rebuild node-pty against Electron's ABI — required after install/ci,
# or the PTY fails to load and terminals won't open.
npx electron-builder install-app-deps
npm run dev:electron
```

### The app icon

`build/icon.png` is the source of truth: the artwork alone, square, transparent,
edge to edge. Everything else is generated from it by `scripts/make-icons.sh`
(macOS only — `sips` and `iconutil` do the work), which writes:

- `build/icon.icns` — macOS. The artwork is scaled to 824 on a 1024 canvas,
  which is the margin macOS app icons are drawn with; letting electron-builder
  convert the full-bleed png instead makes Specterm sit visibly larger than
  everything else in the dock.
- `build/icon-dock.png` — the same shape at 512, for the dock icon of an
  unpackaged run. It exists because `nativeImage` can't read an `.icns` at all,
  so `app.dock.setIcon` needs a png that already carries the margin.
- `build/icons/*.png` — Linux, at the sizes desktops ask for.

Windows needs nothing generated: electron-builder converts `build/icon.png` to
an `.ico` at build time.

Replacing the icon means replacing that one png and re-running the script. The
same png is also packaged (it's in `build.files`) and used as the window icon on
Linux and Windows, and as the dock icon when running unpackaged on macOS — where
the app would otherwise appear as Electron itself.

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
npm run test:e2e        # main suite
npm run test:e2e:all    # + multi-window, session continuity, repo-sync
npm run test:repo-sync  # post-update clone sync (real git, no Electron)
npm run test:perf       # startup budget
```

The suites build the app, launch the **real** Electron binary and drive the
actual UI. See [test/README.md](test/README.md).

Windows needs a shell that `node-pty` can spawn; Specterm defaults to
`powershell.exe`, overridable with `SPECTERM_SHELL`. See
[docs/windows-setup.md](docs/windows-setup.md).

Releasing is documented in [docs/releasing.md](docs/releasing.md).

> `src/backends/` abstracts the host, and a dormant Tauri v2 implementation
> exists alongside the Electron one. It does not currently work — ship and test
> on Electron.

## License

[Apache-2.0](LICENSE)
