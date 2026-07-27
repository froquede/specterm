import { createSignal } from "solid-js";
import { Terminal } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import {
  spawnPty,
  writePty,
  resizePty,
  killPty,
  adoptPty,
  onPtyOutput,
  onPtyExit,
} from "./pty";
import { startupPath } from "../stores/settings";
import { os } from "./platform";
import { registerOscHandler } from "./osc";
import { favoriteByIndex } from "../stores/favorites";
import { themeToXterm, DEFAULT_THEME } from "./theme";
import { installClickVsDragSelection } from "./mouse-selection";
import { publishStoreChange, registerStoreSync } from "./store-sync";
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
  publishStoreChange("terminal-font");
}

// Swap the font on every open terminal and refit — glyph metrics change the
// column/row count — mirroring applyFontSize.
function applyFontFamily() {
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

// `family` is a bare family name (e.g. "Menlo") or "" to restore the default.
export function setTerminalFontFamily(family: string) {
  setTerminalFontFamilySignal(family);
  persistFontFamily();
  applyFontFamily();
}

// The font family is a preference, so it follows the user across windows.
// Font *zoom* (⌘=/⌘-/⌘0) deliberately does not: it's a per-view control, like a
// browser's zoom, and yanking every window's size because one was zoomed in
// would be surprising.
registerStoreSync("terminal-font", () => {
  setTerminalFontFamilySignal(loadFontFamily());
  applyFontFamily();
});

export function getTerminalInstance(paneId: string): TerminalInstance | undefined {
  return instances.get(paneId);
}

// --- moving a terminal between windows ------------------------------------
// A terminal can't cross a process boundary, but its PTY can change owner and
// its screen can be replayed. So a tear-off ships two things per pane — the PTY
// id and a serialized copy of the buffer — and the destination window rebuilds
// a terminal around them instead of spawning a shell.

export interface TerminalAdoption {
  ptyId: number;
  scrollback: string;
  title: string;
}

// Panes that will adopt a PTY the moment they mount, keyed by their (new) pane
// id. Filled by the store while it rebuilds a transferred tab, drained by
// attachTerminal below.
const pendingAdoptions = new Map<string, TerminalAdoption>();

export function registerAdoption(paneId: string, adoption: TerminalAdoption) {
  pendingAdoptions.set(paneId, adoption);
}

function takeAdoption(paneId: string): TerminalAdoption | undefined {
  const adoption = pendingAdoptions.get(paneId);
  pendingAdoptions.delete(paneId);
  return adoption;
}

// Snapshot a terminal's screen + scrollback as the escape sequences that
// reproduce it, so the window adopting this PTY doesn't start from a blank
// screen. Colors and attributes survive; the internal state of a full-screen
// program does not — vim or htop redraw themselves on the adopting window's
// first resize, which is the same thing that happens on any terminal resize.
export function serializeTerminal(paneId: string): string {
  const instance = instances.get(paneId);
  if (!instance || instance.disposed) return "";
  const addon = new SerializeAddon();
  try {
    instance.term.loadAddon(addon);
    return addon.serialize();
  } catch {
    // Serialization failed — hand over a live PTY with no history rather than
    // failing the whole move.
    return "";
  } finally {
    addon.dispose();
  }
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
    const q = (p: string) => `'${p.replace(/'/g, "''")}'`;
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

export async function createTerminalInstance(
  paneId: string,
  opts?: {
    onTitle?: (title: string) => void;
    onExit?: () => void;
    onOpenMarkdown?: (path: string, mode: "split" | "tab") => void;
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
  };

  instances.set(paneId, instance);

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

  // A pane created by a tear-off adopts a PTY that is already running rather
  // than spawning a shell. Three things have to reach the screen in order — the
  // serialized buffer, then whatever the process printed while it had no window,
  // then live output — so `gate` parks live chunks until the replay is done.
  // Without it, output arriving during the adopt round-trip would land ahead of
  // the bytes it came after.
  const adoption = takeAdoption(paneId);
  let gate: Uint8Array[] | null = adoption ? [] : null;

  if (adoption) {
    instance.ptyId = adoption.ptyId;
    instance.title = adoption.title;
    instance.onTitle?.(adoption.title);
    if (adoption.scrollback) term.write(adoption.scrollback);
  } else {
    // Spawn PTY. The configured startup directory (Settings) is passed through
    // as cwd; blank → undefined, and the main process falls back to the OS home.
    // A stale/deleted path is guarded main-side so spawning can't crash.
    instance.ptyId = await spawnPty({
      cols: term.cols,
      rows: term.rows,
      cwd: startupPath() || undefined,
    });
  }

  // Wire output
  instance.unlistenOutput = await onPtyOutput((id, data) => {
    if (id !== instance!.ptyId) return;
    if (gate) gate.push(data);
    else term.write(data);
  });

  // Wire exit
  instance.unlistenExit = await onPtyExit((id) => {
    if (id === instance!.ptyId) {
      term.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n");
      opts?.onExit?.();
    }
  });

  // Claim the adopted PTY now that this terminal can receive from it, then drain
  // in order: buffered-while-orphaned, then anything held by the gate.
  if (adoption) {
    let exited = false;
    try {
      const result = await adoptPty(adoption.ptyId, term.cols, term.rows);
      if (result.buffered.length) term.write(result.buffered);
      exited = result.exited;
    } catch (err) {
      // The host couldn't hand the PTY over. Say so in the pane rather than
      // leaving a terminal that silently swallows every keystroke.
      console.warn("[terminal] adopting pty failed:", err);
      exited = true;
    } finally {
      const held = gate ?? [];
      gate = null;
      for (const chunk of held) term.write(chunk);
    }
    // The process died mid-move: its exit event went to a window that had
    // already let go, so nothing else will report it.
    if (exited) {
      term.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n");
      opts?.onExit?.();
    }
  }

  // Wire input. A mirrored line buffer lets us expand `cd fav-N` into a real
  // `cd <path>` at the moment Enter is pressed (see foldInput above).
  let lineBuffer = "";
  let lineTracked = true;
  term.onData((data) => {
    if (instance!.ptyId === null) return;
    const ptyId = instance!.ptyId;

    // Enter — try to expand the line before it reaches the shell.
    if (data === "\r" || data === "\n") {
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

// Tear down this window's side of a terminal while leaving its PTY running —
// the departure half of a tear-off. Everything destroyTerminal does except the
// kill: the shell survives, and the window that adopts the PTY builds a fresh
// terminal around it.
export function releaseTerminal(paneId: string) {
  const instance = instances.get(paneId);
  if (!instance) return;

  instance.disposed = true;
  instance.resizeObserver?.disconnect();
  instance.detachSelection?.();
  instance.detachSelection = null;
  instance.unlistenOutput?.();
  instance.unlistenExit?.();
  instance.term.dispose();
  instances.delete(paneId);
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
