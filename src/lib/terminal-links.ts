// Clicking a path or a link in terminal output puts it on the clipboard.
//
// The path you want is almost never the thing you can grab: it sits inside a
// stack trace, an `ls` listing or a sentence an agent wrote, and getting it out
// meant dragging across a monospace grid without catching the space before it
// or the period after. So paths get the treatment URLs had — hover underlines
// them, a click copies.
//
// Copy, not open, because copy is what the click is nearly always for: the path
// goes into the next command, into a message, into an editor. Ctrl/⌘+click is
// the modifier every browser already uses for "do the other thing", and here it
// opens: a URL in the browser, a file Specterm can display in a pane beside
// this one, anything else in whatever application the OS gives it, and a
// directory in the file manager.
//
// # Why this doesn't use xterm's linkifier
//
// xterm has a link-provider API, and it was the obvious way to do this. It
// caches provider replies per *line number* and only invalidates them when the
// pointer moves to a different line, or when a render touches a line it already
// found a link on (Linkifier._handleHover / _handleNewLink). A pane where a
// program redraws the same rows in place — which is every TUI, and Claude Code
// most of all — breaks both assumptions: rest the pointer on a row with no link
// in it, let the program redraw that row, and the cached "nothing here" answers
// for whatever is drawn there next. The link never appears until the pointer
// crosses onto another row.
//
// That is the pane this feature exists for, so hovering and clicking are done
// here instead: hover is recomputed from the buffer whenever the pointer moves
// to a new cell *or the pane redraws*, which is the invalidation the cache is
// missing. Matching itself is lib/path-links.ts, which stays DOM-free so the
// guessing can be tested directly.

import type { Terminal } from "@xterm/xterm";
import { findPathLinks, lineSuffixOf, opensInSpecterm, resolveMatchedPath } from "./path-links";
import { homeDir, locatePath, type LocateContext } from "./path-locate";
import { clipboardWriteText } from "./pty";
import { getBackend } from "../backends";
import { os } from "./platform";

// How far the wrap walk will travel from the hovered row. A path can wrap once
// or twice; a run of rows longer than this is a paragraph, and rebuilding it on
// every redraw would cost more than the link is worth.
const MAX_WRAP_ROWS = 8;

// Ceiling on how often a redraw or a scroll can make the layer re-read the
// hovered line. A busy TUI renders far faster than a hand can move.
const REFRESH_THROTTLE_MS = 80;

// How much of the logical line around the hovered character is handed to the
// matcher. findPathLinks retries its patterns from every position of an
// unbroken run, so a soft-wrapped JWT or hex dump costs quadratically — ~50ms
// for 3,400 characters, on every refresh. A path longer than this on either
// side of the pointer is not one anybody clicks.
const MATCH_WINDOW = 256;

interface MappedLine {
  // The logical line as a string, soft wraps stitched back together.
  text: string;
  // Buffer coordinates of each character in `text`. Kept as a parallel array
  // rather than computed, because a wide char (CJK, an emoji) is two cells for
  // one character and a combining mark is two characters in one cell — so
  // string index and column drift apart the moment output isn't ASCII.
  cells: { y: number; x: number }[];
}

/** What the pointer is currently over, in buffer coordinates. */
interface HoverTarget {
  text: string;
  kind: "path" | "url";
  // One entry per buffer row the span covers, so a soft-wrapped path draws as
  // two underlines rather than one impossible rectangle.
  segments: { y: number; x0: number; x1: number }[];
}

/**
 * Rebuild the logical line that passes through buffer row `rowIndex`, following
 * soft wraps in both directions, along with the map back to buffer cells.
 */
function mapLogicalLine(term: Terminal, rowIndex: number): MappedLine | null {
  const buf = term.buffer.active;
  if (rowIndex < 0 || !buf.getLine(rowIndex)) return null;

  let top = rowIndex;
  while (top > 0 && buf.getLine(top)?.isWrapped && rowIndex - top < MAX_WRAP_ROWS) {
    top--;
  }
  let bottom = rowIndex;
  while (
    bottom + 1 < buf.length &&
    buf.getLine(bottom + 1)?.isWrapped &&
    bottom - rowIndex < MAX_WRAP_ROWS
  ) {
    bottom++;
  }

  let text = "";
  const cells: { y: number; x: number }[] = [];
  // One cell object, refilled per column. This runs while the pointer moves
  // across a pane, so a fresh object per cell would be a few hundred
  // allocations per row hovered.
  const cell = buf.getNullCell();
  for (let y = top; y <= bottom; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    for (let x = 0; x < line.length; x++) {
      if (!line.getCell(x, cell)) continue;
      // Width 0 is the second half of a wide character — already accounted for
      // by the cell that owns it.
      if (cell.getWidth() === 0) continue;
      const chars = cell.getChars() || " ";
      for (let i = 0; i < chars.length; i++) cells.push({ y, x });
      text += chars;
    }
  }
  return { text, cells };
}

