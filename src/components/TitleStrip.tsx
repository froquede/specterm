import { Show } from "solid-js";
import { isMac } from "../lib/platform";
import { ownControls, isFullscreen } from "../stores/window-chrome";
import { tabBarEdge } from "../stores/settings";
import WindowControls from "./WindowControls";

// A bare strip along the top of the window, present only when the tab bar has
// been moved to the bottom edge.
//
// The tab bar being the title bar works because it is where a title bar goes.
// Move it to the bottom and that stops being true: the window controls travel
// down there with it, which is not where anyone reaches for them, and on macOS
// the traffic lights don't travel at all — the OS keeps drawing them over the
// top-left corner, where they land on top of the terminal.
//
// So the top edge keeps a strip of its own. It carries the window controls
// (or, on macOS, nothing but the room the traffic lights need) and a drag
// region, which the window would otherwise have lost entirely: with no frame
// and no bar up top there is nothing left to grab.
//
// Nothing here when the tab bar is at the top — it is the strip in that layout —
// and nothing in fullscreen, where the OS has taken the chrome away and there is
// no window to move, minimise or restore.
export default function TitleStrip() {
  const shown = () =>
    tabBarEdge() === "bottom" && !isFullscreen() && (ownControls() || isMac);

  return (
    <Show when={shown()}>
      <div class="title-strip" data-mac={isMac ? "true" : "false"}>
        <div class="title-strip-drag" />
        <Show when={ownControls()}>
          <WindowControls />
        </Show>
      </div>
    </Show>
  );
}
