import { createSignal, onCleanup, Show } from "solid-js";
import { IconWifiOff } from "../lib/icons";

// An offline marker beside the tab-bar clock.
//
// Mounted only while the clock and this option are both on (see Clock), and
// driven by the `online`/`offline` events, so it never polls. It shows only
// while offline: a permanent "connected" icon would be noise in the corner.
//
// `navigator.onLine` means "has a network interface up", not "can reach the
// internet" — a captive portal or a dead router still reads as online. That is
// the honest limit of what it can tell, and the settings hint says so.
export default function Offline() {
  const [offline, setOffline] = createSignal(!navigator.onLine);

  const update = () => setOffline(!navigator.onLine);
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  onCleanup(() => {
    window.removeEventListener("online", update);
    window.removeEventListener("offline", update);
  });

  // Smaller than the battery's 16px on purpose: the battery's drawn body is only
  // a third of its box, but the wifi fan and its slash fill nearly all of this
  // one, so at the same size it towers over the digits. 13px brings its visible
  // height close to the text; the heavier stroke keeps it from going spindly.
  return (
    <Show when={offline()}>
      <span class="tab-offline" title="Offline — no network connection">
        <IconWifiOff size={13} stroke-width={2} />
      </span>
    </Show>
  );
}
