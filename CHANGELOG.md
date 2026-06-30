# Changelog

## 0.7.0 — 2026-06-30

### Added
- Color themes — pick from five built-ins (Tokyo Night, Catppuccin Mocha,
  Gruvbox Dark, Nord, Catppuccin Latte) in the Settings panel. The choice is
  persisted and recolors both the terminal and the whole app at once
- Theme gallery — browse and apply 325 bundled base16 schemes from Settings,
  with a name filter and color swatches. Bundled offline (no network needed);
  refresh with `node scripts/fetch-base16-schemes.mjs`
- base16 theme import — three ways to add your own: paste a scheme (YAML/JSON),
  open a `.yaml`/`.json` file, or drag a scheme file onto the window. Imported
  themes can be removed
- Light-theme support — the chrome now adapts to light palettes (Catppuccin
  Latte ships as the first light built-in)

### Changed
- The Tokyo Night palette is no longer hardcoded: the app chrome is driven by
  CSS variables on `:root` and the terminal palette comes from a single theme
  model (`src/lib/theme.ts`), so a theme change updates every surface in sync

## 0.6.1 — 2026-06-29

### Added
- Settings panel (⚙ icon, `⌘,` shortcut) with a customizable, persisted
  unfocused-pane opacity

### Fixed
- Fullscreen works again on Electron (it was calling the Tauri window API, which
  doesn't exist in the main build) — window controls now go through the backend
- Settings slider: dragging the handle is no longer cancelled on every move
  (rewriting `value` during the `input` event was killing the drag in Chromium)

### Changed
- Active pane has no border anymore — focus is signaled solely by dimming the
  others (Ghostty-style)

## 0.3.0 — 2026-06-26

### Added
- Drag-and-drop to reorder panes + a button to toggle the split orientation
- Per-pane title bars
- Windows support (native shell resolution in the Tauri backend)
- File tree with search, keyboard navigation and autocomplete
- macOS install scripts (`install:mac`)

### Fixed
- Terminals turning into a white screen when exceeding the WebGL context limit
  (they now fall back to the DOM renderer instead of freezing)
- Focus moves to the newly created pane on split
- Pane title (e.g. Claude's `/rename`) preserved across remounts
- Duplicate `mac` key in `package.json`

### Changed
- Unified `⌘B`: opens the sidebar + focuses search, or closes it
- Local shortcuts preserved; upstream split shortcuts (`⌘⇧S`, `⌘⇧↵`) not
  adopted (see `docs/decisao-atalhos.md`)
