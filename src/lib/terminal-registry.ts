import { createSignal } from "solid-js";
import { Terminal } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { spawnPty, writePty, resizePty, killPty, onPtyOutput, onPtyExit, ptyCwd } from "./pty";
import { startupPath } from "../stores/settings";
import { os } from "./platform";
import { registerOscHandler, registerCwdHandler } from "./osc";
import { favoriteByIndex } from "../stores/favorites";
import { themeToXterm, DEFAULT_THEME } from "./theme";
import { installClickVsDragSelection } from "./mouse-selection";
import type { UnlistenFn } from "../backends/types";

// Active xterm palette, applied to new terminals at creation and pushed into
// every live terminal by setTerminalTheme. Seeded with the default so terminals
// render correctly before stores/theme.ts applies the persisted choice. The
// background stays transparent (see themeToXterm) so the .app layer shows
// through and the unfocused-split overlay can tint without a repaint.
let currentXtermTheme: ITheme = themeToXterm(DEFAULT_THEME);

// Swap the palette for every open terminal and for any created afterwards.
// Called by stores/theme.ts whenever the user changes theme.
export function setTerminalTheme(theme: ITheme) {
  currentXtermTheme = theme;
  for (const instance of instances.values()) {
    if (instance.disposed) continue;
    instance.term.options.theme = theme;
  }
}

function safeFit(term: Terminal, fitAddon: FitAddon) {
  const buffer = term.buffer.active;
  // Was the viewport pinned to the bottom before the fit?
  const atBottom = buffer.viewportY >= buffer.baseY;
  const viewportY = buffer.viewportY;
  fitAddon.fit();
  // After a fit the content may reflow taller (e.g. width reduced by a new
  // split), so a preserved viewportY would leave the view above the bottom.
  // Always keep the bottom in view when it was visible before the resize.
  if (atBottom) {
    term.scrollToBottom();
  } else {
    term.scrollToLine(viewportY);
  }
}

export interface TerminalInstance {
  term: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  ptyId: number | null;
  container: HTMLDivElement | null;
  unlistenOutput: UnlistenFn | null;
  unlistenExit: UnlistenFn | null;
  resizeObserver: ResizeObserver | null;
  // Tears down the click-vs-drag selection bridge (see lib/mouse-selection).
  // Re-installed on every attach, since it's bound to the current container.
  detachSelection: (() => void) | null;
  disposed: boolean;
  // Last OSC title reported by the shell (e.g. Claude Code's `/rename`). Stored
  // on the instance so it survives pane remounts (split/drag) and so a fresh
  // title-bar can read it immediately on attach. `onTitle` is the current
  // pane's callback, re-wired on every attach.
  title: string;
  onTitle: ((title: string) => void) | null;
  // The shell's working directory, kept current so a new pane can open where
  // this one is. Seeded with the spawn cwd, then updated from OSC 7 when the
  // shell reports it and re-read from the shell process after each command
  // (refreshCwd) for the shells that don't. Never blank once spawned.
  cwd: string;
  // Set once this shell has sent an OSC 7. From then on it is the authority on
  // its own directory and the process probe stops: the shell reports the moment
  // it moves, knows about cases a process snapshot can blur (a subshell, a
  // pushd), and costs no IPC. Shells that never report keep being probed.
  cwdReportedByShell: boolean;
}

const instances = new Map<string, TerminalInstance>();

// Font zoom (Ghostty-style: ⌘= / ⌘- / ⌘0). Applies to every open terminal.
const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 40;
const FONT_SIZE_STORAGE_KEY = "specterm.fontSize";

// Restore the last zoom level from a previous session, clamped to the valid
// range. Falls back to the default when nothing valid is stored.
function loadFontSize(): number {
  try {
    const stored = Number(localStorage.getItem(FONT_SIZE_STORAGE_KEY));
    if (Number.isFinite(stored) && stored >= MIN_FONT_SIZE && stored <= MAX_FONT_SIZE) {
      return stored;
    }
  } catch {
    // localStorage unavailable — fall through to default
  }
  return DEFAULT_FONT_SIZE;
}

