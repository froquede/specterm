import { createSignal } from "solid-js";
import { getBackend } from "../backends";
import { publishStoreChange, registerStoreSync } from "../lib/store-sync";

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

// --- Claude attention ------------------------------------------------------
// Whether a pane that has stopped and is waiting on you gets flagged (see
// stores/attention.ts), and how that's found out:
//
//   off       — nothing is watched and nothing is drawn.
//   heuristic — no setup at all. A pane known to be running Claude Code goes
//               from "producing output steadily" to silent, which is what the
//               end of a turn and a permission prompt both look like from
//               outside the process. Version-proof (it reads no UI text), at
//               the cost of the occasional false positive from an unrelated
//               long command finishing in the same pane.
//   hooks     — exact. Claude Code's own Notification/Stop hooks write a
//               private OSC into the pane (see lib/claude-hooks.ts), so the
//               app is told rather than guessing, instantly, and can tell a
//               permission prompt apart from a finished turn. Needs the hooks
//               installed into ~/.claude/settings.json once, which the
//               Settings panel offers to do.
//
// The terminal bell is honored in both non-off modes: it is what a program of
// any kind uses to say "look at me", and Claude Code rings it when its
// notification channel is set to terminal_bell.
export const CLAUDE_ATTENTION_MODES = ["off", "heuristic", "hooks"] as const;
export type ClaudeAttentionMode = (typeof CLAUDE_ATTENTION_MODES)[number];
export const CLAUDE_ATTENTION_MODE_DEFAULT: ClaudeAttentionMode = "heuristic";

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
  backgroundSessions: boolean;
  claudeAttentionMode: ClaudeAttentionMode;
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
  backgroundSessions: true,
  sessionRestoreMode: SESSION_RESTORE_MODE_DEFAULT,
  claudeAttentionMode: CLAUDE_ATTENTION_MODE_DEFAULT,
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
      backgroundSessions:
        typeof p.backgroundSessions === "boolean"
          ? p.backgroundSessions
          : DEFAULTS.backgroundSessions,
      sessionRestoreMode: SESSION_RESTORE_MODES.includes(p.sessionRestoreMode)
        ? p.sessionRestoreMode
        : DEFAULTS.sessionRestoreMode,
      claudeAttentionMode: CLAUDE_ATTENTION_MODES.includes(
        p.claudeAttentionMode
      )
        ? p.claudeAttentionMode
        : DEFAULTS.claudeAttentionMode,
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
const [backgroundSessions, setBackgroundSessionsSignal] = createSignal(
  initial.backgroundSessions
);
const [sessionRestoreMode, setSessionRestoreModeSignal] =
  createSignal<SessionRestoreMode>(initial.sessionRestoreMode);
const [claudeAttentionMode, setClaudeAttentionModeSignal] =
  createSignal<ClaudeAttentionMode>(initial.claudeAttentionMode);
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
  backgroundSessions,
  sessionRestoreMode,
  claudeAttentionMode,
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
        backgroundSessions: backgroundSessions(),
        sessionRestoreMode: sessionRestoreMode(),
        claudeAttentionMode: claudeAttentionMode(),
        clockEnabled: clockEnabled(),
        clockFormat: clockFormat(),
      } satisfies Persisted)
    );
  } catch (_) {
    // localStorage unavailable — the change just won't survive this session.
  }
  // Other windows hold their own copy of all this; tell them to re-read.
  publishStoreChange("settings");
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

// Pull the stored values back into the signals after another window wrote them.
// `lastBrowsedPath` is deliberately left alone: it's where *this* window's file
// tree happens to be sitting, saved for the next launch — syncing it would yank
// every other window's sidebar to wherever someone else just clicked.
// Every persisted field belongs here except `lastBrowsedPath`. Missing one
// doesn't fail loudly — it just makes that preference silently stop crossing
// windows — so this reads the whole blob and assigns all of it.
function reloadFromStorage() {
  const p = load();
  setUnfocusedOpacitySignal(p.unfocusedOpacity);
  setWindowOpacitySignal(p.windowOpacity);
  setStartupPathSignal(p.startupPath);
  setTabBarCornerSignal(p.tabBarCorner);
  setTabBarHeightSignal(p.tabBarHeight);
  setTabBarAutoHideSignal(p.tabBarAutoHide);
  setSidebarWidthSignal(p.sidebarWidth);
  setRestoreLastSessionSignal(p.restoreLastSession);
  setBackgroundSessionsSignal(p.backgroundSessions);
  pushBackgroundSessions();
  setSessionRestoreModeSignal(p.sessionRestoreMode);
  setClaudeAttentionModeSignal(p.claudeAttentionMode);
  setClockEnabledSignal(p.clockEnabled);
  setClockFormatSignal(p.clockFormat);
  applyCssVars();
  applyWindowOpacity();
}

// --- Session restore -------------------------------------------------------
// Read at module load by stores/tabs.ts, which builds its initial state from the
// saved session rather than restoring after the fact — a tab that appears and is
// then replaced would have already spawned (and orphaned) a shell.

export function setRestoreLastSession(v: boolean) {
  setRestoreLastSessionSignal(v);
  persist();
  // The host decides how many windows to open at launch, before any renderer is
  // there to ask, so it has to be told when this changes.
  pushBackgroundSessions();
}

// --- Background sessions ---------------------------------------------------
//
// Whether closing a window detaches it — its shells keep running with no window
// attached, and a tray icon is how you get back to them (see the detached-session
// block in electron/main.cjs). This is the only setting the *host* has to know
// about rather than read: the decision is made in its window-close handler,
// before any renderer could be asked anything. So every change is pushed, and so
// is the current value at startup.
//
// Fire-and-forget on purpose: a backend with no such notion (Tauri, a single
// window that can't outlive itself) no-ops it, and a failure here must never
// stop a settings write.
function pushBackgroundSessions() {
  void getBackend()
    .then((backend) => {
      backend.setBackgroundSessions(backgroundSessions());
      // The host also needs both of these *before any window exists* — how many
      // windows to reopen at launch, and whether closing one detaches it — so it
      // keeps its own mirror of them, refreshed from here.
      backend.pushSessionPrefs({
        restoreLastSession: restoreLastSession(),
        backgroundSessions: backgroundSessions(),
      });
    })
    .catch(() => {
      /* Host doesn't do detaching — closing a window just closes it. */
    });
}

export function setBackgroundSessions(v: boolean) {
  setBackgroundSessionsSignal(v);
  persist();
  pushBackgroundSessions();
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

// --- Claude attention ------------------------------------------------------
// Switching modes only changes what is *watched* from here on; the flags that
// are already up are dropped by an effect in App, which is also what puts the
// dock badge out.

export function setClaudeAttentionMode(v: ClaudeAttentionMode) {
  setClaudeAttentionModeSignal(
    CLAUDE_ATTENTION_MODES.includes(v) ? v : CLAUDE_ATTENTION_MODE_DEFAULT
  );
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
  registerStoreSync("settings", reloadFromStorage);
  applyCssVars();
  applyWindowOpacity();
  // The host defaults to detaching; tell it the persisted answer before the first
  // window can be closed.
  pushBackgroundSessions();
}
