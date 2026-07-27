import { createSignal } from "solid-js";
import { getBackend } from "../backends";

// User-tunable settings, persisted to localStorage so they survive restarts.
// This is the first real "preferences" surface in specterm — the Settings panel
// (components/SettingsPanel.tsx) reads/writes these signals.
//
// Persisted shape (localStorage key "specterm.settings"):
//   { unfocusedOpacity, startupPath, lastBrowsedPath }
// Old blobs simply lack the newer keys, so loading is backward compatible.
//
// - unfocusedOpacity drives the `--unfocused-split-opacity` CSS variable (see
//   styles/global.css): the visible fraction of a non-active pane, so 1 = no
//   dimming, lower = washed further toward the fill.
// - windowOpacity is the alpha of the whole OS window (via
//   backend.setWindowOpacity: BrowserWindow.setOpacity on Windows/macOS, the
//   _NET_WM_WINDOW_OPACITY property on Linux/X11), so lower values let the
//   desktop behind the terminal show through. 1 = fully opaque (the default).
//   Unlike unfocusedOpacity this is not a CSS variable — it's a native window
//   property, applied through the backend on every change and once at startup.
// - startupPath is the directory new terminals spawn in AND the folder the file
//   tree opens at. Blank = the OS home directory.
// - lastBrowsedPath is the folder the file tree was last showing; it takes
//   precedence over startupPath when reopening (both are readability-checked).
// - tabBarCorner anchors the tab bar to one of the window's four corners: which
//   edge it sits on (top/bottom) and which side the tabs and action icons hug.
// - tabBarHeight and sidebarWidth size the two chrome surfaces.
// - tabBarAutoHide collapses the tab bar to a sliver that expands on hover, for
//   people who want the terminal to fill the window.

const STORAGE_KEY = "specterm.settings";

export const UNFOCUSED_OPACITY_DEFAULT = 0.35;
export const UNFOCUSED_OPACITY_MIN = 0.1;
export const UNFOCUSED_OPACITY_MAX = 1;

// Whole-window transparency. Default 1 (opaque); a floor of 0.3 keeps the
// terminal legible enough to find the slider again if someone drags it low.
export const WINDOW_OPACITY_DEFAULT = 1;
export const WINDOW_OPACITY_MIN = 0.3;
export const WINDOW_OPACITY_MAX = 1;

// The four corners the tab bar can anchor to: "<edge>-<side>".
export const TAB_BAR_CORNERS = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
] as const;
export type TabBarCorner = (typeof TAB_BAR_CORNERS)[number];
export const TAB_BAR_CORNER_DEFAULT: TabBarCorner = "top-left";

export const TAB_BAR_HEIGHT_DEFAULT = 36;
export const TAB_BAR_HEIGHT_MIN = 24;
export const TAB_BAR_HEIGHT_MAX = 56;

// --- Session restore -------------------------------------------------------
// What happens to a restored terminal that had a resumable session in it (see
// lib/session-providers). Defaults to "type" rather than "run": the restore path
// is the one place the app would put a command into a shell without the user
// having typed it, and a session id is a *remembered* fact — the session may
// have been deleted, or the project moved, since it was written down. Typing it
// leaves the decision (and the visible evidence of what's about to happen) with
// the person at the keyboard.
export const SESSION_RESTORE_MODES = ["off", "type", "run"] as const;
export type SessionRestoreMode = (typeof SESSION_RESTORE_MODES)[number];
export const SESSION_RESTORE_MODE_DEFAULT: SessionRestoreMode = "type";

// --- Clock -----------------------------------------------------------------
// An optional clock in the tab bar. Off by default: it's the one piece of
// chrome that would otherwise redraw on a timer forever, and a terminal that
// nobody asked for a clock in should have no timer at all. The format is a token
// string (see lib/clock-format) rather than a locale preset, so "HH:mm",
// "ddd DD/MM HH:mm" and "h:mm a" are all one field apart.
export const CLOCK_FORMAT_DEFAULT = "HH:mm";
// Long enough for any sensible format, short enough that a paste accident can't
// push a novel into the tab bar.
export const CLOCK_FORMAT_MAX = 64;