/** The link under buffer cell (col, row), or null. */
function targetAt(term: Terminal, col: number, row: number): HoverTarget | null {
  const mapped = mapLogicalLine(term, row);
  if (!mapped) return null;

  const hovered = mapped.cells.findIndex((c) => c.y === row && c.x === col);
  if (hovered === -1) return null;
  const from = Math.max(0, hovered - MATCH_WINDOW);
  const text = mapped.text.slice(from, hovered + MATCH_WINDOW + 1);

  for (const match of findPathLinks(text)) {
    let hit = false;
    const segments: { y: number; x0: number; x1: number }[] = [];
    for (let i = from + match.start; i < from + match.end; i++) {
      const cell = mapped.cells[i];
      if (!cell) continue;
      if (cell.y === row && cell.x === col) hit = true;
      const last = segments[segments.length - 1];
      if (last && last.y === cell.y) last.x1 = Math.max(last.x1, cell.x);
      else segments.push({ y: cell.y, x0: cell.x, x1: cell.x });
    }
    if (hit && segments.length) {
      return { text: match.text, kind: match.kind, segments };
    }
  }
  return null;
}

function sameTarget(a: HoverTarget | null, b: HoverTarget | null): boolean {
  if (!a || !b) return a === b;
  if (a.text !== b.text || a.segments.length !== b.segments.length) return false;
  return a.segments.every((s, i) => {
    const o = b.segments[i];
    return s.y === o.y && s.x0 === o.x0 && s.x1 === o.x1;
  });
}

// Panes with a live link layer, so the selection bridge can ask this one
// question about a click it is holding: was it aimed at a link?
const layers = new WeakMap<HTMLElement, (event: MouseEvent) => boolean>();

/**
 * Copy the link under a click, if there is one. Returns whether it did.
 *
 * The way in for lib/mouse-selection, which swallows presses in a pane whose
 * program has grabbed the mouse (Claude Code, vim, htop) and replays them as a
 * click — a release this layer's own listener never sees, since that bridge
 * stops the event at the window before it reaches the pane. The click is still
 * forwarded to the program afterwards; copying is in addition to it, not
 * instead of it.
 */
export function activateLinkAt(container: HTMLElement, event: MouseEvent): boolean {
  return layers.get(container)?.(event) ?? false;
}

/**
 * Make paths and URLs in `term` hoverable and clickable inside `container`.
 *
 * Returns a teardown, because the container is what a split or a cross-tab drag
 * replaces — the layer is re-installed on every attach, alongside the selection
 * and paste bridges.
 */
