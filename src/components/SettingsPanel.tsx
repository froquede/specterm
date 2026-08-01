import {
  Show,
  For,
  createSignal,
  createMemo,
  createEffect,
  onMount,
  onCleanup,
  type JSX,
  type Component,
} from "solid-js";
import {
  unfocusedOpacity,
  setUnfocusedOpacity,
  resetUnfocusedOpacity,
  UNFOCUSED_OPACITY_MIN,
  UNFOCUSED_OPACITY_MAX,
  UNFOCUSED_OPACITY_DEFAULT,
  windowOpacity,
  setWindowOpacity,
  resetWindowOpacity,
  WINDOW_OPACITY_MIN,
  WINDOW_OPACITY_MAX,
  WINDOW_OPACITY_DEFAULT,
  startupPath,
  setStartupPath,
  clockEnabled,
  setClockEnabled,
  clockFormat,
  setClockFormat,
  CLOCK_FORMAT_MAX,
  restoreLastSession,
  setRestoreLastSession,
  backgroundSessions,
  setBackgroundSessions,
  customTitleBar,
  setCustomTitleBar,
  sessionRestoreMode,
  setSessionRestoreMode,
  type SessionRestoreMode,
  claudeAttentionMode,
  setClaudeAttentionMode,
  type ClaudeAttentionMode,
  desktopNotifications,
  setDesktopNotifications,
  tabBarCorner,
  setTabBarCorner,
  TAB_BAR_CORNERS,
  TAB_BAR_CORNER_DEFAULT,
  tabBarHeight,
  setTabBarHeight,
  TAB_BAR_HEIGHT_MIN,
  TAB_BAR_HEIGHT_MAX,
  TAB_BAR_HEIGHT_DEFAULT,
  tabBarAutoHide,
  setTabBarAutoHide,
  sidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  resetChromeLayout,
} from "../stores/settings";
import { getBackend } from "../backends";
import {
  updaterPhase,
  updaterVersion,
  updaterPercent,
  updaterError,
  upToDateTick,
  checkForUpdate,
  downloadUpdate,
  installUpdate,
} from "../stores/updater";
import {
  activeTheme,
  availableThemes,
  galleryThemes,
  setActiveTheme,
  importBase16Theme,
  removeCustomTheme,
} from "../stores/theme";
import type { Theme } from "../lib/theme";
import {
  terminalFontFamily,
  setTerminalFontFamily,
} from "../lib/terminal-registry";
import { detectMonospaceFonts } from "../lib/fonts";
import { formatClock } from "../lib/clock-format";
import {
  hooksSupported,
  hooksInstalled,
  installHooks,
  removeHooks,
} from "../lib/claude-hooks";
import { IconChevronDown, IconSettings, ICON_STROKE } from "../lib/icons";
import {
  IconAppearance,
  IconLayout,
  IconTerminal,
  IconSessions,
  IconUpdates,
} from "../lib/icons-lazy";

interface SettingsPanelProps {
  onClose: () => void;
}

// Which categories are folded away. Module-level rather than component state:
// the panel is unmounted every time the sidebar closes, and a fold that came
// undone each time you looked away would be worse than no fold at all. Not
// persisted to disk either — this is a working position, not a preference, and
// it costs nothing to start a new session with everything in view.
const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());

// One category of settings: a header that folds it away, and the fields.
//
// The panel used to be a single column of every setting there is, separated by
// hairlines, each one a label with a paragraph of explanation directly under it
// and nothing to say where one ended and the next began. Grouping is the fix:
// four or five things you would go looking for together, under a heading that
// says what they are, foldable so the ones you have already set can get out of
// the way of the one you came for.
function Category(props: {
  id: string;
  title: string;
  icon: Component<{ size?: number; "stroke-width"?: number }>;
  children: JSX.Element;
}) {
  const open = () => !collapsed().has(props.id);
  const toggle = () =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(props.id)) next.add(props.id);
      return next;
    });

  return (
    <section class="settings-category" classList={{ folded: !open() }}>
      <button
        class="settings-category-head"
        onClick={toggle}
        aria-expanded={open()}
      >
        <props.icon size={14} stroke-width={ICON_STROKE} />
        <span class="settings-category-title">{props.title}</span>
        <span class="settings-category-caret">
          <IconChevronDown size={14} stroke-width={ICON_STROKE} />
        </span>
      </button>
      <Show when={open()}>
        <div class="settings-category-body">{props.children}</div>
      </Show>
    </section>
  );
}

