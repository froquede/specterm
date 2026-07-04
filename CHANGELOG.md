# Changelog

## 0.8.2 — 2026-07-03

### Added
- `cd fav-N` expansion — typing `cd fav-1` (or any favorite index) at the shell
  prompt now expands to a real `cd` into the path pinned at that 1-based
  favorite, mirroring the sidebar-search `fav-N` token. A real directory named
  `fav-N` in the current folder wins: the shell tries it first
  (`cd fav-N 2>/dev/null || cd '<favpath>'`) and only falls back to the favorite
  path when that fails. Only plain-typed lines expand — arrows, history recall
  and tab-completion leave the line untouched

## 0.8.1 — 2026-07-02

### Fixed
- Splitting a pane, opening a tab, toggling the sidebar and refitting terminals
  on window resize all stopped working after the first pane teardown. The pane
  component's cleanup read `props.id`, a reactive getter that dereferences the
  backing split-tree leaf — already `null` once the pane is unmounting (e.g. a
  split replaces the leaf with a split subtree). The resulting
  `Cannot read properties of null (reading 'id')` threw inside Solid's disposal
  and poisoned the whole reactive render, freezing every subsequent update. The
  id is now captured once at mount, since a pane's id never changes for its
  lifetime

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
