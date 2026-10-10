/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import { isMac, os } from "./lib/platform";
import { refreshTerminalFonts } from "./lib/terminal-registry";
import "@xterm/xterm/css/xterm.css";
import "./styles/global.css";
import "./styles/markdown.css";
import "./styles/text.css";
import "./styles/image.css";
import "./styles/file-tree.css";

// Platform hook for OS-specific styling (e.g. macOS traffic-light spacing).
if (isMac) {
  document.documentElement.classList.add("is-mac");
}
if (os === "windows") {
  document.documentElement.classList.add("is-windows");
}

// Start fetching the bundled font now, alongside the rest of startup, rather
// than waiting for the first text to ask for it. Nothing waits on it — that
// would put it in front of the first shell. It's a local file and is normally
// in before the first terminal opens; if it isn't, the terminals are redrawn
// when it lands.
const FONT = '14px "Specterm Mono"';
if (!document.fonts.check(FONT)) {
  document.fonts.load(FONT).then(() => refreshTerminalFonts(true), () => {});
}
document.fonts.addEventListener("loadingdone", () => refreshTerminalFonts(false));

const root = document.getElementById("root");
if (root) {
  render(() => <App />, root);
}
