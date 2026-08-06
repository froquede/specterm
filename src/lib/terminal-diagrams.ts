// Diagrams that went past in the terminal.
//
// Claude Code answers with mermaid constantly, and in a terminal a mermaid
// block is thirty lines of arrows and brackets that you have to draw in your
// head. The markdown preview has rendered them since the beginning; this is the
// same thing for output, without asking the program that produced it to
// cooperate. A chip appears beside the block, and clicking it opens the drawing
// over the pane (see components/DiagramOverlay.tsx).
//
// Three problems, and the shape of this file is the three answers:
//
// **1. When to look.** Not per chunk — that would put a scan in the middle of
// the hot path for every pane, forever. Output arrives in bursts and a block is
// only complete once the burst ends, so the scan waits for the quiet after one.
// What a chunk costs is a timestamp; a single interval, shared by every pane and
// running only while output is flowing, is what notices the quiet. (A per-pane
// debounce is the obvious way to write that and measurably the wrong one — see
// noteDiagramOutput.) A fixed window of recent rows is re-read each time and
// results are deduplicated by content, which measures at 0.8ms and means no
// bookkeeping about which rows were already seen — buffer row indices shift out
// from under you as the scrollback trims, so that bookkeeping would be wrong.
//
// **2. Where the block ends.** A fenced block from `cat notes.md` closes itself
// and needs no guessing. Claude Code's renderer does not: it prints the info
// string ("mermaid") on its own line and then the body, with no fences and with
// prose resuming at the *same indentation* the diagram used. Nothing in the
// layout separates them. So the extent is guessed generously by grammar (a
// mermaid line looks nothing like a sentence) and the real parser settles it at
// render time by dropping trailing lines until it parses — see renderDiagramInto.
//
// **3. What the source actually was.** This is the one that decides whether the
// feature works at all. Claude hard-wraps its output to the terminal width, so a
// long line — exactly the `A["...long label..."]` that makes a diagram worth
// drawing — reaches the screen split across two rows with the continuation
// re-indented. Scraped back, that is not the source; it is a corrupted copy that
// often won't parse. But Claude also writes every message it prints to a
// transcript, verbatim, fences and all. So the screen is used for *where* the
// block is (which is all it is reliable for) and the transcript for *what it
// says*. The scrape stays as the fallback, which is what any non-Claude program
// gets, and what a Claude pane gets when the transcript can't be read.

import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";
import type { TerminalInstance } from "./terminal-registry";
import { getBackend } from "../backends";
import { transcriptPath } from "./session-providers/claude";
import { DIAGRAM_HEADER_RE } from "./mermaid";
import {
  addDiagram,
  clearPaneDiagrams,
  openDiagram,
  replaceDiagramSource,
} from "../stores/diagrams";

// How long the pane has to stop producing output before it is scanned. Long
// enough that a Claude turn streaming a diagram in isn't scanned mid-block on
// every repaint; short enough that the chip is there by the time you have
// finished reading the answer.
const SCAN_QUIET_MS = 500;

// How far back a scan looks. Comfortably more than a screenful, so a diagram
// that scrolled up while the rest of the answer streamed in is still found, and
// far short of xterm's 1000-row scrollback so the pass stays cheap.
const SCAN_WINDOW_ROWS = 400;

// Ceiling on one block, in logical lines. A mermaid diagram this big is already
// unreadable; the bound is here so a runaway grammar guess can't walk the whole
// scrollback into one "diagram".
const MAX_BLOCK_LINES = 400;

// Diagrams kept per pane. The chip is the way back to one, so this only needs
// to outlive the rows it was found on for as long as the overlay might still be
// showing it.
const MAX_DIAGRAMS_PER_PANE = 24;

// How much of the tail of a transcript is read looking for the exact source.
// A turn's text is a few kilobytes; this covers the last several of them even
// with tool results in between, and it is a bounded read off the end of a file
// that is routinely tens of megabytes (see Backend.readFileTail).
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;

// --- finding blocks in text ------------------------------------------------
// Everything down to the next divider is pure: it takes lines of text and says
// where the diagrams are. Kept free of xterm and the DOM so it can be tested
// against captured output (test/fixtures) rather than against a live terminal.

