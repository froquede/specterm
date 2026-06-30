import { Terminal } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { spawnPty, writePty, resizePty, killPty, onPtyOutput, onPtyExit } from "./pty";
import { registerOscHandler } from "./osc";
import { themeToXterm, DEFAULT_THEME } from "./theme";
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
  ptyId: number | null;
  container: HTMLDivElement | null;
  unlistenOutput: UnlistenFn | null;
  unlistenExit: UnlistenFn | null;
  resizeObserver: ResizeObserver | null;
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

export function getTerminalInstance(paneId: string): TerminalInstance | undefined {
  return instances.get(paneId);
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
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
    allowTransparency: true,
    theme: currentXtermTheme,
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
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
    ptyId: null,
    container: null,
    unlistenOutput: null,
    unlistenExit: null,
    resizeObserver: null,
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

  // If already attached to this container, just re-fit
  if (instance.container === container) {
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

  try {
    const webglAddon = new WebglAddon();
    // Chromium caps the number of simultaneous WebGL contexts (~16). With many
    // open panes/tabs the oldest contexts get force-killed, which previously
    // left those terminals as a blank white canvas. Dispose the addon on
    // context loss so xterm falls back to the DOM renderer and keeps drawing.
    webglAddon.onContextLoss(() => {
      webglAddon.dispose();
    });
    term.loadAddon(webglAddon);
  } catch {
    // WebGL not available
  }

  fitAddon.fit();

  // Spawn PTY
  instance.ptyId = await spawnPty({
    cols: term.cols,
    rows: term.rows,
  });

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

  // Wire input
  term.onData((data) => {
    if (instance!.ptyId !== null) {
      writePty(instance!.ptyId, data);
    }
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
}

export function destroyTerminal(paneId: string) {
  const instance = instances.get(paneId);
  if (!instance) return;

  instance.disposed = true;
  instance.resizeObserver?.disconnect();
  instance.unlistenOutput?.();
  instance.unlistenExit?.();
  if (instance.ptyId !== null) {
    killPty(instance.ptyId);
  }
  instance.term.dispose();
  instances.delete(paneId);
}
