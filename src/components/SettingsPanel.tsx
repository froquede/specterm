import { Show, For, createSignal, createMemo, onMount, onCleanup } from "solid-js";
import {
  unfocusedOpacity,
  setUnfocusedOpacity,
  resetUnfocusedOpacity,
  UNFOCUSED_OPACITY_MIN,
  UNFOCUSED_OPACITY_MAX,
  UNFOCUSED_OPACITY_DEFAULT,
} from "../stores/settings";
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

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
}

// Six representative swatches for a gallery row: background, accent, and the
// four most recognizable ANSI hues.
function swatches(t: Theme): string[] {
  return [t.ui.bg, t.ui.accent, t.ansi.red, t.ansi.green, t.ansi.yellow, t.ui.fg];
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
  let fileRef: HTMLInputElement | undefined;

  // base16 paste import: a collapsible textarea so the panel stays compact.
  const [importOpen, setImportOpen] = createSignal(false);
  const [importText, setImportText] = createSignal("");
  const [importError, setImportError] = createSignal<string | null>(null);

  // Gallery browser (the 325 bundled base16 schemes), with a name filter.
  const [galleryOpen, setGalleryOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");

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

  const pct = () => Math.round(unfocusedOpacity() * 100);
  const activeIsCustom = () => !activeTheme().builtin && !activeTheme().id.startsWith("gallery-");

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
                {galleryOpen() ? "Hide gallery" : `Browse gallery (${galleryThemes().length})`}
              </button>
              <button class="settings-action" onClick={() => fileRef?.click()}>
                Open file…
              </button>
              <button class="settings-action" onClick={() => setImportOpen((v) => !v)}>
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
                            <span class="theme-swatch" style={{ background: color }} />
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
            <div class="settings-hint">
              Drag a base16 file onto the window, or browse hundreds of schemes
              above. Imports recolor the terminal and the app.
            </div>
          </div>

          <div class="settings-divider" />

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
                  terminalFontFamily() &&
                  !fonts().includes(terminalFontFamily())
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
            <div class="settings-hint">
              {fontsLoading()
                ? "Detecting installed monospace fonts…"
                : `${fonts().length} monospace font${fonts().length === 1 ? "" : "s"} found on this system.`}
            </div>
          </div>

          <div class="settings-divider" />

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
