import { onMount, onCleanup } from "solid-js";
import { attachTerminal, detachTerminal } from "../lib/terminal-registry";

interface TerminalPaneProps {
  paneId: string;
  // Directory this pane's shell should start in — carried on the pane since the
  // split that created it (see tabs.ts). Only read on first mount: a remount
  // from a split or a cross-tab drag reuses the live terminal, which already
  // has its own cwd.
  cwd?: string;
  onTitle?: (title: string) => void;
  onExit?: () => void;
  onOpenMarkdown?: (path: string, mode: "split" | "tab") => void;
}

export default function TerminalPane(props: TerminalPaneProps) {
  let containerRef!: HTMLDivElement;

  onMount(() => {
    attachTerminal(props.paneId, containerRef, {
      initialCwd: props.cwd,
      onTitle: props.onTitle,
      onExit: props.onExit,
      onOpenMarkdown: props.onOpenMarkdown,
    });
  });

  onCleanup(() => {
    // Only detach (disconnect resize observer), don't destroy
    detachTerminal(props.paneId);
  });

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        overflow: "hidden",
        background: "transparent",
      }}
    />
  );
}