export const SIDEBAR_WIDTH_DEFAULT = 250;
// The settings panel shares the slot, and its controls stop being usable below
// this (see .settings-sidebar in global.css, which holds the same floor).
export const SIDEBAR_WIDTH_MIN = 200;
export const SIDEBAR_WIDTH_MAX = 640;

const clampTo = (min: number, max: number, fallback: number) => (v: number) =>
  Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

const clampOpacity = clampTo(
  UNFOCUSED_OPACITY_MIN,
  UNFOCUSED_OPACITY_MAX,
  UNFOCUSED_OPACITY_DEFAULT
);
const clampWindowOpacity = clampTo(
  WINDOW_OPACITY_MIN,
  WINDOW_OPACITY_MAX,
  WINDOW_OPACITY_DEFAULT
);
const clampTabBarHeight = clampTo(
  TAB_BAR_HEIGHT_MIN,
  TAB_BAR_HEIGHT_MAX,
  TAB_BAR_HEIGHT_DEFAULT
);
const clampSidebarWidth = clampTo(
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_DEFAULT
);

interface Persisted {
  unfocusedOpacity: number;
  windowOpacity: number;
  startupPath: string;
  lastBrowsedPath: string;
  tabBarCorner: TabBarCorner;
  tabBarHeight: number;
  tabBarAutoHide: boolean;
  sidebarWidth: number;
  restoreLastSession: boolean;
  sessionRestoreMode: SessionRestoreMode;
  clockEnabled: boolean;
  clockFormat: string;
}

const DEFAULTS: Persisted = {
  unfocusedOpacity: UNFOCUSED_OPACITY_DEFAULT,
  windowOpacity: WINDOW_OPACITY_DEFAULT,
  startupPath: "",
  lastBrowsedPath: "",
  tabBarCorner: TAB_BAR_CORNER_DEFAULT,
  tabBarHeight: TAB_BAR_HEIGHT_DEFAULT,
  tabBarAutoHide: false,
  sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
  restoreLastSession: true,
  sessionRestoreMode: SESSION_RESTORE_MODE_DEFAULT,
  clockEnabled: false,
  clockFormat: CLOCK_FORMAT_DEFAULT,
};

// Every field is read defensively: a blob written by an older version simply
// lacks the newer keys, and a hand-edited or corrupt one must not brick startup.
function load(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw) ?? {};
    const num = (v: unknown, clamp: (n: number) => number, fallback: number) =>
      typeof v === "number" ? clamp(v) : fallback;
    return {
      unfocusedOpacity: num(
        p.unfocusedOpacity,
        clampOpacity,
        DEFAULTS.unfocusedOpacity
      ),
      windowOpacity: num(
        p.windowOpacity,
        clampWindowOpacity,
        DEFAULTS.windowOpacity
      ),
      startupPath:
        typeof p.startupPath === "string" ? p.startupPath : DEFAULTS.startupPath,
      lastBrowsedPath:
        typeof p.lastBrowsedPath === "string"
          ? p.lastBrowsedPath
          : DEFAULTS.lastBrowsedPath,
      tabBarCorner: TAB_BAR_CORNERS.includes(p.tabBarCorner)
        ? p.tabBarCorner
        : DEFAULTS.tabBarCorner,
      tabBarHeight: num(
        p.tabBarHeight,
        clampTabBarHeight,
        DEFAULTS.tabBarHeight
      ),
      tabBarAutoHide:
        typeof p.tabBarAutoHide === "boolean"
          ? p.tabBarAutoHide
          : DEFAULTS.tabBarAutoHide,
      sidebarWidth: num(
        p.sidebarWidth,
        clampSidebarWidth,
        DEFAULTS.sidebarWidth
      ),
      restoreLastSession:
        typeof p.restoreLastSession === "boolean"
          ? p.restoreLastSession
          : DEFAULTS.restoreLastSession,
      sessionRestoreMode: SESSION_RESTORE_MODES.includes(p.sessionRestoreMode)
        ? p.sessionRestoreMode
        : DEFAULTS.sessionRestoreMode,
      clockEnabled:
        typeof p.clockEnabled === "boolean"
          ? p.clockEnabled
          : DEFAULTS.clockEnabled,
      clockFormat:
        typeof p.clockFormat === "string"
          ? p.clockFormat.slice(0, CLOCK_FORMAT_MAX)
          : DEFAULTS.clockFormat,
    };
  } catch (_) {
    // Corrupt or unavailable storage — fall back to defaults.
    return DEFAULTS;
  }
}

