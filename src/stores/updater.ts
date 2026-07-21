import { createSignal } from "solid-js";
import { getBackend } from "../backends";
import type { UpdaterEvent } from "../backends/types";

// App-wide auto-update state. It lives outside SettingsPanel because two things
// need it to outlive the panel: the automatic check fired once at launch (the
// panel is lazy-mounted and usually closed then), and any download that keeps
// running while the user closes and reopens Settings. The panel reads these
// signals; the store owns the backend subscription and the state machine.

export type UpdaterPhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

const [updaterPhase, setUpdaterPhase] = createSignal<UpdaterPhase>("idle");
const [updaterVersion, setUpdaterVersion] = createSignal("");
const [updaterPercent, setUpdaterPercent] = createSignal(0);
const [updaterError, setUpdaterError] = createSignal<string | null>(null);
// Bumped every time a check concludes the app is already current. The panel
// watches this to flash its "up to date" toast — a tick (not a boolean) so two
// consecutive up-to-date checks each re-trigger the animation.
const [upToDateTick, setUpToDateTick] = createSignal(0);

export {
  updaterPhase,
  updaterVersion,
  updaterPercent,
  updaterError,
  upToDateTick,
};

function applyUpdaterEvent(e: UpdaterEvent) {
  switch (e.status) {
    case "checking":
      setUpdaterError(null);
      setUpdaterPhase("checking");
      break;
    case "available":
      setUpdaterVersion(e.version ?? "");
      setUpdaterPhase("available");
      break;
    case "not-available":
    case "dev":
      // "dev" = unpackaged/experimental backend with no real feed; treat it as
      // "you're current" so the button never sticks on "Checking…".
      setUpdaterPhase("idle");
      setUpToDateTick((t) => t + 1);
      break;
    case "progress":
      setUpdaterPercent(Math.round(e.percent ?? 0));
      setUpdaterPhase("downloading");
      break;
    case "downloaded":
      setUpdaterPhase("downloaded");
      break;
    case "error":
      setUpdaterError(e.message ?? "Update failed.");
      setUpdaterPhase("error");
      break;
  }
}

let initialized = false;

// Subscribe to host updater events and run the launch-time check. The
// single-instance lock (see electron/main.cjs) makes a second launch of an
// already-running Specterm forward to the existing window without re-running
// the renderer, so this fires exactly once per real cold start — "check on
// open", manual thereafter.
export async function initUpdater() {
  if (initialized) return;
  initialized = true;
  const backend = await getBackend();
  await backend.onUpdaterEvent(applyUpdaterEvent);
  await backend.checkForUpdate();
}

export async function checkForUpdate() {
  const backend = await getBackend();
  setUpdaterError(null);
  setUpdaterPhase("checking");
  await backend.checkForUpdate();
}

export async function downloadUpdate() {
  const backend = await getBackend();
  setUpdaterPhase("downloading");
  setUpdaterPercent(0);
  await backend.downloadUpdate();
}

export async function installUpdate() {
  const backend = await getBackend();
  await backend.installUpdate();
}
