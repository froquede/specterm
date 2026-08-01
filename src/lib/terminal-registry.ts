import { createSignal } from "solid-js";
import { Terminal } from "@xterm/xterm";
import type { ITheme, IBuffer } from "@xterm/xterm";
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
  ptyCwd,
} from "./pty";
import { startupPath } from "../stores/settings";
import { os } from "./platform";
import {
  registerOscHandler,
  registerCwdHandler,
  registerAttentionHandler,
  registerNotificationHandler,
} from "./osc";
import { noteOutput, noteInput, forgetPane } from "./claude-attention";
import { markAttention, clearAttention } from "../stores/attention";
import { claudeAttentionMode } from "../stores/settings";
import { favoriteByIndex } from "../stores/favorites";
import { themeToXterm, DEFAULT_THEME } from "./theme";
import { installClickVsDragSelection } from "./mouse-selection";
import { publishStoreChange, registerStoreSync } from "./store-sync";
import { cancelPendingRestore, takePendingRestore } from "./session-restore";
import type { UnlistenFn } from "../backends/types";
import type { SessionMeta } from "../types";

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

  // Repaint everything, now, in this tick.
  //
  // Resizing the WebGL canvas wipes its drawing buffer — that is what a GL
  // context does when its backing store changes size — and xterm does not
  // redraw until its next animation frame. So between the fit and that frame
  // the terminal is *blank*, and a divider drag refits on every frame it moves
  // through: measured with frames captured every 40ms through one drag, two in
  // every three showed both panes completely empty. It reads as the terminal
  // tearing itself apart while you resize it, and it has nothing to do with
  // whatever program happens to be running in the pane — an idle shell blanks
  // exactly the same way.
  //
  // Marking every row dirty closes the gap: the fit and the repaint land
  // together, so there is no frame in which the canvas has been cleared and not
  // yet drawn. Same call the WebGL context-loss recovery below uses, for the
  // same reason.
  try {
    term.refresh(0, term.rows - 1);
  } catch {
    // Terminal disposed between the fit and the repaint — nothing to draw.
  }
}

// Watch a pane's box and refit the terminal in it, at most once per throttle
// window while the size keeps changing.
//
// Refitting per animation frame is what a drag would otherwise do, and every
// fit that changes the grid resizes the WebGL canvas — which discards its
// drawing buffer, leaving the terminal blank until xterm's next frame paints it
// back. Dozens of those in one drag is the flicker. Fitting on the same clock
// the pty is told on cuts the number of times that can happen to a handful, and
// between them the pane simply shows the grid it already had: slightly behind
// the divider for a few tens of milliseconds, but never empty.
function observeResize(
  term: Terminal,
  fitAddon: FitAddon,
  instance: TerminalInstance
): ResizeObserver {
  let timer: number | null = null;
  let lastFitAt = 0;
  let lastW = 0;
  let lastH = 0;

  const run = () => {
    timer = null;
    lastFitAt = Date.now();
    if (instance.disposed) return;
    safeFit(term, fitAddon);
  };

  return new ResizeObserver((entries) => {
    const { width, height } = entries[0].contentRect;
    if (width === lastW && height === lastH) return;
    lastW = width;
    lastH = height;
    if (timer !== null) return;

    const since = Date.now() - lastFitAt;
    if (since >= PTY_RESIZE_THROTTLE_MS) run();
    else timer = window.setTimeout(run, PTY_RESIZE_THROTTLE_MS - since);
  });
}