const initial = load();

const [unfocusedOpacity, setUnfocusedOpacitySignal] = createSignal(
  initial.unfocusedOpacity
);
const [windowOpacity, setWindowOpacitySignal] = createSignal(
  initial.windowOpacity
);
const [startupPath, setStartupPathSignal] = createSignal(initial.startupPath);
const [lastBrowsedPath, setLastBrowsedPathSignal] = createSignal(
  initial.lastBrowsedPath
);
const [tabBarCorner, setTabBarCornerSignal] = createSignal(initial.tabBarCorner);
const [tabBarHeight, setTabBarHeightSignal] = createSignal(initial.tabBarHeight);
const [tabBarAutoHide, setTabBarAutoHideSignal] = createSignal(
  initial.tabBarAutoHide
);
const [sidebarWidth, setSidebarWidthSignal] = createSignal(initial.sidebarWidth);
const [restoreLastSession, setRestoreLastSessionSignal] = createSignal(
  initial.restoreLastSession
);
const [sessionRestoreMode, setSessionRestoreModeSignal] =
  createSignal<SessionRestoreMode>(initial.sessionRestoreMode);
const [clockEnabled, setClockEnabledSignal] = createSignal(initial.clockEnabled);
const [clockFormat, setClockFormatSignal] = createSignal(initial.clockFormat);

export {
  unfocusedOpacity,
  windowOpacity,
  startupPath,
  lastBrowsedPath,
  tabBarCorner,
  tabBarHeight,
  tabBarAutoHide,
  sidebarWidth,
  restoreLastSession,
  sessionRestoreMode,
  clockEnabled,
  clockFormat,
};

/** Which window edge the tab bar sits on. */
export const tabBarEdge = () =>
  tabBarCorner().startsWith("top") ? "top" : "bottom";
/** Which side of that edge the tabs and action icons hug. */
export const tabBarSide = () =>
  tabBarCorner().endsWith("left") ? "left" : "right";

// Push layout-driving settings into CSS variables on :root, where the
// stylesheet consumes them. An inline style on documentElement overrides the
// `:root { ... }` defaults in global.css.
function applyCssVars() {
  const root = document.documentElement.style;
  root.setProperty("--unfocused-split-opacity", String(unfocusedOpacity()));
  root.setProperty("--tab-bar-height", `${tabBarHeight()}px`);
  root.setProperty("--sidebar-width", `${sidebarWidth()}px`);
}

// Window opacity is a native window property, not a CSS variable, so it goes
// through the backend rather than the DOM. Fire-and-forget: on a platform/WM
// that can't honor it (some Linux compositors), the call simply no-ops and the
// window stays opaque — never a reason to break settings.
function applyWindowOpacity() {
  getBackend()
    .then((backend) => backend.setWindowOpacity(windowOpacity()))
    .catch(() => {
      /* backend unavailable or opacity unsupported — leave the window opaque. */
    });
}

