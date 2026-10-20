import { createSignal, createUniqueId, type JSX } from "solid-js";
import { ICON_STROKE } from "../lib/icons";
import { IconInfo } from "../lib/icons-lazy";

// What a setting does, kept behind an icon beside its label until it's asked
// for.
//
// The panel used to put a paragraph of small grey text under nearly every
// setting. Read once, they are noise every time after, and together they
// buried the controls they were there to explain. Hovering or focusing the icon
// shows the text; a click keeps it open until focus moves on. What the panel
// says about the current state — an error, a live preview, "nothing matches" —
// isn't explanation and stays on the page.
//
// The text opens under the row the icon sits in, as wide as the row (see
// .settings-info-pop): the sidebar is too narrow for a tooltip that hangs off
// the icon itself.
export default function SettingsInfo(props: { about: string; children: JSX.Element }) {
  const [pinned, setPinned] = createSignal(false);
  const id = createUniqueId();
  return (
    <span class="settings-info" classList={{ pinned: pinned() }}>
      <button
        type="button"
        class="settings-info-button"
        aria-label={`About ${props.about}`}
        aria-describedby={id}
        aria-expanded={pinned()}
        onClick={() => setPinned((v) => !v)}
        onBlur={() => setPinned(false)}
      >
        <IconInfo size={12} stroke-width={ICON_STROKE} />
      </button>
      <span id={id} role="tooltip" class="settings-info-pop">
        {props.children}
      </span>
    </span>
  );
}