export function installLinkLayer(
  term: Terminal,
  container: HTMLElement,
  opts: {
    // The pane's working directory, read at click time. A relative path in
    // output only means something relative to where the shell currently is.
    cwd: () => string;
    // The pane's Claude Code session id, when it has one — where a relative
    // path an agent printed can be traced back to the full one it wrote.
    sessionId: () => string | undefined;
    // Open a file in a pane of this window, split off the active one.
    openFile: (path: string) => void;
  }
): () => void {
  const found = term.element?.querySelector<HTMLElement>(".xterm-screen");
  if (!found) return () => {};
  // Re-bound with a non-nullable type: the geometry helpers below all close
  // over it, and a closure doesn't carry the null check with it.
  const screen: HTMLElement = found;

  // The underline is drawn here rather than by the renderer: the WebGL renderer
  // owns its canvas, and this is one absolutely-positioned box per row of the
  // hovered span, over the top of it.
  const overlay = document.createElement("div");
  overlay.className = "term-link-overlay";
  screen.appendChild(overlay);

  let pointer: { x: number; y: number } | null = null;
  // The cell the pointer was last seen over. Mousemove fires per pixel, and the
  // answer can only change when the cell does — a redraw under a still pointer
  // is scheduleRefresh's job, not this one's.
  let pointerCell: { col: number; row: number } | null = null;
  let target: HoverTarget | null = null;
  let pressed: { col: number; row: number; target: HoverTarget } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastRefresh = 0;

  /** Cell size, read from the screen element so a font or zoom change is free. */
  function cellSize(): { cw: number; ch: number; rect: DOMRect } {
    const rect = screen.getBoundingClientRect();
    return { cw: rect.width / term.cols, ch: rect.height / term.rows, rect };
  }

  /** Buffer coordinates under a pointer position, or null when outside. */
  function cellAt(clientX: number, clientY: number): { col: number; row: number } | null {
    const { cw, ch, rect } = cellSize();
    if (!cw || !ch) return null;
    const col = Math.floor((clientX - rect.left) / cw);
    const viewRow = Math.floor((clientY - rect.top) / ch);
    if (col < 0 || col >= term.cols || viewRow < 0 || viewRow >= term.rows) return null;
    return { col, row: term.buffer.active.viewportY + viewRow };
  }

  function draw(): void {
    overlay.textContent = "";
    screen.style.cursor = target ? "pointer" : "";
    if (!target) return;
    const { cw, ch } = cellSize();
    const viewportY = term.buffer.active.viewportY;
    for (const segment of target.segments) {
      const row = segment.y - viewportY;
      if (row < 0 || row >= term.rows) continue;
      const mark = document.createElement("div");
      mark.className = "term-link-underline";
      mark.style.left = `${segment.x0 * cw}px`;
      mark.style.top = `${row * ch}px`;
      mark.style.width = `${(segment.x1 - segment.x0 + 1) * cw}px`;
      mark.style.height = `${ch}px`;
      overlay.appendChild(mark);
    }
  }

  function refresh(): void {
    lastRefresh = Date.now();
    const next = (() => {
      if (!pointer) return null;
      const cell = cellAt(pointer.x, pointer.y);
      return cell ? targetAt(term, cell.col, cell.row) : null;
    })();
    if (sameTarget(next, target)) {
      // Same link, but the pane may have scrolled under it — the underline is
      // positioned in viewport rows, so it still has to be redrawn.
      if (target) draw();
      return;
    }
    target = next;
    draw();
  }

  // A redraw and a scroll both change what is under a motionless pointer, so
  // both have to re-ask — that re-ask is the whole reason this layer exists.
  // They also arrive many times a second from a TUI, and each one walks the
  // hovered line cell by cell, so they are throttled to one pass every
  // REFRESH_THROTTLE_MS. A link appearing under a still pointer a frame or two
  // late is invisible; the pointer's own moves are never throttled.
  function scheduleRefresh(): void {
    // Nothing hovered and nothing drawn: a pane printing output with the
    // pointer elsewhere has no question to re-ask, so it arms no timer.
    if (timer !== undefined || (!pointer && !target)) return;
    const wait = Math.max(0, REFRESH_THROTTLE_MS - (Date.now() - lastRefresh));
    timer = setTimeout(() => {
      timer = undefined;
      refresh();
    }, wait);
  }

  const onMove = (event: MouseEvent) => {
    // Synthetic events are the selection bridge replaying a press it held back
    // (lib/mouse-selection); the real one already came through here.
    if (!event.isTrusted) return;
    pointer = { x: event.clientX, y: event.clientY };
    const cell = cellAt(event.clientX, event.clientY);
    if (cell && pointerCell && cell.col === pointerCell.col && cell.row === pointerCell.row) {
      return;
    }
    pointerCell = cell;
    refresh();
  };

  const onLeave = () => {
    pointer = null;
    pointerCell = null;
    pressed = null;
    if (target) {
      target = null;
      draw();
    }
  };

  const onDown = (event: MouseEvent) => {
    if (!event.isTrusted || event.button !== 0) return;
    pointer = { x: event.clientX, y: event.clientY };
    refresh();
    const cell = cellAt(event.clientX, event.clientY);
    pressed = cell && target ? { ...cell, target } : null;
  };

  const onUp = (event: MouseEvent) => {
    if (!event.isTrusted || event.button !== 0) return;
    const started = pressed;
    pressed = null;
    if (!started) return;
    // Released somewhere else: that was a drag to select, not a click.
    const cell = cellAt(event.clientX, event.clientY);
    if (!cell || cell.col !== started.col || cell.row !== started.row) return;
    activate(event, started.target);
  };

  /** Copy (or open) whatever is under this event's pointer. */
  function activateAt(event: MouseEvent): boolean {
    pressed = null;
    pointer = { x: event.clientX, y: event.clientY };
    const cell = cellAt(event.clientX, event.clientY);
    const hit = cell ? targetAt(term, cell.col, cell.row) : null;
    if (!hit) return false;
    activate(event, hit);
    return true;
  }
  layers.set(container, activateAt);

  function activate(event: MouseEvent, hit: HoverTarget): void {
    if (event.ctrlKey || event.metaKey) {
      void openTarget(event, hit, opts);
      return;
    }
    void copyTarget(event, hit, opts);
  }

  // Capture phase, so these run before the selection bridge decides what to do
  // with the same press.
  container.addEventListener("mousemove", onMove, true);
  container.addEventListener("mousedown", onDown, true);
  container.addEventListener("mouseup", onUp, true);
  container.addEventListener("mouseleave", onLeave, true);

  const onRender = term.onRender(scheduleRefresh);
  const onScroll = term.onScroll(scheduleRefresh);
  const onResize = term.onResize(scheduleRefresh);

  return () => {
    if (layers.get(container) === activateAt) layers.delete(container);
    container.removeEventListener("mousemove", onMove, true);
    container.removeEventListener("mousedown", onDown, true);
    container.removeEventListener("mouseup", onUp, true);
    container.removeEventListener("mouseleave", onLeave, true);
    onRender.dispose();
    onScroll.dispose();
    onResize.dispose();
    clearTimeout(timer);
    overlay.remove();
    screen.style.cursor = "";
  };
}

