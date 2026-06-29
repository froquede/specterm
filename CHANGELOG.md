# Changelog

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
