import { Show, onMount, onCleanup } from "solid-js";
import {
  unfocusedOpacity,
  setUnfocusedOpacity,
  resetUnfocusedOpacity,
  UNFOCUSED_OPACITY_MIN,
  UNFOCUSED_OPACITY_MAX,
  UNFOCUSED_OPACITY_DEFAULT,
} from "../stores/settings";

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
}

// Modal settings panel — the first preferences surface. Rendered as an overlay
// above the app; click the backdrop or press Esc to dismiss.
export default function SettingsPanel(props: SettingsPanelProps) {
  // The slider's `value` is driven imperatively via this ref, NOT bound to the
  // signal. Reassigning a range input's `.value` during an `input` event (which
  // a reactive `value={...}` binding would do) cancels an in-progress thumb
  // drag in Chromium — clicks survive but dragging the handle dies. Keeping the
  // input uncontrolled lets the native drag run; we still mirror every change
  // into the signal for the live preview, the % label and persistence.
  let sliderRef: HTMLInputElement | undefined;

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && props.open) {
      e.preventDefault();
      props.onClose();
    }
  }

  onMount(() => window.addEventListener("keydown", onKeyDown));
  onCleanup(() => window.removeEventListener("keydown", onKeyDown));

  function reset() {
    resetUnfocusedOpacity();
    if (sliderRef) sliderRef.value = String(UNFOCUSED_OPACITY_DEFAULT);
  }

  const pct = () => Math.round(unfocusedOpacity() * 100);

  return (
    <Show when={props.open}>
      <div class="settings-backdrop" onClick={props.onClose}>
        <div
          class="settings-panel"
          role="dialog"
          aria-label="Settings"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="settings-header">
            <span class="settings-title">Settings</span>
            <button class="settings-close" onClick={props.onClose} title="Close (Esc)">
              ×
            </button>
          </div>

          <div class="settings-section">
            <div class="settings-row">
              <label class="settings-label" for="unfocused-opacity">
                Unfocused pane opacity
              </label>
              <span class="settings-value">{pct()}%</span>
            </div>
            <input
              ref={(el) => {
                // Seed the initial position once, on mount, without a reactive
                // `value={...}` binding — see the note above on drag-cancelling.
                sliderRef = el;
                el.value = String(unfocusedOpacity());
              }}
              id="unfocused-opacity"
              class="settings-slider"
              type="range"
              min={UNFOCUSED_OPACITY_MIN}
              max={UNFOCUSED_OPACITY_MAX}
              step={0.05}
              onInput={(e) => setUnfocusedOpacity(Number(e.currentTarget.value))}
            />
            <div class="settings-row">
              <span class="settings-hint">
                How visible inactive split panes are. 100% = no dimming.
              </span>
              <Show when={unfocusedOpacity() !== UNFOCUSED_OPACITY_DEFAULT}>
                <button class="settings-reset" onClick={reset}>
                  Reset
                </button>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