function persist() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        unfocusedOpacity: unfocusedOpacity(),
        windowOpacity: windowOpacity(),
        startupPath: startupPath(),
        lastBrowsedPath: lastBrowsedPath(),
        tabBarCorner: tabBarCorner(),
        tabBarHeight: tabBarHeight(),
        tabBarAutoHide: tabBarAutoHide(),
        sidebarWidth: sidebarWidth(),
        restoreLastSession: restoreLastSession(),
        sessionRestoreMode: sessionRestoreMode(),
        clockEnabled: clockEnabled(),
        clockFormat: clockFormat(),
      } satisfies Persisted)
    );
  } catch (_) {
    // localStorage unavailable — the change just won't survive this session.
  }
}

export function setUnfocusedOpacity(v: number) {
  setUnfocusedOpacitySignal(clampOpacity(v));
  applyCssVars();
  persist();
}

export function resetUnfocusedOpacity() {
  setUnfocusedOpacity(UNFOCUSED_OPACITY_DEFAULT);
}

export function setWindowOpacity(v: number) {
  setWindowOpacitySignal(clampWindowOpacity(v));
  applyWindowOpacity();
  persist();
}

export function resetWindowOpacity() {
  setWindowOpacity(WINDOW_OPACITY_DEFAULT);
}

// --- Chrome layout ---------------------------------------------------------
// Changing the tab bar's height or the sidebar's width resizes the terminal
// panes; the ResizeObserver on each pane picks that up and refits xterm, so
// nothing here has to reach into the terminals.

export function setTabBarCorner(v: TabBarCorner) {
  setTabBarCornerSignal(TAB_BAR_CORNERS.includes(v) ? v : TAB_BAR_CORNER_DEFAULT);
  persist();
}

export function setTabBarHeight(v: number) {
  setTabBarHeightSignal(clampTabBarHeight(v));
  applyCssVars();
  persist();
}

export function setTabBarAutoHide(v: boolean) {
  setTabBarAutoHideSignal(v);
  persist();
}

export function setSidebarWidth(v: number) {
  setSidebarWidthSignal(clampSidebarWidth(v));
  applyCssVars();
  persist();
}

export function resetChromeLayout() {
  setTabBarCornerSignal(TAB_BAR_CORNER_DEFAULT);
  setTabBarHeightSignal(TAB_BAR_HEIGHT_DEFAULT);
  setTabBarAutoHideSignal(false);
  setSidebarWidthSignal(SIDEBAR_WIDTH_DEFAULT);
  applyCssVars();
  persist();
}

// The directory new terminals and the file tree start in. Blank = OS home.
export function setStartupPath(v: string) {
  setStartupPathSignal(v.trim());
  persist();
}

// Remembered on every file-tree navigation so the sidebar reopens where it was.
export function setLastBrowsedPath(v: string) {
  setLastBrowsedPathSignal(v);
  persist();
}

// --- Session restore -------------------------------------------------------
// Read at module load by stores/tabs.ts, which builds its initial state from the
// saved session rather than restoring after the fact — a tab that appears and is
// then replaced would have already spawned (and orphaned) a shell.

export function setRestoreLastSession(v: boolean) {
  setRestoreLastSessionSignal(v);
  persist();
}

// --- Clock -----------------------------------------------------------------

export function setClockEnabled(v: boolean) {
  setClockEnabledSignal(v);
  persist();
}

// An empty format would render an empty box in the bar, so it falls back to the
// default rather than leaving the user with a clock they can't see to fix.
export function setClockFormat(v: string) {
  const trimmed = v.slice(0, CLOCK_FORMAT_MAX);
  setClockFormatSignal(trimmed.trim() === "" ? CLOCK_FORMAT_DEFAULT : trimmed);
  persist();
}

export function setSessionRestoreMode(v: SessionRestoreMode) {
  setSessionRestoreModeSignal(
    SESSION_RESTORE_MODES.includes(v) ? v : SESSION_RESTORE_MODE_DEFAULT
  );
  persist();
}

// Apply persisted values once at startup. Called from App's onMount.
export function initSettings() {
  applyCssVars();
  applyWindowOpacity();
}