// Re-sync the DOM scrollbar to xterm's logical scroll position after a re-attach.
// Switching tabs disposes and recreates the pane (SplitContainer keys panes by
// leaf id), so the terminal element is moved into a new container. That move
// resets the `.xterm-viewport` element's scrollTop to 0, while xterm's own
// viewportY (which drives what it renders) is preserved — leaving the scrollbar
// pinned at the top over correctly-rendered bottom content, and the next scroll
// snaps to the top. xterm's scrollToBottom/scrollToLine can't fix it: the delta
// from the preserved viewportY is zero, so they no-op without touching the DOM.
// Drive the DOM scrollTop directly instead; the resulting scroll event makes
// xterm re-sync and repaint. Read from the live buffer (viewportY survives the
// move), so there is no captured state to keep in step. Runs after the fit so
// the moved element has been measured and scrollHeight is valid.
function syncViewportScroll(instance: TerminalInstance) {
  const viewport =
    instance.container?.querySelector<HTMLElement>(".xterm-viewport");
  if (!viewport) return;
  const term = instance.term;
  const buffer = term.buffer.active;
  const totalRows = buffer.baseY + term.rows;
  // At the bottom (or nothing to scroll): pin to the end so a live terminal
  // keeps its prompt in view. Otherwise map the logical top row back to a pixel
  // offset via the measured row height (scrollHeight covers baseY + rows).
  if (buffer.viewportY >= buffer.baseY || totalRows <= term.rows) {
    viewport.scrollTop = viewport.scrollHeight;
  } else {
    const cellHeight = viewport.scrollHeight / totalRows;
    viewport.scrollTop = Math.round(buffer.viewportY * cellHeight);
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
  // Set on a pane revived from a saved session, and cleared by the first title
  // the new shell reports. See the onTitleChange handler for why that first
  // report is swallowed rather than applied.
  titleRestored: boolean;
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
  // The resumable session a provider last recognized in this pane, if any (see
  // lib/session-providers). Sticky on purpose: it's captured opportunistically
  // while the process runs, and the moment it matters — the pane is closing, or
  // the app is quitting — that process may already be gone. Cleared only when a
  // provider positively identifies a *different* session in the same pane.
  sessionMeta: SessionMeta | undefined;
}

// Smallest gap between two resizes handed down to a pty. A drag produces a new
// size every animation frame; at this rate a full-screen program still tracks
// the pane as it moves, for about a fifth of the signals. See the resize wiring
// in attachTerminal for why this is a throttle and not a debounce.
const PTY_RESIZE_THROTTLE_MS = 55;

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

// --- reviving a terminal across a restart ----------------------------------
// The restore twin of an adoption, and the difference between them is the whole
// point: an adopted pane inherits a PTY that is still running, so its screen is
// replayed only to avoid a blank window. A *revived* pane inherits a screen whose
// process is gone — the app quit and took every shell with it — so the replay is
// all there is, and a brand new shell starts underneath it.
//
// Both halves of what the tree can't carry travel here: the screen, and the name
// the shell had given the pane. Registered by the store as it hydrates the saved
// session (stores/tabs.ts), claimed on the pane's first attach.

export interface TerminalRevival {
  /**
   * Fetches this pane's serialized screen + scrollback. Absent for a pane whose
   * screen wasn't kept.
   *
   * A *thunk*, not a promise, and that is load-bearing: the screens live in a file
   * the host owns (see lib/session-screens.ts), and nothing reads it until a pane
   * mounts and calls this. Handing out a promise instead started the read during
   * hydration, where a couple of megabytes crossing IPC competed with the first
   * paint — ~100ms of it, measured, on a restored 8-tab session. By the time this
   * is called the terminal is open, its canvas exists and the shell has spawned;
   * the replay is gated behind live output, so it can arrive late safely.
   */
  screen?: () => Promise<string>;
  /** The shell's last OSC title, if the snapshot had one. */
  title?: string;
}

const pendingRevivals = new Map<string, TerminalRevival>();

export function registerRevival(paneId: string, revival: TerminalRevival) {
  pendingRevivals.set(paneId, revival);
}

function takeRevival(paneId: string): TerminalRevival | undefined {
  const revival = pendingRevivals.get(paneId);
  pendingRevivals.delete(paneId);
  return revival;
}

/** Drop a pane's pending revival without using it (the pane went away). */
export function cancelRevival(paneId: string) {
  pendingRevivals.delete(paneId);
}

// Drawn between a replayed screen and the shell that starts under it. Without a
// line saying so, a revived pane reads as a live session: it ends in a prompt
// with your last command above it, and nothing on screen distinguishes the shell
// that printed all of that (dead, since the app quit) from the one now waiting
// for input. Dim, one line, and it scrolls away like any other output.
const REVIVED_MARKER = "\r\n\x1b[90m──── restored ────\x1b[0m\r\n";

// Snapshot a terminal's screen + scrollback as the escape sequences that
// reproduce it, so the window adopting this PTY doesn't start from a blank
// screen. Colors and attributes survive; the internal state of a full-screen
// program does not — vim or htop redraw themselves on the adopting window's
// first resize, which is the same thing that happens on any terminal resize.
//
// Async because of the flush. `term.write` is queued, not immediate: bytes that
// have already arrived from the host may still be sitting unparsed when a
// tear-off asks for the snapshot. Serializing then would miss exactly those —
// and they'd be missing from the host's transit buffer too, since the host had
// already sent them — so they'd be gone for good. Writing an empty chunk and
// waiting for its callback drains everything queued ahead of it first.
export async function serializeTerminal(paneId: string): Promise<string> {
  const instance = instances.get(paneId);
  if (!instance || instance.disposed) return "";
  try {
    await new Promise<void>((resolve) => instance.term.write("", resolve));
  } catch {
    // Terminal disposed mid-flush — fall through and serialize what's there.
  }
  if (instance.disposed) return "";
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

/**
 * The same snapshot, taken synchronously and bounded — what session restore saves
 * when the window is closing.
 *
 * Three things differ from serializeTerminal above, and each is a consequence of
 * this copy outliving the process that produced it:
 *
 *   - **No flush.** The one caller runs inside `beforeunload`, where nothing
 *     asynchronous is guaranteed to finish. Bytes still queued in xterm's write
 *     buffer are lost; they're the last few of an idle pane, and the alternative
 *     is losing the whole screen.
 *   - **No alternate buffer.** If the pane is sitting in vim or htop, that program
 *     will not be running after the restart. Replaying its frozen screen would
 *     paint a full-screen app that answers no keys; the normal buffer underneath
 *     — the shell scrollback — is the honest thing to bring back.
 *   - **No modes.** The mode block re-asserts things like mouse tracking and
 *     bracketed paste on behalf of the program that set them. Replaying
 *     `?1002h` from a dead htop would leave the *new* shell reporting every mouse
 *     move as input. The new shell sets its own modes.
 *
 * `scrollback` bounds how many rows above the viewport are included, so the
 * caller can trade history for bytes (see lib/session-screens.ts).
 */
export function serializeTerminalSync(
  paneId: string,
  scrollback: number
): string {
  const instance = instances.get(paneId);
  if (!instance || instance.disposed) return "";
  const addon = new SerializeAddon();
  try {
    instance.term.loadAddon(addon);
    return addon.serialize({
      scrollback,
      excludeAltBuffer: true,
      excludeModes: true,
    });
  } catch {
    // Serialization failed — this pane restores empty rather than taking the
    // rest of the session's screens down with it.
    return "";
  } finally {
    addon.dispose();
  }
}

// Claude Code marks its composer input line with a ❯ (U+276F) caret glyph, then
// a non-breaking space, then the text. It hides the real terminal cursor and
// paints its own, so we can't anchor on buf.cursorY — we find the marker line
// instead. The statusline below the composer is a horizontal rule of ─ (U+2500).
const PROMPT_MARKER = "❯";
const COMPOSER_RULE_RE = /^─{5,}/;

function bufferLineText(buf: IBuffer, row: number): string {
  return buf.getLine(row)?.translateToString(true) ?? "";
}

// Locate the composer: the lowest ❯ marker line in the viewport, extended down
// over continuation rows (Shift+Enter wraps the message onto more lines) until
// the statusline rule or a blank row closes it. Null when no composer is on
// screen (a plain shell prompt).
function findComposer(
  buf: IBuffer,
  viewTop: number,
  viewBottom: number
): { top: number; bottom: number } | null {
  let top = -1;
  for (let r = viewBottom; r >= viewTop; r--) {
    if (bufferLineText(buf, r).trimStart().startsWith(PROMPT_MARKER)) {
      top = r;
      break;
    }
  }
  if (top === -1) return null;
  let bottom = top;
  for (let r = top + 1; r <= viewBottom; r++) {
    const t = bufferLineText(buf, r).trim();
    if (t === "" || COMPOSER_RULE_RE.test(t)) break;
    bottom = r;
  }
  return { top, bottom };
}

// Pull the typed text out of the composer rows: strip the ❯ marker (and the
// non-breaking space that trails it) from the first row, and the two-space
// alignment continuation rows carry under it. Heuristic — tuned to Claude Code —
// so exotic indentation may not survive exactly, but the message body does.
function extractComposerText(buf: IBuffer, top: number, bottom: number): string {
  const rows: string[] = [];
  for (let r = top; r <= bottom; r++) {
    let s = bufferLineText(buf, r);
    s =
      r === top
        // Strip the ❯ marker plus the whitespace/non-breaking-space around it.
        // NBSP (U+00A0) is spelled out because \s doesn't match it everywhere.
        ? s.replace(/^[\s ]*❯[\s ]*/, "")
        : s.replace(/^ {0,2}/, ""); // continuation alignment
    rows.push(s.replace(/\s+$/, ""));
  }
  return rows.join("\n").replace(/\s+$/, "");
}

// Fall back to the logical line at the cursor (following soft-wrap) when there's
// no composer on screen — keeps the shortcut useful at a plain shell prompt.
function currentLogicalLine(buf: IBuffer, cursorRow: number): { top: number; bottom: number } {
  let top = cursorRow;
  while (top > 0 && buf.getLine(top)?.isWrapped) top--;
  let bottom = cursorRow;
  while (bottom < buf.length - 1 && buf.getLine(bottom + 1)?.isWrapped) bottom++;
  return { top, bottom };
}

// Select the active pane's input area and return its text for the clipboard.
// Prefers the Claude Code composer (the intended target); at a bare shell prompt
// it degrades to the cursor's logical line. Bound to Cmd/Ctrl+Shift+A (see
// keymap) as a scoped alternative to selecting the whole scrollback.
export function selectComposerText(paneId: string): string | null {
  const inst = instances.get(paneId);
  if (!inst || inst.disposed) return null;
  const { term } = inst;
  const buf = term.buffer.active;
  const viewTop = buf.baseY;
  const viewBottom = buf.baseY + term.rows - 1;

  const composer = findComposer(buf, viewTop, viewBottom);
  const region =
    composer ?? currentLogicalLine(buf, buf.baseY + buf.cursorY);

  term.clearSelection();
  term.selectLines(region.top, region.bottom);
  term.focus();

  const text = composer
    ? extractComposerText(buf, region.top, region.bottom)
    : term.getSelection();
  return text.trim() ? text : null;
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

// A mouse report on its way to a program that grabbed the mouse — SGR
// (`\x1b[<0;12;3M`) or the older X10 form (`\x1b[M...`). xterm sends these down
// the same onData channel as typing, so anything that means "the user answered"
// has to tell them apart.
const MOUSE_REPORT = /^\x1b\[(<|M)/;

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

/**
 * Is a full-screen program in control of this pane?
 *
 * The alternate screen buffer is the standard signal: htop, vim, less and mc all
 * switch to it on entry (`?1049h`) and back on exit, which is exactly what makes
 * them "the program that owns the keyboard right now". Bare-key shortcuts check
 * this and stand down while it's true, so F2 opens the tab rename at a shell
 * prompt and still reaches htop's Setup inside htop.
 */
export function paneRunsFullscreenApp(paneId: string): boolean {
  const instance = instances.get(paneId);
  if (!instance || instance.disposed) return false;
  return instance.term.buffer.active.type === "alternate";
}

/** Record (or clear) the resumable session a provider found in a pane. */
export function setSessionMeta(paneId: string, meta: SessionMeta | undefined) {
  const instance = instances.get(paneId);
  if (instance) instance.sessionMeta = meta;
}

/** Every live terminal pane, for the pollers that inspect running processes. */
export function livePaneIds(): string[] {
  return [...instances.entries()]
    .filter(([, i]) => !i.disposed && i.ptyId !== null)
    .map(([id]) => id);
}

/** The pty backing a pane, or null when it hasn't spawned (or has exited). */
export function getPanePtyId(paneId: string): number | null {
  const instance = instances.get(paneId);
  return instance && !instance.disposed ? instance.ptyId : null;
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
    titleRestored: false,
    sessionMeta: undefined,
  };

  instances.set(paneId, instance);

  // The exact "I'm waiting on you" signal, written into this pane by the Claude
  // Code hooks (lib/claude-hooks.ts) when they're installed. Always registered:
  // the sequence only ever arrives if the user installed the hooks, and honoring
  // it costs nothing until then. The mode check is here rather than at the hook,
  // so switching the feature off stops the flags without touching ~/.claude.
  registerAttentionHandler(term, (kind) => {
    if (claudeAttentionMode() === "off") return;
    markAttention(paneId, kind);
  });

  // The terminal bell — how a program of any kind asks to be looked at. Claude
  // Code rings it when its notification channel is terminal_bell, and so does a
  // long build that ends with `\a`; both are the same request.
  term.onBell(() => {
    if (claudeAttentionMode() === "off") return;
    markAttention(paneId, "bell");
  });

  // The standard desktop-notification sequences (OSC 9/777/99, see lib/osc.ts).
  // Same request as the bell, with something to say — so it follows the bell's
  // rule exactly and is honored in both non-off modes. That is deliberate:
  // these need no hooks and no configuration, so gating them behind the *how
  // Claude is detected* setting would switch off a signal that has nothing to
  // do with Claude.
  registerNotificationHandler(term, (text) => {
    if (claudeAttentionMode() === "off") return;
    markAttention(paneId, "notify", text);
  });

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
    // A revived pane opens with the name it had when the app closed, and then the
    // shell that just started under it announces its own title within a beat —
    // `user@host: ~/proj`, derived from nothing the user did. Applying that would
    // wipe the restored name before it had been on screen long enough to read,
    // which is what made restored tabs look like they came back unnamed.
    //
    // So exactly one title is swallowed: the boot shell's first. Every one after
    // it is a real event — a `cd`, a `/rename`, a program setting its own name —
    // and goes through normally.
    if (instance.titleRestored) {
      instance.titleRestored = false;
      return;
    }
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

  // A pane restored from a saved session claims its screen and its name here,
  // before anything is drawn or pushed to the title bar. Only a first attach can
  // have one — the early-return paths below both require a container this
  // instance has already been opened in, and a revival is registered once, at
  // hydration, for a pane that has never mounted.
  const revival = takeRevival(paneId);
  if (revival?.title) {
    instance.title = revival.title;
    instance.titleRestored = true;
  }

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
    syncViewportScroll(instance);
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
    instance.resizeObserver = observeResize(term, fitAddon, instance);
    instance.resizeObserver.observe(container);

    safeFit(term, fitAddon);
    syncViewportScroll(instance);
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
  // A revived pane is filled in from a file the host is still reading, so its
  // shell can be spawned and its prompt can arrive before the replay is in hand.
  // Same gate as an adoption, for the same reason: the replayed screen has to land
  // *before* anything live, or the new shell's prompt ends up above the history it
  // came after.
  const pendingScreen = revival?.screen;
  let gate: Uint8Array[] | null = adoption || pendingScreen ? [] : null;

  if (adoption) {
    instance.ptyId = adoption.ptyId;
    instance.title = adoption.title;
    instance.onTitle?.(adoption.title);
    if (adoption.scrollback) term.write(adoption.scrollback);
  } else {
    // Spawn PTY. instance.cwd is the directory inherited from the pane this one
    // was split from, or the configured startup directory (Settings) for the
    // boot terminal; blank → undefined, and the main process falls back to the
    // OS home. A stale/deleted path is guarded main-side so spawning can't
    // crash.
    instance.ptyId = await spawnPty({
      cols: term.cols,
      rows: term.rows,
      cwd: instance.cwd || undefined,
    });
  }

  // The spawn directory is only the starting point — from here the value has to
  // track the user's `cd`s, or a split taken an hour later would still inherit
  // where the shell began. Read it back once now so a shell rc that cds on
  // startup is reflected too. An adopted shell needs it more than a spawned one:
  // this window never saw where that shell has been, so its only directory is
  // whatever the process itself reports.
  refreshCwd(instance);

  // Wire output. A restored pane owes its shell a resume command that can only
  // be sent once there's a prompt to send it to, so its first chunk of output
  // doubles as the "shell is ready" signal — but only that pane pays for the
  // check: the branch is resolved once, here, not per chunk. Every other pane
  // (which is nearly all of them) gets the bare writer.
  //
  // Every chunk is also timed by the attention heuristic (lib/claude-attention),
  // which reads nothing from the data — only when it arrived — to spot a pane
  // that was working and has gone quiet.
  const onShellReady = takePendingRestore(paneId, instance.ptyId);
  const writeChunk = onShellReady
    ? (data: Uint8Array) => {
        term.write(data);
        noteOutput(paneId);
        onShellReady();
      }
    : (data: Uint8Array) => {
        term.write(data);
        noteOutput(paneId);
      };

  instance.unlistenOutput = await onPtyOutput((id, data) => {
    if (id !== instance!.ptyId) return;
    if (gate) gate.push(data);
    else writeChunk(data);
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
      for (const chunk of held) writeChunk(chunk);
    }
    // The process died mid-move: its exit event went to a window that had
    // already let go, so nothing else will report it.
    if (exited) {
      term.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n");
      opts?.onExit?.();
    }
  } else if (pendingScreen) {
    // Replay the screen this pane had when the app last closed, then let the new
    // shell's own output through behind it. The marker sits between the two
    // because the shell underneath genuinely is new — the one that printed
    // everything above died with the app.
    try {
      const screen = await pendingScreen();
      if (screen) {
        term.write(screen);
        term.write(REVIVED_MARKER);
      }
    } catch {
      // No screen to be had — the pane just opens on a fresh prompt.
    } finally {
      const held = gate ?? [];
      gate = null;
      for (const chunk of held) writeChunk(chunk);
    }
  }

  // Wire input. A mirrored line buffer lets us expand `cd fav-N` into a real
  // `cd <path>` at the moment Enter is pressed (see foldInput above).
  let lineBuffer = "";
  let lineTracked = true;
  term.onData((data) => {
    if (instance!.ptyId === null) return;
    const ptyId = instance!.ptyId;

    // Typing into a waiting pane *is* the answer it was waiting for. Clearing
    // here (rather than only on focus) covers answering a prompt in a split you
    // never made active. Mouse reports come down this same channel from a pane
    // whose program grabbed the mouse, and moving the pointer over a pane
    // answers nothing — a real click focuses it, which clears it anyway.
    if (!MOUSE_REPORT.test(data)) noteInput(paneId);

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

  // Wire resize.
  //
  // xterm refits on every frame of a divider drag, which is right — the grid
  // should track the pane under the cursor. Handing every one of those to the
  // pty is not: each is an ioctl and a SIGWINCH, and a program that repaints on
  // SIGWINCH (vim, htop, an agent's TUI) redraws for every intermediate width
  // the divider passed through. Measured on one 300px drag: 56 resizes across
  // the two panes, 55 of them a size that was never final.
  //
  // Throttled, not debounced. Debouncing looks tidier — tell the child once,
  // when the size is final — but it is wrong for exactly the programs this
  // matters to. A full-screen program draws into the alternate screen buffer,
  // which xterm *clears* on resize rather than reflowing; a child not told
  // until the drag ends therefore spends the whole drag showing nothing.
  // Throttling keeps it repainting all the way through, for a fraction of the
  // signals.
  //
  // Leading edge, so an isolated resize is instant; trailing edge, so the size
  // the drag ended on is always the last one sent.
  let resizeTimer: number | null = null;
  let pendingSize: { cols: number; rows: number } | null = null;
  let lastSentAt = 0;
  let lastSent: string | null = null;
  let lastCols = 0;
  let lastRows = 0;

  const sendSize = (cols: number, rows: number) => {
    // A trailing send can outlive the pane it belongs to — one closed mid-drag,
    // or a tab torn off into another window. `disposed` catches a terminal
    // already torn down, `ptyId` one whose shell has gone or been handed over.
    if (instance!.disposed || instance!.ptyId === null) return;
    const key = `${cols}x${rows}`;
    if (key === lastSent) return;
    lastSent = key;
    lastSentAt = Date.now();
    lastCols = cols;
    lastRows = rows;
    resizePty(instance!.ptyId, cols, rows);
  };

  term.onResize(({ cols, rows }) => {
    if (instance!.ptyId === null) return;

    // A shrink is never withheld. Growing is safe to delay — a program still
    // drawing at the old, smaller size just leaves margin. Shrinking is not: it
    // keeps writing rows wider than the grid, every one of them wraps, and what
    // was a neat frame becomes several times its own height. That is what a
    // full-screen program "going enormous" mid-drag actually is, and repainting
    // does not fix it: the program is drawing the wrong thing, because it has
    // not been told the screen got smaller.
    if (cols < lastCols || rows < lastRows) {
      if (resizeTimer !== null) {
        clearTimeout(resizeTimer);
        resizeTimer = null;
      }
      pendingSize = null;
      sendSize(cols, rows);
      return;
    }

    const since = Date.now() - lastSentAt;
    if (since >= PTY_RESIZE_THROTTLE_MS && resizeTimer === null) {
      sendSize(cols, rows);
      return;
    }

    pendingSize = { cols, rows };
    if (resizeTimer !== null) return;
    resizeTimer = window.setTimeout(
      () => {
        resizeTimer = null;
        if (pendingSize) {
          sendSize(pendingSize.cols, pendingSize.rows);
          pendingSize = null;
        }
      },
      Math.max(0, PTY_RESIZE_THROTTLE_MS - since)
    );
  });

  // Title is wired once in createTerminalInstance (cached on the instance and
  // forwarded to the current pane), so nothing to wire here.

  instance.resizeObserver = observeResize(term, fitAddon, instance);
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
  // Everything destroyTerminal drops for a pane that stops existing applies
  // here too — this pane is leaving the window, and none of it means anything
  // once it has. Only the kill is different: the shell is being handed on, and
  // the pty id is what the destination window adopts.
  cancelPendingRestore(paneId);
  cancelRevival(paneId);
  clearAttention(paneId);
  forgetPane(paneId);

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
  // A pane closed before it ever mounted still has its resume command and its
  // restored screen queued — drop both, or the maps hold entries (and, for the
  // screen, a few hundred kilobytes) for a pane that no longer exists.
  cancelPendingRestore(paneId);
  cancelRevival(paneId);

  // A pane that was waiting on the user has just stopped existing — the flag
  // and the timer behind it go with it.
  clearAttention(paneId);
  forgetPane(paneId);

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
