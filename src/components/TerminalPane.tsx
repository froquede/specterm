import { onMount, onCleanup } from "solid-js";
import { attachTerminal, detachTerminal } from "../lib/terminal-registry";

interface TerminalPaneProps {
  paneId: string;
  onTitle?: (title: string) => void;
  onExit?: () => void;
  onOpenMarkdown?: (path: string, mode: "split" | "tab") => void;
}

export default function TerminalPane(props: TerminalPaneProps) {
  let containerRef!: HTMLDivElement;

  onMount(() => {
    attachTerminal(props.paneId, containerRef, {
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
        background: "#1a1b26",
      }}
    />
  );
}