/**
 * Copy what was clicked, and say so.
 *
 * The selection is cleared first: the click has usually just placed an empty
 * one, and leaving it behind means the next ⌘C reads that instead of what we
 * put on the clipboard.
 */
export async function copyTerminalLink(event: MouseEvent, text: string): Promise<void> {
  window.getSelection()?.removeAllRanges();
  await clipboardWriteText(text);
  flash(event, `Copied ${forFlash(text)}`);
}

type LinkOpts = {
  cwd: () => string;
  sessionId: () => string | undefined;
  openFile: (path: string) => void;
};

function locateContext(opts: LinkOpts): LocateContext {
  return { cwd: opts.cwd(), sessionId: opts.sessionId(), windows: os === "windows" };
}

/**
 * Plain click: copy the link — and for a path, the full path.
 *
 * What is printed is often relative to somewhere other than where you are
 * pasting it, so the clipboard gets the absolute path it stands for (keeping a
 * compiler's `:12:5`). When it can't be found, the text goes as printed: a
 * wrong full path is worse than a partial one.
 */
async function copyTarget(event: MouseEvent, hit: HoverTarget, opts: LinkOpts): Promise<void> {
  window.getSelection()?.removeAllRanges();
  let text = hit.text;
  if (hit.kind === "path") {
    const full = await locatePath(hit.text, locateContext(opts)).catch(() => null);
    if (full) text = full + lineSuffixOf(hit.text);
  }
  await copyTerminalLink(event, text);
}

/** A bare `www.example.com` is a URL the moment someone clicks it. */
function withScheme(url: string): string {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(url) ? url : `https://${url}`;
}

/**
 * Ctrl/⌘+click: open the thing instead of copying it.
 *
 * A URL goes to the browser. A path goes to whatever application owns its type,
 * which means it first has to become a real path — the `:12:5` a compiler
 * appended comes off, a `~` is expanded, and a relative path is looked for
 * from the pane's directory outwards. Terminal output is full of paths that were true
 * when they were printed, so a miss is reported rather than swallowed.
 */
