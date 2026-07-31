import { Show } from "solid-js";
import {
  isMaximized,
  minimizeWindow,
  toggleMaximizeWindow,
  closeWindow,
} from "../stores/window-chrome";
import { IconMinus, IconSquare, IconRestore, IconX } from "../lib/icons";

// Minimise / maximise / close, for the platforms where the app has taken the
// frame off and there is nothing left to click. Two things mount this: the tab
// bar, when it is up at the top standing in for the title bar, and the title
// strip, when the tab bar has been moved to the bottom edge and these have to
// stay behind. Same buttons, same order, same hit areas either way.
//
// Drawn a size smaller and a hair thinner than the rest of the chrome (12px at
// stroke 1.5, against 15/1.75): these are hairline glyphs on every platform
// that ships them, and at the chrome's default weight they read as buttons
// competing with the tabs rather than as window furniture.
const SIZE = 12;
const STROKE = 1.5;

export default function WindowControls() {
  return (
    <div class="tab-window-controls">
      <button
        class="tab-window-btn"
        onClick={() => void minimizeWindow()}
        title="Minimise"
        aria-label="Minimise"
      >
        <IconMinus size={SIZE} stroke-width={STROKE} />
      </button>
      <button
        class="tab-window-btn"
        onClick={() => void toggleMaximizeWindow()}
        title={isMaximized() ? "Restore" : "Maximise"}
        aria-label={isMaximized() ? "Restore" : "Maximise"}
      >
        <Show
          when={isMaximized()}
          fallback={<IconSquare size={SIZE} stroke-width={STROKE} />}
        >
          {/* Two offset outlines — the conventional "restore down" glyph.
              Mirrored so the front pane sits bottom-left, the way every
              platform draws it; Lucide's copy icon has it top-left. */}
          <IconRestore
            size={SIZE}
            stroke-width={STROKE}
            class="icon-flip-x"
          />
        </Show>
      </button>
      <button
        class="tab-window-btn tab-window-close"
        onClick={() => void closeWindow()}
        title="Close window"
        aria-label="Close window"
      >
        <IconX size={SIZE} stroke-width={STROKE} />
      </button>
    </div>
  );
}