// Six representative swatches for a gallery row: background, accent, and the
// four most recognizable ANSI hues.
function swatches(t: Theme): string[] {
  return [t.ui.bg, t.ui.accent, t.ansi.red, t.ansi.green, t.ansi.yellow, t.ui.fg];
}

// Settings sidebar — the preferences surface. Renders in the same slot as the
// file/search sidebar (they're mutually exclusive), full height with a
// scrollable body. Press Esc to dismiss.
export default function SettingsPanel(props: SettingsPanelProps) {
  // The slider's `value` is driven imperatively via this ref, NOT bound to the
  // signal. Reassigning a range input's `.value` during an `input` event (which
  // a reactive `value={...}` binding would do) cancels an in-progress thumb
  // drag in Chromium — clicks survive but dragging the handle dies. Keeping the
  // input uncontrolled lets the native drag run; we still mirror every change
  // into the signal for the live preview, the % label and persistence.
  let sliderRef: HTMLInputElement | undefined;
  let windowSliderRef: HTMLInputElement | undefined;
  let fileRef: HTMLInputElement | undefined;

  // base16 paste import: a collapsible textarea so the panel stays compact.
  const [importOpen, setImportOpen] = createSignal(false);
  const [importText, setImportText] = createSignal("");
  const [importError, setImportError] = createSignal<string | null>(null);

  // Gallery browser (the 325 bundled base16 schemes), with a name filter.
  const [galleryOpen, setGalleryOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");

  // Clock format: a local draft while typing (same reason as the startup path
  // below), plus a preview rendered from the draft so a half-typed format shows
  // what it would produce before it's committed. The preview only re-renders on
  // keystrokes — it's not on a timer.
  const [clockDraft, setClockDraft] = createSignal(clockFormat());
  const clockPreview = () => formatClock(clockDraft() || " ", new Date());

  // Claude hooks: whether our two entries are currently in the user's
  // ~/.claude/settings.json. Re-read whenever the "exact" mode is selected
  // rather than kept in our own settings — the file is the user's, they can
  // edit it out from under us, and it is the only thing that decides whether
  // the hooks actually fire.
  const [hooksOn, setHooksOn] = createSignal(false);
  const [hooksBusy, setHooksBusy] = createSignal(false);
  const [hooksError, setHooksError] = createSignal<string | null>(null);

  createEffect(() => {
    if (claudeAttentionMode() !== "hooks" || !hooksSupported) return;
    void hooksInstalled().then(setHooksOn);
  });

  async function toggleHooks() {
    setHooksBusy(true);
    setHooksError(null);
    try {
      if (hooksOn()) {
        await removeHooks();
        setHooksOn(false);
      } else {
        await installHooks();
        setHooksOn(true);
      }
    } catch (err) {
      // The most likely cause by far is a settings.json that doesn't parse, and
      // the right move there is to say so and change nothing.
      setHooksError(err instanceof Error ? err.message : String(err));
    } finally {
      setHooksBusy(false);
    }
  }

  // Startup-directory field: a local draft so the user can type freely; the
  // store (and terminal/sidebar behavior) only updates on commit (blur/Enter),
  // where we also validate that the path is readable.
  const [startupDraft, setStartupDraft] = createSignal(startupPath());
  const [startupError, setStartupError] = createSignal<string | null>(null);

  async function commitStartupPath() {
    const value = startupDraft().trim();
    setStartupDraft(value);
    if (!value) {
      setStartupError(null);
      setStartupPath("");
      return;
    }
    try {
      const backend = await getBackend();
      await backend.readDir(value);
      setStartupError(null);
      setStartupPath(value);
    } catch (_) {
      // Keep the draft visible but don't persist an unreadable path.
      setStartupError("That folder can't be read — leaving the previous value.");
    }
  }

  // Installed monospace fonts, detected lazily when the panel first mounts.
  const [fonts, setFonts] = createSignal<string[]>([]);
  const [fontsLoading, setFontsLoading] = createSignal(true);
  onMount(async () => {
    try {
      setFonts(await detectMonospaceFonts());
    } finally {
      setFontsLoading(false);
    }
  });

  const filteredGallery = createMemo(() => {
    const q = query().trim().toLowerCase();
    const all = galleryThemes();
    return q ? all.filter((t) => t.name.toLowerCase().includes(q)) : all;
  });

  // Esc closes the panel. Listen in the *capture* phase: the terminal usually
  // still holds keyboard focus while the sidebar is open (it's opened by a
  // shortcut, or focus returns to it), and xterm stops Escape from propagating
  // — it's a key it forwards to the pty — so a bubble-phase listener never sees
  // it. Capturing on window runs before xterm's textarea handler.
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    }
  }

  onMount(() => window.addEventListener("keydown", onKeyDown, true));
  onCleanup(() => window.removeEventListener("keydown", onKeyDown, true));

  function reset() {
    resetUnfocusedOpacity();
    if (sliderRef) sliderRef.value = String(UNFOCUSED_OPACITY_DEFAULT);
  }

  function resetWindow() {
    resetWindowOpacity();
    if (windowSliderRef) windowSliderRef.value = String(WINDOW_OPACITY_DEFAULT);
  }

  function applyImport() {
    const theme = importBase16Theme(importText());
    if (!theme) {
      setImportError("Not a valid base16 scheme (need base00–base0F).");
      return;
    }
    setImportError(null);
    setImportText("");
    setImportOpen(false);
  }

  async function onFilePicked(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // allow re-picking the same file later
    if (!file) return;
    const theme = importBase16Theme(await file.text());
    if (!theme) {
      setImportError(`"${file.name}" isn't a valid base16 scheme.`);
      setImportOpen(true);
    } else {
      setImportError(null);
    }
  }

  // Autosave acknowledgement: every setting persists live to localStorage the
  // moment it changes (see stores/settings.ts), so there's no explicit Save.
  // Once edits settle for SAVED_DEBOUNCE_MS we flash a toast, which then fades.
  //
  // The panel only exists while the sidebar shows it (App mounts it lazily), so
  // these timers can't outlive it and the effect can't fire for changes made
  // while it's closed. `createEffect`'s first run happens on mount, which is not
  // an edit — hence the explicit skip via the memo's previous value.
  const SAVED_DEBOUNCE_MS = 1500;
  const SAVED_VISIBLE_MS = 2500;

  const [saved, setSaved] = createSignal(false);
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  // A fingerprint of everything the panel persists. Tracking it in one memo
  // keeps the "what counts as an edit" list in a single place.
  const persistedSettings = createMemo(() =>
    JSON.stringify([
      unfocusedOpacity(),
      windowOpacity(),
      startupPath(),
      terminalFontFamily(),
      activeTheme().id,
      tabBarCorner(),
      tabBarHeight(),
      tabBarAutoHide(),
      sidebarWidth(),
    ])
  );

  createEffect((previous: string | undefined) => {
    const current = persistedSettings();
    // First run is the mount, not an edit.
    if (previous === undefined || previous === current) return current;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      setSaved(true);
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => setSaved(false), SAVED_VISIBLE_MS);
    }, SAVED_DEBOUNCE_MS);
    return current;
  });

  onCleanup(() => {
    clearTimeout(debounceTimer);
    clearTimeout(hideTimer);
  });

  // === Auto-update ===
  // The button is the whole flow: "Check for updates" → "New vX available" →
  // (click) the button turns into a 0–100% progress bar while downloading →
  // "Restart Specterm?" once done. Two absolute toasters fade in above the
  // button: "up to date" after a check finds none, and "Update finished,
  // restart to apply" when a download completes. The state machine and host
  // subscription live in stores/updater (they outlive this lazily-mounted
  // panel); here we read the signals and drive the toasts.
  const [toastMsg, setToastMsg] = createSignal("");
  const [toastMounted, setToastMounted] = createSignal(false);
  const [toastVisible, setToastVisible] = createSignal(false);
  let toastHideTimer: ReturnType<typeof setTimeout> | undefined;
  let toastUnmountTimer: ReturnType<typeof setTimeout> | undefined;

  function flashToast(msg: string) {
    clearTimeout(toastHideTimer);
    clearTimeout(toastUnmountTimer);
    setToastMsg(msg);
    setToastMounted(true);
    // Next frame: flip to visible so the enter transition runs from hidden.
    requestAnimationFrame(() => setToastVisible(true));
    toastHideTimer = setTimeout(() => {
      setToastVisible(false);
      toastUnmountTimer = setTimeout(() => setToastMounted(false), 300);
    }, 5000);
  }

  // The store bumps upToDateTick each time a check finds the app current. Skip
  // the mount run (not a check) and flash on every later bump.
  createEffect((previous: number | undefined) => {
    const tick = upToDateTick();
    if (previous !== undefined && tick !== previous) {
      flashToast("Your Specterm is up to date");
    }
    return tick;
  });

  // A download that just completed: flash the finish toaster once, on the
  // transition into "downloaded" (not on a mount where it's already there).
  createEffect((wasDownloaded: boolean | undefined) => {
    const isDownloaded = updaterPhase() === "downloaded";
    if (wasDownloaded === false && isDownloaded) {
      flashToast("Update finished, restart to apply");
    }
    return isDownloaded;
  });

  onCleanup(() => {
    clearTimeout(toastHideTimer);
    clearTimeout(toastUnmountTimer);
  });

  function onUpdaterButton() {
    const phase = updaterPhase();
    if (phase === "available") {
      void downloadUpdate();
    } else if (phase === "downloaded") {
      void installUpdate();
    } else if (phase === "downloading") {
      // The bar is progressing — clicks are inert (button is disabled anyway).
      return;
    } else {
      // idle / error → run a fresh check.
      void checkForUpdate();
    }
  }

  const updaterLabel = () => {
    switch (updaterPhase()) {
      case "checking":
        return "Checking…";
      case "available":
        return `New v${updaterVersion()} available`;
      case "downloading":
        return `Downloading… ${updaterPercent()}%`;
      case "downloaded":
        return "Restart Specterm?";
      case "error":
        return "Retry check";
      default:
        return "Check for updates";
    }
  };
  const updaterDownloading = () => updaterPhase() === "downloading";
  const updaterBusy = () =>
    updaterPhase() === "checking" || updaterDownloading();

  const pct = () => Math.round(unfocusedOpacity() * 100);
  const winPct = () => Math.round(windowOpacity() * 100);
  const chromeLayoutIsCustom = () =>
    tabBarCorner() !== TAB_BAR_CORNER_DEFAULT ||
    tabBarHeight() !== TAB_BAR_HEIGHT_DEFAULT ||
    sidebarWidth() !== SIDEBAR_WIDTH_DEFAULT ||
    tabBarAutoHide();
  const activeIsCustom = () => !activeTheme().builtin && !activeTheme().id.startsWith("gallery-");

  return (
    <div class="settings-sidebar" role="complementary" aria-label="Settings">
      <div class="settings-header">
        <IconSettings size={14} stroke-width={ICON_STROKE} />
        <span class="settings-title">Settings</span>
        {/* No Save button — changes persist live and autosave (see the effect
            above). Esc closes the sidebar. */}
      </div>
      <Show when={saved()}>
        <div class="settings-saved-bar" role="status" aria-live="polite">
          All settings saved.
        </div>
      </Show>
      <div class="settings-scroll">
        {/* ---- Appearance ------------------------------------------------- */}
        <Category id="appearance" title="Appearance" icon={IconAppearance}>
          <div class="settings-section">
            <div class="settings-row">
              <label class="settings-label" for="theme-select">
                Theme
              </label>
              <Show when={activeIsCustom()}>
                <button
                  class="settings-reset"
                  onClick={() => removeCustomTheme(activeTheme().id)}
                >
                  Remove
                </button>
              </Show>
            </div>
            <select
              id="theme-select"
              class="settings-select"
              value={activeTheme().id}
              onChange={(e) => setActiveTheme(e.currentTarget.value)}
            >
              <For each={availableThemes()}>
                {(t) => <option value={t.id}>{t.name}</option>}
              </For>
              {/* Keep the picker showing the active gallery theme by name. */}
              <Show when={activeTheme().id.startsWith("gallery-")}>
                <option value={activeTheme().id}>{activeTheme().name}</option>
              </Show>
            </select>

            <div class="settings-actions">
              <button
                class="settings-action"
                onClick={() => setGalleryOpen((v) => !v)}
              >
                {galleryOpen()
                  ? "Hide gallery"
                  : `Browse gallery (${galleryThemes().length})`}
              </button>
              <button class="settings-action" onClick={() => fileRef?.click()}>
                Open file…
              </button>
              <button
                class="settings-action"
                onClick={() => setImportOpen((v) => !v)}
              >
                {importOpen() ? "Cancel paste" : "Paste…"}
              </button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".yaml,.yml,.json,.txt"
              style={{ display: "none" }}
              onChange={onFilePicked}
            />

            <Show when={galleryOpen()}>
              <input
                class="settings-search"
                type="text"
                placeholder="Filter themes…"
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
              />
              <div class="theme-gallery">
                <For each={filteredGallery()}>
                  {(t) => (
                    <button
                      class="theme-gallery-item"
                      classList={{ active: t.id === activeTheme().id }}
                      title={t.name}
                      onClick={() => setActiveTheme(t.id)}
                    >
                      <span class="theme-swatches">
                        <For each={swatches(t)}>
                          {(color) => (
                            <span
                              class="theme-swatch"
                              style={{ background: color }}
                            />
                          )}
                        </For>
                      </span>
                      <span class="theme-gallery-name">{t.name}</span>
                    </button>
                  )}
                </For>
                <Show when={filteredGallery().length === 0}>
                  <div class="settings-hint">No themes match “{query()}”.</div>
                </Show>
              </div>
            </Show>

            <Show when={importOpen()}>
              <textarea
                class="settings-textarea"
                placeholder="Paste a base16 scheme (YAML or JSON)…"
                value={importText()}
                onInput={(e) => setImportText(e.currentTarget.value)}
                rows={6}
              />
              <div class="settings-row">
                <span class="settings-hint">base00–base0F → terminal + chrome.</span>
                <button
                  class="settings-reset"
                  disabled={!importText().trim()}
                  onClick={applyImport}
                >
                  Apply theme
                </button>
              </div>
            </Show>

            <Show when={importError()}>
              <div class="settings-error">{importError()}</div>
            </Show>
            <p class="settings-hint">
              Drag a base16 file onto the window, or browse hundreds of schemes
              above. Imports recolor the terminal and the app.
            </p>
          </div>

          <div class="settings-section">
            <div class="settings-row">
              <label class="settings-label" for="font-select">
                Terminal font
              </label>
              <Show when={terminalFontFamily() !== ""}>
                <button
                  class="settings-reset"
                  onClick={() => setTerminalFontFamily("")}
                >
                  Reset
                </button>
              </Show>
            </div>
            <select
              id="font-select"
              class="settings-select"
              value={terminalFontFamily()}
              onChange={(e) => setTerminalFontFamily(e.currentTarget.value)}
            >
              <option value="">Default (bundled)</option>
              {/* Keep a persisted pick visible even if detection hasn't run or
                  no longer lists it (e.g. font uninstalled). */}
              <Show
                when={
                  terminalFontFamily() && !fonts().includes(terminalFontFamily())
                }
              >
                <option value={terminalFontFamily()}>
                  {terminalFontFamily()}
                </option>
              </Show>
              <For each={fonts()}>
                {(f) => (
                  <option value={f} style={{ "font-family": `'${f}', monospace` }}>
                    {f}
                  </option>
                )}
              </For>
            </select>
            <p class="settings-hint">
              {fontsLoading()
                ? "Detecting installed monospace fonts…"
                : `${fonts().length} monospace font${fonts().length === 1 ? "" : "s"} found on this system.`}
            </p>
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
              <p class="settings-hint">
                How visible inactive split panes are. 100% = no dimming.
              </p>
              <Show when={unfocusedOpacity() !== UNFOCUSED_OPACITY_DEFAULT}>
                <button class="settings-reset" onClick={reset}>
                  Reset
                </button>
              </Show>
            </div>
          </div>

          <div class="settings-section">
            <div class="settings-row">
              <label class="settings-label" for="window-opacity">
                Window opacity
              </label>
              <span class="settings-value">{winPct()}%</span>
            </div>
            <input
              ref={(el) => {
                // Seed the position once, on mount — same uncontrolled-slider
                // reasoning as the unfocused-opacity control above (a reactive
                // `value={...}` binding cancels an in-progress thumb drag).
                windowSliderRef = el;
                el.value = String(windowOpacity());
              }}
              id="window-opacity"
              class="settings-slider"
              type="range"
              min={WINDOW_OPACITY_MIN}
              max={WINDOW_OPACITY_MAX}
              step={0.05}
              onInput={(e) => setWindowOpacity(Number(e.currentTarget.value))}
            />
            <div class="settings-row">
              <p class="settings-hint">
                Whole-window transparency, so the desktop shows through. 100% =
                opaque.
              </p>
              <Show when={windowOpacity() !== WINDOW_OPACITY_DEFAULT}>
                <button class="settings-reset" onClick={resetWindow}>
                  Reset
                </button>
              </Show>
            </div>
          </div>
        </Category>

        {/* ---- Layout ----------------------------------------------------- */}
        <Category id="layout" title="Layout" icon={IconLayout}>
          <div class="settings-section">
            <div class="settings-row">
              <span class="settings-label">Tab bar corner</span>
              <Show when={chromeLayoutIsCustom()}>
                <button class="settings-reset" onClick={resetChromeLayout}>
                  Reset all
                </button>
              </Show>
            </div>
            {/* A 2×2 grid of the window's corners, laid out as the corners
                themselves — picking one is aiming at it, not reading a label. */}
            <div
              class="corner-picker"
              role="radiogroup"
              aria-label="Tab bar corner"
            >
              <For each={TAB_BAR_CORNERS}>
                {(corner) => (
                  <button
                    class="corner-option"
                    classList={{ active: tabBarCorner() === corner }}
                    data-corner={corner}
                    role="radio"
                    aria-checked={tabBarCorner() === corner}
                    aria-label={corner.replace("-", " ")}
                    title={corner.replace("-", " ")}
                    onClick={() => setTabBarCorner(corner)}
                  >
                    <span class="corner-bar" />
                  </button>
                )}
              </For>
            </div>
            <p class="settings-hint">
              Which edge the tabs sit on, and which end of it they hug. Moved to
              the bottom, the window controls stay up top where you reach for
              them.
            </p>
            <p class="settings-hint">
              The sidebar's width is set by dragging the edge between it and the
              panes — one width for both the file tree and this panel, so
              switching between them never shifts the layout. <em>Reset all</em>
              puts it back too.
            </p>
          </div>

          <div class="settings-section">
            <div class="settings-row">
              <label class="settings-label" for="tab-bar-height">
                Tab bar height
              </label>
              <span class="settings-value">{tabBarHeight()}px</span>
            </div>
            <input
              id="tab-bar-height"
              class="settings-slider"
              type="range"
              min={TAB_BAR_HEIGHT_MIN}
              max={TAB_BAR_HEIGHT_MAX}
              step={1}
              value={tabBarHeight()}
              onInput={(e) => setTabBarHeight(Number(e.currentTarget.value))}
            />
          </div>

          <div class="settings-section">
            <div class="settings-row">
              <label class="settings-label" for="tab-bar-autohide">
                Auto-hide the tab bar
              </label>
              <input
                id="tab-bar-autohide"
                type="checkbox"
                class="settings-checkbox"
                checked={tabBarAutoHide()}
                onChange={(e) => setTabBarAutoHide(e.currentTarget.checked)}
              />
            </div>
            <p class="settings-hint">
              Panes take the whole window; the bar slides back in when you reach
              for its edge.
            </p>
          </div>

          <div class="settings-section">
            <div class="settings-row">
              <label class="settings-label" for="custom-title-bar">
                Tab bar replaces the title bar
              </label>
              <input
                id="custom-title-bar"
                type="checkbox"
                class="settings-checkbox"
                checked={customTitleBar()}
                onChange={(e) => setCustomTitleBar(e.currentTarget.checked)}
              />
            </div>
            <p class="settings-hint">
              Drops the system title bar and puts the window controls in the tab
              bar, so the panes get the space back. Takes effect on the next
              window — a frame can't be added to or taken off one that's already
              open. macOS always works this way. On Linux the frame comes off
              entirely and resizing is then up to your compositor, so turn this
              off if that ends up worse than the decorations it replaced.
            </p>
          </div>

          <div class="settings-section">
            <div class="settings-row">
              <label class="settings-label" for="clock-enabled">
                Clock in the tab bar
              </label>
              <input
                id="clock-enabled"
                type="checkbox"
                class="settings-checkbox"
                checked={clockEnabled()}
                onChange={(e) => setClockEnabled(e.currentTarget.checked)}
              />
            </div>
            <Show when={clockEnabled()}>
              <input
                id="clock-format"
                class="settings-select"
                type="text"
                maxLength={CLOCK_FORMAT_MAX}
                value={clockDraft()}
                onInput={(e) => setClockDraft(e.currentTarget.value)}
                onBlur={() => setClockFormat(clockDraft())}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
              <p class="settings-hint">
                Now: <strong>{clockPreview()}</strong> — <code>HH</code>{" "}
                <code>mm</code> <code>ss</code> <code>DD</code> <code>MM</code>{" "}
                <code>YYYY</code> <code>ddd</code> <code>h</code> <code>a</code>.
                Wrap literal text in brackets: <code>[at] HH:mm</code>. Seconds
                make it tick every second instead of every minute.
              </p>
            </Show>
          </div>
        </Category>

        {/* ---- Terminal --------------------------------------------------- */}
        <Category id="terminal" title="Terminal" icon={IconTerminal}>
          <div class="settings-section">
            <div class="settings-row">
              <label class="settings-label" for="startup-path">
                Default terminal path
              </label>
              <Show when={startupPath() !== ""}>
                <button
                  class="settings-reset"
                  onClick={() => {
                    setStartupDraft("");
                    setStartupError(null);
                    setStartupPath("");
                  }}
                >
                  Reset
                </button>
              </Show>
            </div>
            <input
              id="startup-path"
              class="settings-select"
              type="text"
              placeholder="Leave blank for home directory"
              value={startupDraft()}
              onInput={(e) => setStartupDraft(e.currentTarget.value)}
              onBlur={commitStartupPath}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
            <Show when={startupError()}>
              <div class="settings-error">{startupError()}</div>
            </Show>
            <p class="settings-hint">
              Where new terminals open and the file sidebar starts. Blank uses
              your home directory.
            </p>
          </div>
        </Category>

        {/* ---- Sessions --------------------------------------------------- */}
        <Category id="sessions" title="Sessions" icon={IconSessions}>
          <div class="settings-section">
            <div class="settings-row">
              <label class="settings-label" for="restore-last-session">
                Reopen tabs on start
              </label>
              <input
                id="restore-last-session"
                type="checkbox"
                class="settings-checkbox"
                checked={restoreLastSession()}
                onChange={(e) => setRestoreLastSession(e.currentTarget.checked)}
              />
            </div>
            <p class="settings-hint">
              Brings back the tabs, splits, directories and screens you had open,
              with the names they had. The shells are new — nothing you were
              running is restarted.
            </p>
          </div>

          <div class="settings-section">
            <div class="settings-row">
              <label class="settings-label" for="background-sessions">
                Keep shells running when a window closes
              </label>
              <input
                id="background-sessions"
                type="checkbox"
                class="settings-checkbox"
                checked={backgroundSessions()}
                onChange={(e) => setBackgroundSessions(e.currentTarget.checked)}
              />
            </div>
            <p class="settings-hint">
              Closing a window detaches it instead of ending it: your shells keep
              running and a tray icon brings them back, exactly where they were.
              Quit — from the tray menu or the app menu — is what actually ends
              them. Off means closing a window closes it for good, and a restart
              falls back to reopening the tabs above.
            </p>
          </div>

          <div class="settings-section">
            <div class="settings-row">
              <label class="settings-label" for="session-restore-mode">
                Resumable sessions
              </label>
            </div>
            <select
              id="session-restore-mode"
              class="settings-select"
              value={sessionRestoreMode()}
              onChange={(e) =>
                setSessionRestoreMode(e.currentTarget.value as SessionRestoreMode)
              }
            >
              <option value="off">Ignore them</option>
              <option value="type">Type the resume command</option>
              <option value="run">Run the resume command</option>
            </select>
            <p class="settings-hint">
              When a restored pane was running Claude Code, its session is
              remembered. "Type" leaves <code>claude --resume …</code> at the
              prompt for you to confirm; "run" submits it.
            </p>
          </div>

          <div class="settings-section">
            <div class="settings-row">
              <label class="settings-label" for="claude-attention-mode">
                Flag panes waiting on you
              </label>
            </div>
            <select
              id="claude-attention-mode"
              class="settings-select"
              value={claudeAttentionMode()}
              onChange={(e) =>
                setClaudeAttentionMode(
                  e.currentTarget.value as ClaudeAttentionMode
                )
              }
            >
              <option value="off">Off</option>
              <option value="heuristic">On — detect it</option>
              <option value="hooks">On — let Claude say so</option>
            </select>
            <p class="settings-hint">
              A dot on the tab and on the pane's title-bar when Claude Code has
              finished a turn or is asking permission, so you can leave it running
              in another tab. "Detect it" needs no setup and watches for a pane
              that was working going quiet. A terminal bell counts either way.
            </p>

            <Show when={claudeAttentionMode() === "hooks"}>
              <Show
                when={hooksSupported}
                fallback={
                  <p class="settings-hint">
                    Not available on Windows — the hook writes to{" "}
                    <code>/dev/tty</code>, which it has no equivalent of. Use
                    "detect it" instead.
                  </p>
                }
              >
                <div class="settings-actions">
                  <button
                    class="settings-action"
                    disabled={hooksBusy()}
                    onClick={toggleHooks}
                  >
                    {hooksBusy()
                      ? "Working…"
                      : hooksOn()
                        ? "Remove hooks"
                        : "Install hooks…"}
                  </button>
                </div>
                <p class="settings-hint">
                  Adds a <code>Notification</code> and a <code>Stop</code> hook to{" "}
                  <code>~/.claude/settings.json</code>; each writes one escape
                  sequence to the pane it runs in. Nothing else in that file is
                  touched, and "Remove" takes back exactly these two. Sessions
                  already running pick the hooks up on their next turn.
                </p>
                <Show when={hooksError()}>
                  <div class="settings-error">{hooksError()}</div>
                </Show>
              </Show>
            </Show>
          </div>

          <Show when={claudeAttentionMode() !== "off"}>
            <div class="settings-section">
              <div class="settings-row">
                <label class="settings-label" for="desktop-notifications">
                  Also send a desktop notification
                </label>
                <input
                  id="desktop-notifications"
                  type="checkbox"
                  class="settings-checkbox"
                  checked={desktopNotifications()}
                  onChange={(e) =>
                    setDesktopNotifications(e.currentTarget.checked)
                  }
                />
              </div>
              <p class="settings-hint">
                Off by default — the dot, the dock badge and the taskbar flash
                already say it without interrupting anything. When on it stays
                quiet: silent, one per pane per wait (not one per message), only
                while this window is in the background, and never more than one
                at a time however many panes finish together. Programs that send
                a notification sequence (<code>OSC 9</code>, <code>777</code>,{" "}
                <code>99</code>) have their message carried through.
              </p>
            </div>
          </Show>
        </Category>

        {/* ---- Updates ---------------------------------------------------- */}
        <Category id="updates" title="Updates" icon={IconUpdates}>
          <div class="settings-section">
            {/* Toast anchor: position:relative so the absolutely-positioned
                up-to-date toast sits directly above the button, overlapping the
                content, and fades in/out. */}
            <div class="updater-control">
              <Show when={toastMounted()}>
                <div
                  class="updater-toast"
                  classList={{ visible: toastVisible() }}
                  role="status"
                  aria-live="polite"
                >
                  {toastMsg()}
                </div>
              </Show>
              {/* While downloading the button becomes a progress bar: an accent
                  fill grows left→right to the percentage. A second copy of the
                  label, clipped to the filled region and painted in the bg color,
                  overlays the base label so the text stays legible on both the
                  filled (accent) and unfilled (chrome) sides. */}
              <button
                class="settings-action updater-button"
                classList={{
                  ready: updaterPhase() === "downloaded",
                  downloading: updaterDownloading(),
                }}
                style={
                  updaterDownloading()
                    ? { "--progress": `${updaterPercent()}%` }
                    : undefined
                }
                disabled={updaterBusy()}
                onClick={onUpdaterButton}
              >
                <Show when={updaterDownloading()}>
                  <span class="updater-fill" aria-hidden="true" />
                  <span class="updater-label over" aria-hidden="true">
                    {updaterLabel()}
                  </span>
                </Show>
                <span class="updater-label base">{updaterLabel()}</span>
              </button>
            </div>
            <Show when={updaterError()}>
              <div class="settings-error">{updaterError()}</div>
            </Show>
            <p class="settings-hint">
              Checks GitHub for the latest release and installs it in place.
            </p>
          </div>
        </Category>
      </div>
      <div class="settings-version">Specterm v{__APP_VERSION__}</div>
    </div>
  );
}