async function openTarget(
  event: MouseEvent,
  hit: HoverTarget,
  opts: LinkOpts
): Promise<void> {
  window.getSelection()?.removeAllRanges();
  const backend = await getBackend();

  if (hit.kind === "url") {
    const url = withScheme(hit.text);
    // The host only hands web and mail links to the OS (see open-external in
    // electron/main.cjs); saying "Opening" for a file:// or ssh:// it drops
    // would be a lie.
    if (!/^(https?|mailto):/i.test(url)) {
      flash(event, `Won't open ${forFlash(hit.text)}`, "problem");
      return;
    }
    await backend.openExternal(url);
    flash(event, `Opening ${forFlash(hit.text)}`);
    return;
  }

  // Looked for, not just joined onto the pane's directory (lib/path-locate.ts).
  // Not found anywhere, the plain join is what gets reported missing.
  const ctx = locateContext(opts);
  const resolved =
    (await locatePath(hit.text, ctx).catch(() => null)) ??
    resolveMatchedPath(hit.text, { cwd: ctx.cwd, home: await homeDir(), windows: ctx.windows });
  if (!resolved) {
    flash(event, `Nowhere to look for ${forFlash(hit.text)}`, "problem");
    return;
  }

  // Not even stat'd: on Windows that alone connects to the host (see
  // isNetworkSharePath in electron/main.cjs).
  if (os === "windows" && /^[\\/]{2}/.test(resolved)) {
    flash(event, `Won't open a network path: ${forFlash(resolved)}`, "problem");
    return;
  }

  const stat = await backend.statPath(resolved);
  if (!stat.exists) {
    flash(event, `Not here any more: ${forFlash(resolved)}`, "problem");
    return;
  }

  // A file Specterm can display opens where you are looking — a pane split off
  // this one, not a new tab and certainly not a second copy of the app. The
  // pane appearing is its own confirmation, so nothing is flashed for it.
  if (!stat.isDirectory && opensInSpecterm(resolved)) {
    opts.openFile(resolved);
    return;
  }

  // Everything else belongs to the OS: a PDF to whatever reads PDFs, a
  // directory to the file manager.
  const result = await backend.openPathInDefaultApp(resolved);
  if (result.revealed) {
    flash(event, `Shown in folder: ${forFlash(resolved)}`);
  } else if (result.ok) {
    flash(event, `Opening ${forFlash(resolved)}`);
  } else if (result.reason === "missing") {
    flash(event, `Not here any more: ${forFlash(resolved)}`, "problem");
  } else {
    flash(event, `Nothing opens ${forFlash(resolved)}`, "problem");
  }
}

// The flash — what tells you the click landed, and what it did. It lives on
// <body> at the pointer, not inside the pane: a pane is a clipped, transformed
// box in a split tree, and a confirmation that gets cut in half by its own
// container confirms nothing.
let activeFlash: HTMLElement | null = null;
let flashHideTimer: ReturnType<typeof setTimeout> | undefined;
let flashRemoveTimer: ReturnType<typeof setTimeout> | undefined;

const FLASH_VISIBLE_MS = 900;
const FLASH_FADE_MS = 160;
// How far the flash sits from the pointer, and from the window's side edges.
const FLASH_GAP_PX = 8;
const FLASH_EDGE_GAP_PX = 8;

/**
 * Shorten a long path for the flash. The end is the part you recognise; the
 * start is what says a relative path was copied as a full one.
 */
function forFlash(text: string): string {
  return text.length > 44 ? `${text.slice(0, 14)}…${text.slice(-29)}` : text;
}

function flash(event: MouseEvent, message: string, tone?: "problem"): void {
  clearTimeout(flashHideTimer);
  clearTimeout(flashRemoveTimer);
  activeFlash?.remove();

  const el = document.createElement("div");
  el.className = "copy-flash";
  el.textContent = message;
  if (tone === "problem") el.classList.add("is-problem");
  el.style.left = `${event.clientX}px`;
  el.style.top = `${event.clientY}px`;
  document.body.appendChild(el);
  activeFlash = el;

  // Placement needs the box's own size, so it happens after the append.
  const rect = el.getBoundingClientRect();

  // Centred on the pointer, a long path can hang off either edge of the window.
  const half = rect.width / 2;
  const clamped = Math.min(
    Math.max(event.clientX, half + FLASH_EDGE_GAP_PX),
    Math.max(half + FLASH_EDGE_GAP_PX, window.innerWidth - half - FLASH_EDGE_GAP_PX)
  );
  el.style.left = `${clamped}px`;

  // Click a path on the first row of a pane and there's no room above the
  // pointer: the flash would sit on the tab bar or the title strip, reading as
  // part of the window chrome rather than as an answer to the click. When it
  // won't fit inside the pane it came from, it hangs below the pointer instead.
  const paneTop =
    (event.target instanceof Element
      ? event.target.closest(".xterm")?.getBoundingClientRect().top
      : undefined) ?? 0;
  if (event.clientY - rect.height - FLASH_GAP_PX < paneTop) {
    el.classList.add("is-below");
  }

  requestAnimationFrame(() => el.classList.add("is-visible"));
  flashHideTimer = setTimeout(() => {
    el.classList.remove("is-visible");
    flashRemoveTimer = setTimeout(() => {
      el.remove();
      if (activeFlash === el) activeFlash = null;
    }, FLASH_FADE_MS);
  }, FLASH_VISIBLE_MS);
}