/** A mermaid block located in a sequence of lines. */
export interface FoundBlock {
  /** Index of the line carrying the info string ("mermaid" or "```mermaid"). */
  labelIndex: number;
  /** Column the label starts at, and how wide it is — where the chip goes. */
  labelIndent: number;
  labelWidth: number;
  /** The diagram source, dedented. */
  source: string;
  /** Diagram type, for labelling the overlay ("flowchart TD"). */
  title: string;
  /** True when the block's own fences said where it ended, so the source is
   *  known to be complete rather than guessed. */
  fenced: boolean;
}

const FENCE_RE = /^(\s*)```\s*mermaid\s*$/;
const CLOSING_FENCE_RE = /^\s*```\s*$/;
const LABEL_RE = /^(\s*)mermaid\s*$/;

// Does this line belong to a mermaid diagram? Used only to guess where a
// fence-less block stops, so it is deliberately loose: over-reaching is
// corrected by the parser at render time, while stopping early truncates a
// diagram with no way to notice.
function looksLikeMermaid(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  // Comments and the statements that carry no operator of their own.
  if (
    /^(%%|subgraph\b|end\b|direction\b|click\b|classDef\b|class\b|style\b|linkStyle\b|accTitle\b|accDescr\b|participant\b|actor\b|note\b|loop\b|alt\b|else\b|opt\b|par\b|and\b|rect\b|activate\b|deactivate\b|section\b|title\b|state\b|autonumber\b|dateFormat\b|axisFormat\b|excludes\b|branch\b|checkout\b|commit\b|merge\b)/i.test(
      t
    )
  ) {
    return true;
  }
  // A link of any flavour — flowchart, sequence, class, ER.
  if (/(--+[->ox|]|-\.-|==+[=>]|<--|->>|<<-|\.\.>|<\|--|\*--|o--|\|\||\}o|o\{|\|\{)/.test(t)) {
    return true;
  }
  // A node or edge declaration: an identifier immediately followed by one of
  // mermaid's shape brackets. The "immediately" matters — it is what keeps an
  // ordinary sentence, which always has a space before its punctuation, out.
  if (/^[A-Za-z0-9_.-]+(\[|\(|\{|>|@\{|:::)/.test(t)) return true;
  // `a & b` id lists, and `key: value` statements (gantt sections, sequence
  // messages, mindmap nodes).
  if (/^[A-Za-z0-9_.-]+(\s*&\s*[A-Za-z0-9_.-]+)+/.test(t)) return true;
  if (/^[A-Za-z0-9_.-]+\s*:/.test(t)) return true;
  return false;
}

// Take `n` columns of leading whitespace off a line, and no more — a line
// indented less than the block (a hard-wrapped continuation, which Claude
// re-indents to its own margin) keeps whatever it has rather than losing
// characters.
function dedent(line: string, n: number): string {
  let i = 0;
  while (i < n && (line[i] === " " || line[i] === "\t")) i++;
  return line.slice(i);
}

// The diagram type, as a label: the first line of the source, capped so an
// oversized header can't stretch the overlay's title.
function titleOf(source: string): string {
  const first = source.split("\n").find((l) => l.trim()) ?? "diagram";
  return first.trim().slice(0, 48);
}

/**
 * Every mermaid block in `lines`.
 *
 * Recognizes both shapes: a real fenced block (verbatim output — `cat`, `git
 * show`, a heredoc) and Claude Code's rendering of one, which keeps the info
 * string and drops the fences.
 */
export function findDiagramBlocks(lines: string[]): FoundBlock[] {
  const blocks: FoundBlock[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const indent = fence[1].length;
      let close = -1;
      for (let j = i + 1; j < lines.length && j - i <= MAX_BLOCK_LINES; j++) {
        if (CLOSING_FENCE_RE.test(lines[j])) {
          close = j;
          break;
        }
      }
      // An unclosed fence is a block still being written — leave it for the
      // next scan rather than guessing an end for something that has one.
      if (close === -1) continue;
      const source = lines
        .slice(i + 1, close)
        .map((l) => dedent(l, indent))
        .join("\n")
        .replace(/\s+$/, "");
      if (source.trim()) {
        blocks.push({
          labelIndex: i,
          labelIndent: indent,
          labelWidth: line.trim().length,
          source,
          title: titleOf(source),
          fenced: true,
        });
      }
      i = close;
      continue;
    }

    const label = LABEL_RE.exec(line);
    if (!label) continue;

    // "mermaid" on a line by itself is only an info string if a diagram starts
    // under it. Without this, a `grep mermaid` hit or a bare word in prose puts
    // a chip on nothing.
    const indent = label[1].length;
    let start = i + 1;
    while (start < lines.length && !lines[start].trim()) start++;
    if (start >= lines.length) continue;
    if (!DIAGRAM_HEADER_RE.test(dedent(lines[start], indent).trim())) continue;

    // Walk forward for as long as the lines keep looking like a diagram, and
    // `last` — the final line that actually did — is where the block ends.
    //
    // Blank lines pass through without extending it (mermaid sources are full of
    // them) and a couple of unrecognized lines are tolerated, because a line the
    // producer hard-wrapped arrives as a fragment that matches nothing. That
    // tolerance is also the whole danger: given enough rope the walk will step
    // over the end of the answer, over the shell prompt, and into the *next*
    // block, because a command line echoed back may well contain an arrow. So
    // two things stop it dead, ahead of any grammar:
    //
    //   - **A fence.** Whatever a ``` line belongs to, this block isn't it.
    //   - **A line indented less than the info string.** Everything a renderer
    //     prints under its own margin is at least as deep as the label it
    //     printed; the shell prompt underneath the answer is not. This is the
    //     one structural boundary available, and it is what keeps a block from
    //     annexing the command that follows it.
    let last = start;
    let misses = 0;
    for (let j = start + 1; j < lines.length && j - start <= MAX_BLOCK_LINES; j++) {
      const text = lines[j];
      if (!text.trim()) continue;
      if (/^\s*```/.test(text)) break;
      if (text.length - text.trimStart().length < indent) break;
      if (looksLikeMermaid(dedent(text, indent))) {
        last = j;
        misses = 0;
      } else if (++misses >= 3) {
        break;
      }
    }

    const source = lines
      .slice(start, last + 1)
      .map((l) => dedent(l, indent))
      .join("\n")
      .replace(/\s+$/, "");
    blocks.push({
      labelIndex: i,
      labelIndent: indent,
      labelWidth: "mermaid".length,
      source,
      title: titleOf(source),
      fenced: false,
    });
    // Resume just after the info string, not after the block. Where the block
    // ends is a *guess*; jumping the scan past it would make that guess able to
    // hide a real, fenced block underneath — which is exactly what it did.
    i = start;
  }

  return blocks;
}

/**
 * Every mermaid block written by the assistant in a slice of a Claude Code
 * transcript, oldest first.
 *
 * The slice is the tail of a JSONL file and its first line may be a fragment,
 * so anything that doesn't parse is skipped rather than treated as an error.
 * Lines are pre-filtered on the literal substring before being parsed at all:
 * a transcript line can be half a megabyte of tool output, and JSON.parse on
 * every one of them to find the handful that mention mermaid is the difference
 * between this being free and this being felt.
 */
export function mermaidBlocksInTranscript(tail: string): string[] {
  const blocks: string[] = [];
  for (const line of tail.split("\n")) {
    if (!line.includes("mermaid")) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch (_) {
      continue; // truncated first line, or a partial write at the end
    }
    const record = entry as {
      type?: string;
      message?: { content?: Array<{ type?: string; text?: string }> };
    };
    if (record.type !== "assistant") continue;
    for (const part of record.message?.content ?? []) {
      if (part.type !== "text" || !part.text) continue;
      const fences = /```mermaid[ \t]*\r?\n([\s\S]*?)```/g;
      let m: RegExpExecArray | null;
      while ((m = fences.exec(part.text)) !== null) {
        const source = m[1].replace(/\s+$/, "");
        if (source.trim()) blocks.push(source);
      }
    }
  }
  return blocks;
}

/**
 * What makes two sightings of a block the same block.
 *
 * Its first few lines, whitespace-flattened — not its whole source, which grows
 * while a program is still writing it out, and not its position, which moves as
 * the scrollback scrolls. Two genuinely different diagrams that open with the
 * same three lines would be merged into one; that is a far better failure than
 * the alternative, which is one diagram accumulating a chip per scan.
 */
export function blockKey(block: FoundBlock): string {
  return block.source
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 3)
    .join("|");
}

// Whitespace-insensitive comparison key for one line of a diagram. The screen
// copy has been through a renderer that may have re-indented it, so only the
// non-space content can be compared.
const normalize = (line: string) => line.replace(/\s+/g, " ").trim();

/**
 * Which of `candidates` is the block that was scraped off the screen.
 *
 * Matched on a prefix of the source rather than the whole of it: the tail of
 * the scraped copy is a guess (see findDiagramBlocks) and its long lines may
 * have been wrapped, but the opening lines of a diagram are short and survive
 * intact. Candidates are scored on how many of the first few lines agree, the
 * header line must agree for any match at all, and later candidates win ties —
 * the newest block in the transcript is the one that was just printed.
 */
export function pickTranscriptMatch(
  scraped: string,
  candidates: string[]
): string | null {
  const want = scraped.split("\n").map(normalize).filter(Boolean).slice(0, 6);
  if (!want.length) return null;

  let best: string | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const have = candidate.split("\n").map(normalize).filter(Boolean);
    if (have[0] !== want[0]) continue;
    let score = 1;
    for (let i = 1; i < want.length && i < have.length; i++) {
      if (have[i] === want[i]) score++;
    }
    if (score >= bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

// --- reading the terminal --------------------------------------------------

/** The rows of a terminal as logical lines, with soft-wrapped rows rejoined. */
function readLogicalLines(
  term: Terminal
): { lines: string[]; rows: number[] } {
  const buf = term.buffer.active;
  const bottom = buf.baseY + term.rows - 1;
  let top = Math.max(0, bottom - SCAN_WINDOW_ROWS);
  // Never start on a continuation row: it would be read as a line of its own,
  // and its parent would be missing its tail.
  while (top > 0 && buf.getLine(top)?.isWrapped) top--;

  const lines: string[] = [];
  const rows: number[] = [];
  for (let r = top; r <= bottom; r++) {
    const line = buf.getLine(r);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length) {
      // xterm's own soft wrap: the row is the continuation of the one above and
      // was never a line break in the output. Unlike Claude's hard wrap, this
      // one is marked, so it can be undone exactly.
      lines[lines.length - 1] += line.translateToString(false).replace(/\s+$/, "");
    } else {
      lines.push(text);
      rows.push(r);
    }
  }
  return { lines, rows };
}

// --- per-pane state --------------------------------------------------------

interface TrackedDiagram {
  id: string;
  marker: IMarker | null;
  decoration: IDecoration | null;
  /** Length of the source last stored, so a block that has grown since the last
   *  scan can be told from the same block seen again. */
  length: number;
  /** Whether the exact source has already been recovered from a transcript —
   *  once it has, a later scrape of the screen must not overwrite it. */
  exact: boolean;
}

interface PaneWatch {
  // The terminal to scan. Held here so the tick doesn't have to go back through
  // the registry — and safe to hold, because a pane's instance is created once
  // and the watch is dropped with it (see forgetDiagrams).
  instance: TerminalInstance;
  // When output last arrived, or 0 when there is nothing waiting to be scanned.
  lastOutputAt: number;
  // Content key -> the chip drawn for it. The key is what makes re-scanning a
  // fixed window idempotent: the same block found again is the same entry.
  seen: Map<string, TrackedDiagram>;
}

const watches = new Map<string, PaneWatch>();

// How often the sweep looks for a pane that has gone quiet. The quiet a scan
// waits for is SCAN_QUIET_MS; this is the resolution that decision is made at,
// so a block is drawn between half a second and three quarters after the output
// stops. Nobody can tell the difference, and a coarser tick means fewer wakeups.
const TICK_MS = 250;

let ticker: number | null = null;

function watchFor(paneId: string, instance: TerminalInstance): PaneWatch {
  let watch = watches.get(paneId);
  if (!watch) {
    watch = { instance, lastOutputAt: 0, seen: new Map() };
    watches.set(paneId, watch);
  }
  return watch;
}

/**
 * A chunk of output landed in this pane.
 *
 * **This runs for every chunk every pane produces, so it does as close to
 * nothing as it can**: a map lookup, a timestamp, one field write. Nothing is
 * allocated and no timer is touched on the common path.
 *
 * The obvious implementation — a debounce, `clearTimeout`/`setTimeout` per
 * chunk — is what this replaced, and it is worth saying why. It is correct, and
 * it costs two timer-heap operations per chunk: measured at 3.5µs a chunk and
 * 4,719 chunks for a 24MB dump, ~16ms of pure bookkeeping on the one path in
 * this app that must never grow any. A single sweep costs that once per tick
 * for every pane at once, and only while output is actually flowing — the
 * interval stops itself as soon as the last pane has been scanned, so an idle
 * window has no timer of ours armed at all.
 */
export function noteDiagramOutput(paneId: string, instance: TerminalInstance) {
  const watch = watchFor(paneId, instance);
  watch.lastOutputAt = Date.now();
  if (ticker === null) startTicker();
}

function startTicker() {
  ticker = window.setInterval(() => {
    const now = Date.now();
    let waiting = false;
    for (const [paneId, watch] of watches) {
      if (!watch.lastOutputAt) continue;
      if (now - watch.lastOutputAt < SCAN_QUIET_MS) {
        waiting = true;
        continue;
      }
      // Claimed before the scan, not after: a scan that throws must not leave
      // the pane pending forever, re-scanned on every tick from here on.
      watch.lastOutputAt = 0;
      try {
        scanPane(paneId, watch);
      } catch (_) {
        // A scan is a convenience; a terminal disposed mid-pass, or a buffer in
        // some state this didn't anticipate, must never take the pane with it.
      }
    }
    if (!waiting) stopTicker();
  }, TICK_MS);
}

function stopTicker() {
  if (ticker === null) return;
  clearInterval(ticker);
  ticker = null;
}

/** Drop everything held for a pane — called when its terminal is disposed. */
export function forgetDiagrams(paneId: string) {
  const watch = watches.get(paneId);
  if (!watch) return;
  for (const tracked of watch.seen.values()) {
    tracked.decoration?.dispose();
    tracked.marker?.dispose();
  }
  watches.delete(paneId);
  clearPaneDiagrams(paneId);
  // The last watched pane just went away, so the sweep has nothing left to look
  // at. Without this the interval would keep firing over an empty map for as
  // long as the window stayed open.
  if (watches.size === 0) stopTicker();
}

let diagramSeq = 0;

function scanPane(paneId: string, watch: PaneWatch) {
  const instance = watch.instance;
  if (instance.disposed) return;
  const { term } = instance;
  // A full-screen program owns the whole grid and repaints it constantly; its
  // "lines" are a picture, not a stream of output, and anything found in one
  // would be gone on the next frame.
  if (term.buffer.active.type === "alternate") return;

  const { lines, rows } = readLogicalLines(term);
  const blocks = findDiagramBlocks(lines);

  for (const block of blocks) {
    // Identity is the *opening* of the block, never the whole of it. Every
    // coding agent streams its answer out, so a diagram genuinely is shorter on
    // one scan than on the next — keyed on the full source, each growth would
    // put another chip on the same block. Keyed on its first lines, the longer
    // scrape updates the entry that is already there.
    const key = blockKey(block);
    const existing = watch.seen.get(key);
    if (existing) {
      if (!existing.exact && block.source.length > existing.length) {
        existing.length = block.source.length;
        replaceDiagramSource(paneId, existing.id, block.source, block.fenced);
        if (!block.fenced) {
          void resolveExactSource(paneId, existing, instance, block.source);
        }
      }
      continue;
    }

    const id = `dg-${++diagramSeq}`;
    const tracked: TrackedDiagram = {
      id,
      marker: null,
      decoration: null,
      length: block.source.length,
      exact: false,
    };
    watch.seen.set(key, tracked);
    if (watch.seen.size > MAX_DIAGRAMS_PER_PANE) {
      const oldest = watch.seen.keys().next().value;
      if (oldest !== undefined && oldest !== key) {
        const gone = watch.seen.get(oldest);
        gone?.decoration?.dispose();
        gone?.marker?.dispose();
        watch.seen.delete(oldest);
      }
    }

    addDiagram(paneId, {
      id,
      title: block.title,
      source: block.source,
      exact: block.fenced,
    });
    attachChip(paneId, id, term, tracked, rows[block.labelIndex], block);

    // The scraped copy is only ever a starting point for a block Claude
    // rendered — see the file header. Nothing waits on this.
    if (!block.fenced) {
      void resolveExactSource(paneId, tracked, instance, block.source);
    }
  }
}

// Draw the chip next to the block's info string.
//
// An xterm decoration is anchored to a marker, and a marker follows its line:
// it moves with the scrollback and disposes itself when the line falls off the
// end. That is exactly the lifetime the chip wants, and it is why this doesn't
// track scroll positions of its own.
function attachChip(
  paneId: string,
  diagramId: string,
  term: Terminal,
  tracked: TrackedDiagram,
  row: number | undefined,
  block: FoundBlock
) {
  if (row === undefined) return;
  const buf = term.buffer.active;
  // registerMarker is relative to the cursor, which is where the shell left it.
  const marker = term.registerMarker(row - (buf.baseY + buf.cursorY));
  if (!marker) return;
  tracked.marker = marker;

  const decoration = term.registerDecoration({
    marker,
    x: block.labelIndent + block.labelWidth + 1,
    width: 11,
    height: 1,
    layer: "top",
  });
  if (!decoration) {
    marker.dispose();
    tracked.marker = null;
    return;
  }
  tracked.decoration = decoration;

  decoration.onRender((element) => {
    // onRender fires again every time the row is repainted; the element is the
    // same one, so building the chip twice would stack two of them in it.
    if (element.dataset.specterm === "diagram") return;
    element.dataset.specterm = "diagram";
    // Added, never assigned: xterm's own `xterm-decoration` class is what
    // positions the element over its row and lifts it above the render layers.
    // Replacing the class list drops both, and the chip ends up drawn under the
    // link-layer canvas where it can be seen and not clicked.
    element.classList.add("terminal-diagram-chip");
    element.title = `Render this ${block.title.split(/\s+/)[0]} diagram`;
    element.textContent = "◆ diagram";
    // Terminal selection starts on mousedown; without this, clicking the chip
    // also drags a selection across the row underneath it.
    element.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    element.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openDiagram(paneId, diagramId);
    });
  });

  marker.onDispose(() => {
    decoration.dispose();
  });
}

// Swap the scraped source for the one Claude actually wrote, when it can be
// found. Silent on every failure: no transcript, no session, a pane that isn't
// Claude at all — the block already has a source that will very often render.
async function resolveExactSource(
  paneId: string,
  tracked: TrackedDiagram,
  instance: TerminalInstance,
  scraped: string
) {
  try {
    const path = await transcriptPath(instance.cwd, instance.sessionMeta?.id);
    if (!path || instance.disposed || tracked.exact) return;
    const backend = await getBackend();
    const tail = await backend.readFileTail(path, TRANSCRIPT_TAIL_BYTES);
    if (!tail) return;
    const match = pickTranscriptMatch(scraped, mermaidBlocksInTranscript(tail));
    if (!match || tracked.exact) return;
    // Latch it: from here the screen is no longer allowed to overwrite this
    // source, so a later scan of a block still being streamed can't undo it.
    tracked.exact = true;
    tracked.length = Number.MAX_SAFE_INTEGER;
    replaceDiagramSource(paneId, tracked.id, match, true);
  } catch (_) {
    // Nothing to do and nothing to say — the fallback is already in place.
  }
}