let currentFontSize = loadFontSize();

function persistFontSize() {
  try {
    localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(currentFontSize));
  } catch {
    // localStorage unavailable — zoom just won't persist this session
  }
}

function applyFontSize() {
  persistFontSize();
  for (const instance of instances.values()) {
    if (instance.disposed) continue;
    instance.term.options.fontSize = currentFontSize;
    if (instance.container) {
      try {
        safeFit(instance.term, instance.fitAddon);
      } catch {
        // container not measurable right now — ignore
      }
    }
  }
  // Publish the same zoom factor to markdown panes via a CSS variable so
  // ⌘= / ⌘- / ⌘0 scale the .md reader in lockstep with the terminal font.
  document.documentElement.style.setProperty(
    "--md-font-scale",
    (currentFontSize / DEFAULT_FONT_SIZE).toString()
  );
}

export function increaseFontSize() {
  currentFontSize = Math.min(MAX_FONT_SIZE, currentFontSize + 1);
  applyFontSize();
}

export function decreaseFontSize() {
  currentFontSize = Math.max(MIN_FONT_SIZE, currentFontSize - 1);
  applyFontSize();
}

export function resetFontSize() {
  currentFontSize = DEFAULT_FONT_SIZE;
  applyFontSize();
}

// Publish the restored zoom to markdown panes on startup, so the .md reader
// opens at the same scale as the terminal even before the first ⌘=/⌘-/⌘0.
document.documentElement.style.setProperty(
  "--md-font-scale",
  (currentFontSize / DEFAULT_FONT_SIZE).toString()
);

// Terminal font family. Unlike zoom (driven by keyboard), this is a persisted
// preference the Settings panel binds to, so it's a reactive signal. An empty
// value means "use the bundled default stack".
const DEFAULT_FONT_FAMILY =
  "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace";
const FONT_FAMILY_STORAGE_KEY = "specterm.fontFamily";

