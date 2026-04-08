import { onMount, onCleanup } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { spawnPty, writePty, resizePty, killPty, onPtyOutput, onPtyExit } from "../lib/pty";
import type { UnlistenFn } from "@tauri-apps/api/event";

interface TerminalPaneProps {
  onTitle?: (title: string) => void;
  onExit?: () => void;
}

export default function TerminalPane(props: TerminalPaneProps) {
  let containerRef!: HTMLDivElement;
  let term: Terminal;
  let fitAddon: FitAddon;
  let ptyId: number | null = null;
  let unlistenOutput: UnlistenFn | null = null;
  let unlistenExit: UnlistenFn | null = null;
  let resizeObserver: ResizeObserver | null = null;

  onMount(async () => {
    term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      theme: {
        background: "#1a1b26",
        foreground: "#c0caf5",
        cursor: "#c0caf5",
        selectionBackground: "#33467c",
        black: "#15161e",
        red: "#f7768e",
        green: "#9ece6a",
        yellow: "#e0af68",
        blue: "#7aa2f7",
        magenta: "#bb9af7",
        cyan: "#7dcfff",
        white: "#a9b1d6",
        brightBlack: "#414868",
        brightRed: "#f7768e",
        brightGreen: "#9ece6a",
        brightYellow: "#e0af68",
        brightBlue: "#7aa2f7",
        brightMagenta: "#bb9af7",
        brightCyan: "#7dcfff",
        brightWhite: "#c0caf5",
      },
      allowProposedApi: true,
    });

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    term.open(containerRef);

    // Try WebGL renderer, fall back to canvas
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      // WebGL not available, canvas renderer is fine
    }

    fitAddon.fit();

    // Spawn PTY
    ptyId = await spawnPty({
      cols: term.cols,
      rows: term.rows,
    });

    // Wire output: PTY -> terminal
    unlistenOutput = await onPtyOutput((id, data) => {
      if (id === ptyId) {
        term.write(data);
      }
    });

    // Wire exit
    unlistenExit = await onPtyExit((id) => {
      if (id === ptyId) {
        term.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n");
        props.onExit?.();
      }
    });

    // Wire input: terminal -> PTY
    term.onData((data) => {
      if (ptyId !== null) {
        writePty(ptyId, data);
      }
    });

    // Wire resize
    term.onResize(({ cols, rows }) => {
      if (ptyId !== null) {
        resizePty(ptyId, cols, rows);
      }
    });

    // Wire title changes
    term.onTitleChange((title) => {
      props.onTitle?.(title);
    });

    // ResizeObserver for container size changes
    let fitTimeout: number | null = null;
    resizeObserver = new ResizeObserver(() => {
      if (fitTimeout) cancelAnimationFrame(fitTimeout);
      fitTimeout = requestAnimationFrame(() => {
        fitAddon.fit();
      });
    });
    resizeObserver.observe(containerRef);

    term.focus();
  });

  onCleanup(() => {
    resizeObserver?.disconnect();
    unlistenOutput?.();
    unlistenExit?.();
    if (ptyId !== null) {
      killPty(ptyId);
    }
    term?.dispose();
  });

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        overflow: "hidden",
        background: "#1a1b26",
      }}
    />
  );
}