function loadFontFamily(): string {
  try {
    return localStorage.getItem(FONT_FAMILY_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

const [terminalFontFamily, setTerminalFontFamilySignal] = createSignal<string>(
  loadFontFamily()
);
export { terminalFontFamily };

// The concrete CSS font-family handed to xterm: the user's pick with a
// monospace fallback, or the bundled default stack when unset.
function xtermFontFamily(): string {
  const fam = terminalFontFamily().trim();
  return fam ? `'${fam.replace(/'/g, "")}', monospace` : DEFAULT_FONT_FAMILY;
}

function persistFontFamily() {
  try {
    localStorage.setItem(FONT_FAMILY_STORAGE_KEY, terminalFontFamily());
  } catch {
    // localStorage unavailable — selection just won't persist this session
  }
}

// Swap the font on every open terminal and refit (glyph metrics change the
// column/row count), mirroring applyFontSize. `family` is a bare family name
// (e.g. "Menlo") or "" to restore the default.
export function setTerminalFontFamily(family: string) {
  setTerminalFontFamilySignal(family);
  persistFontFamily();
  const next = xtermFontFamily();
  for (const instance of instances.values()) {
    if (instance.disposed) continue;
    instance.term.options.fontFamily = next;
    if (instance.container) {
      try {
        safeFit(instance.term, instance.fitAddon);
      } catch {
        // container not measurable right now — ignore
      }
    }
  }
}

export function getTerminalInstance(paneId: string): TerminalInstance | undefined {
  return instances.get(paneId);
}

// --- "cd fav-N" expansion -------------------------------------------------
// Typing `cd fav-1` at the shell prompt and pressing Enter is rewritten into a
// real `cd <path>` for the favorite pinned at that 1-based index, mirroring the
// sidebar-search "fav-N" token. To do this we shadow the current input line by
// mirroring the user's keystrokes (append printable chars, pop on backspace).
// Anything we can't model — arrow keys, history recall, tab-completion — flips
// the line "untracked" so we never rewrite a line we don't fully understand.
// The mirror resets on every Enter/Ctrl-C/Ctrl-U.

const CD_FAV_RE = /^cd\s+fav-(\d+)$/;

// POSIX single-quote a path so spaces and shell metacharacters survive intact.
function shellQuote(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

// Build the `cd fav-N` expansion for the host shell. A real directory literally
// named `fav-N` in the cwd wins — try it first, fall back to the favorite path.
// The default Windows shell is PowerShell, where the POSIX `cd x 2>/dev/null ||`
// form is a parse error, so it needs its own Test-Path form.
function cdFavCommand(dir: string, favPath: string): string {
  if (os === "windows") {
    // PowerShell escapes a single quote by doubling it; -LiteralPath avoids
    // glob/[] interpretation of the path.
    //
    // Backslashes must become forward slashes first: when this line is injected
    // into the shell's input in one burst, ConPTY/PSReadLine drops the lone
    // backslashes from the favorite path (`C:\Users\x` arrives as `C:Usersx`),
    // so Set-Location fails with PathNotFound and the jump silently breaks.
    // PowerShell accepts `/` as a path separator, and `/` survives injection
    // intact, so emit the path forward-slashed.
    const q = (p: string) => `'${p.replace(/\\/g, "/").replace(/'/g, "''")}'`;
    return (
      `if (Test-Path -LiteralPath ${q(dir)}) ` +
      `{ Set-Location -LiteralPath ${q(dir)} } ` +
      `else { Set-Location -LiteralPath ${q(favPath)} }`
    );
  }
  return `cd ${shellQuote(dir)} 2>/dev/null || cd ${shellQuote(favPath)}`;
}

// Fold a chunk of terminal input into the mirrored line buffer. Returns the new
// buffer text plus whether it's still a faithful mirror of the prompt line.
function foldInput(
  buffer: string,
  tracked: boolean,
  data: string
): { buffer: string; tracked: boolean } {
  // Backspace / DEL — drop the last char.
  if (data === "\x7f" || data === "\x08") {
    return { buffer: buffer.slice(0, -1), tracked };
  }
  // Ctrl-U (kill line) — clear the mirror but keep tracking.
  if (data === "\x15") {
    return { buffer: "", tracked: true };
  }
  // A run of purely printable text (single keystroke or a bracketed paste
  // without newlines) — append it verbatim.
  if (data.length > 0 && !/[\x00-\x1f\x7f]/.test(data)) {
    return { buffer: buffer + data, tracked };
  }
  // Ctrl-C / Ctrl-D and friends — the line is abandoned, reset the mirror.
  if (data === "\x03" || data === "\x04") {
    return { buffer: "", tracked: true };
  }
  // Escape sequences (arrows, history, home/end), tab-completion, or any other
  // control input we can't faithfully replay — stop trusting the mirror until
  // the next line.
  return { buffer, tracked: false };
}

// Re-read the shell's directory from its own process and cache it. Silent and
// best-effort: a null answer (Windows, or a pty that exited between the ask and
// the look) leaves the last known value alone rather than blanking it.
async function refreshCwd(instance: TerminalInstance) {
  if (instance.ptyId === null || instance.disposed) return;
  // The shell reports for itself — don't second-guess it with a snapshot taken
  // at a slightly different moment.
  if (instance.cwdReportedByShell) return;
  const cwd = await ptyCwd(instance.ptyId);
  if (cwd && !instance.disposed) instance.cwd = cwd;
}

// A command just ran, so the directory may have moved. A bare `cd` lands
// immediately, but a script that cds partway through takes longer — so probe
// twice around the command instead of polling on a timer while the terminal
// sits idle, which would cost an IPC round trip per second per pane forever.
// Shells that send OSC 7 have already updated the value by now; this is the
// fallback path, and re-reading is harmless when it agrees.
const cwdProbes = new WeakMap<TerminalInstance, number[]>();

function scheduleCwdRefresh(instance: TerminalInstance) {
  for (const timer of cwdProbes.get(instance) ?? []) clearTimeout(timer);
  cwdProbes.set(instance, [
    window.setTimeout(() => refreshCwd(instance), 150),
    window.setTimeout(() => refreshCwd(instance), 1500),
  ]);
}

/** The live working directory of a pane's shell, or "" if it has no terminal. */
export function getTerminalCwd(paneId: string): string {
  return instances.get(paneId)?.cwd ?? "";
}

export async function createTerminalInstance(
  paneId: string,
  opts?: {
    onTitle?: (title: string) => void;
    onExit?: () => void;
    onOpenMarkdown?: (path: string, mode: "split" | "tab") => void;
    // Directory this terminal should open in — the live cwd of the pane it was
    // split from. Blank for the boot terminal, which uses the startup path.
    initialCwd?: string;
  }
): Promise<TerminalInstance> {
  // Return existing if already created
  const existing = instances.get(paneId);
  if (existing && !existing.disposed) {
    return existing;
  }

  const term = new Terminal({
    cursorBlink: true,
    fontSize: currentFontSize,
    fontFamily: xtermFontFamily(),
    allowTransparency: true,
    theme: currentXtermTheme,
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  const searchAddon = new SearchAddon();
  term.loadAddon(searchAddon);
  term.loadAddon(new WebLinksAddon((event, uri) => {
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    window.open(uri, '_blank');
  }));

  if (opts?.onOpenMarkdown) {
    registerOscHandler(term, ({ path, mode }) => {
      opts.onOpenMarkdown!(path, mode);
    });
  }

  const instance: TerminalInstance = {
    term,
    fitAddon,
    searchAddon,
    ptyId: null,
    container: null,
    unlistenOutput: null,
    unlistenExit: null,
    resizeObserver: null,
    detachSelection: null,
    disposed: false,
    title: "Terminal",
    onTitle: opts?.onTitle ?? null,
    // Where this terminal will spawn. The pane carries the directory it should
    // inherit (the pane it was split from); blank falls back to the configured
    // startup path, then to home main-side.
    cwd: opts?.initialCwd || startupPath() || "",
    cwdReportedByShell: false,
  };

  instances.set(paneId, instance);

  // The shell's own report of its directory, when it sends one. Free and
  // instant where available; refreshCwd covers the shells that stay quiet.
  registerCwdHandler(term, (cwd) => {
    instance.cwd = cwd;
    instance.cwdReportedByShell = true;
  });

  // Title is reported once here and cached on the instance, then forwarded to
  // whichever pane is currently mounted. Wiring it on the instance (not in a
  // pane closure) keeps `/rename` titles flowing after splits/drag remounts.
  term.onTitleChange((title) => {
    instance.title = title;
    instance.onTitle?.(title);
  });

  // Spawn PTY (deferred until attached to DOM)
  return instance;
}

export async function attachTerminal(
  paneId: string,
  container: HTMLDivElement,
  opts?: {
    onTitle?: (title: string) => void;
    onExit?: () => void;
    onOpenMarkdown?: (path: string, mode: "split" | "tab") => void;
    initialCwd?: string;
  }
) {
  let instance = instances.get(paneId);
  if (!instance || instance.disposed) {
    instance = await createTerminalInstance(paneId, opts);
  }

  const { term, fitAddon } = instance;

  // Re-point the title callback at the pane mounting now, and immediately push
  // the cached title so a remounted (split/drag) title-bar shows the current
  // `/rename` name without waiting for the next OSC.
  if (opts?.onTitle) {
    instance.onTitle = opts.onTitle;
    opts.onTitle(instance.title);
  }

  // If already attached to this container, just re-fit. detachTerminal may have
  // torn the selection bridge down in between, so put it back.
  if (instance.container === container) {
    instance.detachSelection ??= installClickVsDragSelection(term, container);
    safeFit(term, fitAddon);
    term.focus();
    return;
  }

  // If terminal was previously opened, re-attach DOM element
  if (instance.container && instance.ptyId !== null) {
    // Move the terminal element to the new container
    container.innerHTML = "";
    if (term.element) {
      container.appendChild(term.element);
    }
    instance.container = container;

    // The selection bridge is bound to the container element, so it moves with
    // the terminal on a split/drag remount.
    instance.detachSelection?.();
    instance.detachSelection = installClickVsDragSelection(term, container);

    // Reconnect resize observer
    instance.resizeObserver?.disconnect();
    let fitTimeout: number | null = null;
    let lastW = 0, lastH = 0;
    instance.resizeObserver = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width === lastW && height === lastH) return;
      lastW = width;
      lastH = height;
      if (fitTimeout) cancelAnimationFrame(fitTimeout);
      fitTimeout = requestAnimationFrame(() => safeFit(term, fitAddon));
    });
    instance.resizeObserver.observe(container);

    safeFit(term, fitAddon);
    term.focus();
    return;
  }

  // First time opening
  instance.container = container;
  term.open(container);

  // A plain drag selects text even when the program running in the pane has
  // grabbed the mouse (Claude Code, vim, htop); a plain click still reaches it.
  instance.detachSelection = installClickVsDragSelection(term, container);

  // Chromium caps the number of simultaneous WebGL contexts (~16). With many
  // open panes/tabs the oldest context gets force-killed (so it's typically the
  // *first* pane that's hit). Two things then go wrong in xterm 5.x:
  //   1. Disposing the WebGL addon does NOT restore a working renderer (there's
  //      no automatic DOM fallback), so the pane has no renderer and sits blank
  //      until it's re-opened.
  //   2. The addon itself waits 3s (hoping for a `webglcontextrestored`) before
  //      it even fires `onContextLoss`, so a plain onContextLoss handler leaves
  //      the pane blank for 3s.
  // Recover by re-opening the terminal (rebuilds the render layer) and mounting
  // a *fresh* WebGL addon — the lost context has been freed, so a new one draws
  // immediately. We trigger this off the raw `webglcontextlost` event (next
  // frame) to skip the 3s wait, and guard with `currentAddon` so the addon's
  // late 3s fallback for an already-replaced addon is a no-op. `attempts` bounds
  // the retry so a machine that genuinely can't grant a context can't spin.
  let attempts = 5;
  let currentAddon: WebglAddon | null = null;
  let recovering = false;

  const recoverRenderer = () => {
    if (instance.disposed || recovering) return;
    recovering = true;
    requestAnimationFrame(() => {
      recovering = false;
      if (instance.disposed || !instance.container) return;
      try {
        term.open(instance.container);
      } catch {
        // container detached mid-recovery — nothing to rebuild onto
      }
      mountWebgl();
      try {
        term.refresh(0, term.rows - 1);
      } catch {
        // term disposed between loss and repaint — nothing to draw
      }
    });
  };

  const mountWebgl = () => {
    if (instance.disposed || attempts-- <= 0) return;
    let addon: WebglAddon;
    try {
      addon = new WebglAddon();
    } catch {
      return; // WebGL unavailable — xterm keeps its default renderer
    }
    currentAddon = addon;
    const onLost = () => {
      if (addon !== currentAddon) return; // stale event from a replaced addon
      currentAddon = null;
      addon.dispose();
      recoverRenderer();
    };
    addon.onContextLoss(onLost); // 3s fallback path
    try {
      term.loadAddon(addon);
    } catch {
      addon.dispose();
      currentAddon = null;
      return;
    }
    // Fast path: react to the raw loss event immediately instead of waiting out
    // the addon's 3s restoration window.
    const canvas = instance.container?.querySelector<HTMLCanvasElement>(
      ".xterm-screen > canvas:not(.xterm-link-layer)"
    );
    canvas?.addEventListener("webglcontextlost", onLost, { once: true });
  };
  mountWebgl();

  fitAddon.fit();

  // Spawn PTY. instance.cwd is the directory inherited from the pane this one
  // was split from, or the configured startup directory (Settings) for the boot
  // terminal; blank → undefined, and the main process falls back to the OS
  // home. A stale/deleted path is guarded main-side so spawning can't crash.
  instance.ptyId = await spawnPty({
    cols: term.cols,
    rows: term.rows,
    cwd: instance.cwd || undefined,
  });

  // The spawn directory is only the starting point — from here the value has to
  // track the user's `cd`s, or a split taken an hour later would still inherit
  // where the shell began. Read it back once now so a shell rc that cds on
  // startup is reflected too.
  refreshCwd(instance);

  // Wire output
  instance.unlistenOutput = await onPtyOutput((id, data) => {
    if (id === instance!.ptyId) {
      term.write(data);
    }
  });

  // Wire exit
  instance.unlistenExit = await onPtyExit((id) => {
    if (id === instance!.ptyId) {
      term.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n");
      opts?.onExit?.();
    }
  });

  // Wire input. A mirrored line buffer lets us expand `cd fav-N` into a real
  // `cd <path>` at the moment Enter is pressed (see foldInput above).
  let lineBuffer = "";
  let lineTracked = true;
  term.onData((data) => {
    if (instance!.ptyId === null) return;
    const ptyId = instance!.ptyId;

    // Enter — try to expand the line before it reaches the shell.
    if (data === "\r" || data === "\n") {
      // Whatever the command turns out to be, it may leave the shell somewhere
      // new — including the `cd fav-N` expansion below, which is a cd by
      // definition. Covers both paths out of this branch.
      scheduleCwdRefresh(instance!);
      const m = lineTracked ? CD_FAV_RE.exec(lineBuffer.trim()) : null;
      const fav = m ? favoriteByIndex(Number(m[1])) : undefined;
      const typedLen = lineBuffer.length;
      lineBuffer = "";
      lineTracked = true;
      if (m && fav) {
        // Erase the echoed `cd fav-N` from the shell's input line, then submit
        // the expansion. A real directory literally named `fav-N` in the cwd
        // wins: the expansion tries it first and only falls back to the
        // favorite path when that cd fails.
        //
        // Erase with backspaces (DEL, \x7f) rather than Ctrl-U (\x15): PowerShell
        // (the Windows default) doesn't kill the input line on \x15, which left
        // the typed text prepended to the expansion and broke the command. The
        // cursor is at end (the mirror only tracks plain typing), so one DEL per
        // typed char clears the line on every shell.
        const dir = `fav-${m[1]}`;
        writePty(ptyId, "\x7f".repeat(typedLen));
        writePty(ptyId, `${cdFavCommand(dir, fav.path)}\r`);
        return;
      }
      writePty(ptyId, data);
      return;
    }

    const next = foldInput(lineBuffer, lineTracked, data);
    lineBuffer = next.buffer;
    lineTracked = next.tracked;
    writePty(ptyId, data);
  });

  // Wire resize
  term.onResize(({ cols, rows }) => {
    if (instance!.ptyId !== null) {
      resizePty(instance!.ptyId, cols, rows);
    }
  });

  // Title is wired once in createTerminalInstance (cached on the instance and
  // forwarded to the current pane), so nothing to wire here.

  // ResizeObserver
  let fitTimeout: number | null = null;
  let lastW = 0, lastH = 0;
  instance.resizeObserver = new ResizeObserver((entries) => {
    const { width, height } = entries[0].contentRect;
    if (width === lastW && height === lastH) return;
    lastW = width;
    lastH = height;
    if (fitTimeout) cancelAnimationFrame(fitTimeout);
    fitTimeout = requestAnimationFrame(() => safeFit(term, fitAddon));
  });
  instance.resizeObserver.observe(container);

  term.focus();
}

export function detachTerminal(paneId: string) {
  const instance = instances.get(paneId);
  if (!instance) return;

  // Just disconnect the resize observer — don't kill anything
  instance.resizeObserver?.disconnect();
  instance.resizeObserver = null;
  instance.detachSelection?.();
  instance.detachSelection = null;
}

export function destroyTerminal(paneId: string) {
  const instance = instances.get(paneId);
  if (!instance) return;

  instance.disposed = true;
  instance.resizeObserver?.disconnect();
  instance.detachSelection?.();
  instance.detachSelection = null;
  instance.unlistenOutput?.();
  instance.unlistenExit?.();
  if (instance.ptyId !== null) {
    killPty(instance.ptyId);
  }
  instance.term.dispose();
  instances.delete(paneId);
}
