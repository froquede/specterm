// Theme model for Specterm.
//
// A terminal emulator has TWO color surfaces and a theme drives both from one
// definition:
//
//   1. The xterm.js terminal palette  — bg/fg/cursor/selection + 16 ANSI colors
//      (`ansi`). Pushed into every live `Terminal` via terminal-registry.
//   2. The app chrome (tabs, sidebar, panes, markdown reader) — CSS custom
//      properties on `:root` (`ui` + the `--ansi-*` vars), consumed by the
//      stylesheets in src/styles.
//
// This module is PURE: types, the built-in themes, the base16 importer, and the
// two converters (`themeToCssVars`, `themeToXterm`). All state lives in
// stores/theme.ts so the lib stays free of side effects and import cycles.

import type { ITheme } from "@xterm/xterm";

// The 16 ANSI colors plus the terminal's special slots. Mirrors xterm's ITheme
// (minus `background`, which we always render transparent — see themeToXterm).
export interface AnsiPalette {
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

// Semantic UI roles for the app chrome. Each maps to one `--*` CSS variable
// (see CSS_VAR_NAMES below). `bg` must match the terminal background the user
// perceives, since the xterm canvas is transparent and shows `.app` through it.
export interface UiPalette {
  bg: string; // main background (shows through the transparent terminal)
  bgChrome: string; // tab bar, pane title-bars, sidebar, code blocks
  bgHover: string; // hover / subtly raised surfaces
  border: string; // dividers and outlines
  selection: string; // text selection background in chrome (matches terminal)
  unfocusedFill: string; // wash blended over inactive split panes
  fg: string; // primary text
  fgMuted: string; // secondary text, hints, inactive tabs
  fgFaint: string; // tertiary text, punctuation, scrollbar thumb
  fgBright: string; // emphasized text (ANSI "white")
  accent: string; // links, active indicators, slider, focus ring
  accentFg: string; // readable text on top of `accent`/`danger`
  danger: string; // destructive affordances (close-on-hover)
}

export interface Theme {
  id: string;
  name: string;
  type: "dark" | "light";
  ansi: AnsiPalette;
  ui: UiPalette;
  builtin?: boolean;
}

// ---------------------------------------------------------------------------
// Built-in themes
// ---------------------------------------------------------------------------

// Tokyo Night — Specterm's original look, kept pixel-identical to the values
// that used to be hardcoded in terminal-registry.ts and the stylesheets.
const TOKYO_NIGHT: Theme = {
  id: "tokyo-night",
  name: "Tokyo Night",
  type: "dark",
  builtin: true,
  ansi: {
    foreground: "#c0caf5",
    cursor: "#c0caf5",
    cursorAccent: "#1a1b26",
    selectionBackground: "#33467c",
    selectionForeground: "#c0caf5",
    black: "#15161e",
    red: "#f7768e",
    green: "#9ece6a",
    yellow: "#e0af68",
    blue: "#7aa2f7",
    magenta: "#bb9af7",
    cyan: "#7dcfff",
    white: "#a9b1d6",
    brightBlack: "#414868",
    brightRed: "#f7768e",
    brightGreen: "#9ece6a",
    brightYellow: "#e0af68",
    brightBlue: "#7aa2f7",
    brightMagenta: "#bb9af7",
    brightCyan: "#7dcfff",
    brightWhite: "#c0caf5",
  },
  ui: {
    bg: "#1a1b26",
    bgChrome: "#16161e",
    bgHover: "#292e42",
    border: "#292e42",
    selection: "#33467c",
    unfocusedFill: "#15161e",
    fg: "#c0caf5",
    fgMuted: "#565f89",
    fgFaint: "#414868",
    fgBright: "#a9b1d6",
    accent: "#7aa2f7",
    accentFg: "#1a1b26",
    danger: "#f7768e",
  },
};

const CATPPUCCIN_MOCHA: Theme = {
  id: "catppuccin-mocha",
  name: "Catppuccin Mocha",
  type: "dark",
  builtin: true,
  ansi: {
    foreground: "#cdd6f4",
    cursor: "#f5e0dc",
    cursorAccent: "#1e1e2e",
    selectionBackground: "#585b70",
    selectionForeground: "#cdd6f4",
    black: "#45475a",
    red: "#f38ba8",
    green: "#a6e3a1",
    yellow: "#f9e2af",
    blue: "#89b4fa",
    magenta: "#f5c2e7",
    cyan: "#94e2d5",
    white: "#bac2de",
    brightBlack: "#585b70",
    brightRed: "#f38ba8",
    brightGreen: "#a6e3a1",
    brightYellow: "#f9e2af",
    brightBlue: "#89b4fa",
    brightMagenta: "#f5c2e7",
    brightCyan: "#94e2d5",
    brightWhite: "#a6adc8",
  },
  ui: {
    bg: "#1e1e2e",
    bgChrome: "#181825",
    bgHover: "#313244",
    border: "#313244",
    selection: "#585b70",
    unfocusedFill: "#11111b",
    fg: "#cdd6f4",
    fgMuted: "#6c7086",
    fgFaint: "#45475a",
    fgBright: "#bac2de",
    accent: "#89b4fa",
    accentFg: "#1e1e2e",
    danger: "#f38ba8",
  },
};

const GRUVBOX_DARK: Theme = {
  id: "gruvbox-dark",
  name: "Gruvbox Dark",
  type: "dark",
  builtin: true,
  ansi: {
    foreground: "#ebdbb2",
    cursor: "#ebdbb2",
    cursorAccent: "#282828",
    selectionBackground: "#504945",
    selectionForeground: "#ebdbb2",
    black: "#282828",
    red: "#cc241d",
    green: "#98971a",
    yellow: "#d79921",
    blue: "#458588",
    magenta: "#b16286",
    cyan: "#689d6a",
    white: "#a89984",
    brightBlack: "#928374",
    brightRed: "#fb4934",
    brightGreen: "#b8bb26",
    brightYellow: "#fabd2f",
    brightBlue: "#83a598",
    brightMagenta: "#d3869b",
    brightCyan: "#8ec07c",
    brightWhite: "#ebdbb2",
  },
  ui: {
    bg: "#282828",
    bgChrome: "#1d2021",
    bgHover: "#3c3836",
    border: "#3c3836",
    selection: "#504945",
    unfocusedFill: "#1d2021",
    fg: "#ebdbb2",
    fgMuted: "#928374",
    fgFaint: "#665c54",
    fgBright: "#fbf1c7",
    accent: "#83a598",
    accentFg: "#282828",
    danger: "#fb4934",
  },
};

const NORD: Theme = {
  id: "nord",
  name: "Nord",
  type: "dark",
  builtin: true,
  ansi: {
    foreground: "#d8dee9",
    cursor: "#d8dee9",
    cursorAccent: "#2e3440",
    selectionBackground: "#434c5e",
    selectionForeground: "#eceff4",
    black: "#3b4252",
    red: "#bf616a",
    green: "#a3be8c",
    yellow: "#ebcb8b",
    blue: "#81a1c1",
    magenta: "#b48ead",
    cyan: "#88c0d0",
    white: "#e5e9f0",
    brightBlack: "#4c566a",
    brightRed: "#bf616a",
    brightGreen: "#a3be8c",
    brightYellow: "#ebcb8b",
    brightBlue: "#81a1c1",
    brightMagenta: "#b48ead",
    brightCyan: "#8fbcbb",
    brightWhite: "#eceff4",
  },
  ui: {
    bg: "#2e3440",
    bgChrome: "#272b35",
    bgHover: "#3b4252",
    border: "#3b4252",
    selection: "#434c5e",
    unfocusedFill: "#272b35",
    fg: "#d8dee9",
    fgMuted: "#616e88",
    fgFaint: "#4c566a",
    fgBright: "#eceff4",
    accent: "#88c0d0",
    accentFg: "#2e3440",
    danger: "#bf616a",
  },
};

// Catppuccin Latte — the lone light built-in, so the chrome and terminal are
// exercised against a light background out of the box.
const CATPPUCCIN_LATTE: Theme = {
  id: "catppuccin-latte",
  name: "Catppuccin Latte",
  type: "light",
  builtin: true,
  ansi: {
    foreground: "#4c4f69",
    cursor: "#dc8a78",
    cursorAccent: "#eff1f5",
    selectionBackground: "#acb0be",
    selectionForeground: "#4c4f69",
    black: "#5c5f77",
    red: "#d20f39",
    green: "#40a02b",
    yellow: "#df8e1d",
    blue: "#1e66f5",
    magenta: "#ea76cb",
    cyan: "#179299",
    white: "#acb0be",
    brightBlack: "#6c6f85",
    brightRed: "#d20f39",
    brightGreen: "#40a02b",
    brightYellow: "#df8e1d",
    brightBlue: "#1e66f5",
    brightMagenta: "#ea76cb",
    brightCyan: "#179299",
    brightWhite: "#bcc0cc",
  },
  ui: {
    bg: "#eff1f5",
    bgChrome: "#e6e9ef",
    bgHover: "#ccd0da",
    border: "#ccd0da",
    selection: "#acb0be",
    unfocusedFill: "#dce0e8",
    fg: "#4c4f69",
    fgMuted: "#8c8fa1",
    fgFaint: "#9ca0b0",
    fgBright: "#5c5f77",
    accent: "#1e66f5",
    accentFg: "#eff1f5",
    danger: "#d20f39",
  },
};

export const BUILTIN_THEMES: Theme[] = [
  TOKYO_NIGHT,
  CATPPUCCIN_MOCHA,
  GRUVBOX_DARK,
  NORD,
  CATPPUCCIN_LATTE,
];

export const DEFAULT_THEME = TOKYO_NIGHT;

export function findBuiltinTheme(id: string): Theme | undefined {
  return BUILTIN_THEMES.find((t) => t.id === id);
}

// ---------------------------------------------------------------------------
// CSS-variable mapping
// ---------------------------------------------------------------------------

// Every UI role and ANSI color the stylesheets reference, as `--name → value`.
// stores/theme.ts writes these onto documentElement; src/styles/*.css read them.
export function themeToCssVars(theme: Theme): Record<string, string> {
  const { ui, ansi } = theme;
  return {
    "--bg": ui.bg,
    "--bg-chrome": ui.bgChrome,
    "--bg-hover": ui.bgHover,
    "--border": ui.border,
    "--selection": ui.selection,
    "--unfocused-fill": ui.unfocusedFill,
    "--fg": ui.fg,
    "--fg-muted": ui.fgMuted,
    "--fg-faint": ui.fgFaint,
    "--fg-bright": ui.fgBright,
    "--accent": ui.accent,
    "--accent-fg": ui.accentFg,
    "--danger": ui.danger,
    // ANSI colors the chrome borrows for content (markdown, git status, icons).
    "--ansi-red": ansi.red,
    "--ansi-green": ansi.green,
    "--ansi-yellow": ansi.yellow,
    "--ansi-blue": ansi.blue,
    "--ansi-magenta": ansi.magenta,
    "--ansi-cyan": ansi.cyan,
  };
}

// Build the xterm.js ITheme. The background is intentionally transparent so the
// opaque `.app` layer (painted with --bg) shows through — this is what lets the
// unfocused-split dimming overlay tint a terminal without repainting it.
export function themeToXterm(theme: Theme): ITheme {
  const a = theme.ansi;
  return {
    background: "rgba(0, 0, 0, 0)",
    foreground: a.foreground,
    cursor: a.cursor,
    cursorAccent: a.cursorAccent,
    selectionBackground: a.selectionBackground,
    selectionForeground: a.selectionForeground,
    black: a.black,
    red: a.red,
    green: a.green,
    yellow: a.yellow,
    blue: a.blue,
    magenta: a.magenta,
    cyan: a.cyan,
    white: a.white,
    brightBlack: a.brightBlack,
    brightRed: a.brightRed,
    brightGreen: a.brightGreen,
    brightYellow: a.brightYellow,
    brightBlue: a.brightBlue,
    brightMagenta: a.brightMagenta,
    brightCyan: a.brightCyan,
    brightWhite: a.brightWhite,
  };
}

// ---------------------------------------------------------------------------
// base16 import
// ---------------------------------------------------------------------------

const BASE16_KEYS = [
  "00", "01", "02", "03", "04", "05", "06", "07",
  "08", "09", "0A", "0B", "0C", "0D", "0E", "0F",
] as const;

type Base16Map = Record<string, string>;

function normalizeHex(raw: string): string | null {
  const m = raw.trim().replace(/^#/, "").match(/^([0-9a-fA-F]{6})$/);
  return m ? `#${m[1].toLowerCase()}` : null;
}

// Pull base00–base0F out of a tinted-theming/base16 scheme. Accepts both YAML
// (`base00: "1d1f21"`, with or without `#`, quotes, or a `palette:` wrapper)
// and the JSON equivalent — without a full YAML parser, since the format is a
// flat list of named hex colors. Returns null if the 16 colors aren't all
// present. Key lookup is case-insensitive (base0a and base0A both match).
function parseBase16(text: string): { name?: string; colors: Base16Map } | null {
  let source: Record<string, unknown> | null = null;
  let root: Record<string, unknown> | null = null;

  // JSON path first — cheap to attempt, unambiguous when it parses.
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      root = parsed as Record<string, unknown>;
      // Colors may sit under a `palette` wrapper (tinted-theming); the name
      // stays on the root either way.
      source = (root.palette as Record<string, unknown>) ?? root;
    }
  } catch {
    // Not JSON — fall through to the line scanner below.
  }

  const colors: Base16Map = {};
  let name: string | undefined;

  if (source && root) {
    const lower: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(source)) lower[k.toLowerCase()] = v;
    for (const key of BASE16_KEYS) {
      const v = lower[`base${key.toLowerCase()}`];
      const hex = typeof v === "string" ? normalizeHex(v) : null;
      if (hex) colors[key] = hex;
    }
    const n = root.name ?? root.scheme ?? lower["name"] ?? lower["scheme"];
    if (typeof n === "string") name = n;
  } else {
    // YAML / plain-text scanner.
    for (const key of BASE16_KEYS) {
      const re = new RegExp(`base${key}\\s*:\\s*["']?#?([0-9a-fA-F]{6})`, "i");
      const m = text.match(re);
      if (m) colors[key] = `#${m[1].toLowerCase()}`;
    }
    const nameMatch = text.match(/^\s*(?:name|scheme)\s*:\s*["']?([^"'\n]+?)["']?\s*$/im);
    if (nameMatch) name = nameMatch[1].trim();
  }

  if (BASE16_KEYS.some((k) => !colors[k])) return null;
  return { name, colors };
}

function relativeLuminance(hex: string): number {
  const n = parseInt(hex.replace("#", ""), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  // Perceptual-ish luminance, good enough to pick dark vs light.
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "imported";
}

// A base16 palette: the 16 colors keyed "00".."0F" (uppercase hex digit), each
// a `#rrggbb` string. This is the shared currency between the paste importer
// and the bundled gallery (src/data/base16-schemes.json).
export type Base16Colors = Record<string, string>;

// Map a base16 palette onto a Specterm Theme. The ANSI assignment follows the
// canonical base16-shell mapping; the UI roles follow the conventional
// base00=bg … base0F semantics. Returns null if any of the 16 colors is missing
// or malformed, so callers can treat bad data uniformly.
export function themeFromBase16(
  colors: Base16Colors,
  opts: { id: string; name: string; builtin?: boolean }
): Theme | null {
  const c: Base16Colors = {};
  for (const key of BASE16_KEYS) {
    const hex = typeof colors[key] === "string" ? normalizeHex(colors[key]) : null;
    if (!hex) return null;
    c[key] = hex;
  }

  return {
    id: opts.id,
    name: opts.name,
    type: relativeLuminance(c["00"]) < 0.5 ? "dark" : "light",
    builtin: opts.builtin ?? false,
    ansi: {
      foreground: c["05"],
      cursor: c["05"],
      cursorAccent: c["00"],
      selectionBackground: c["02"],
      selectionForeground: c["05"],
      black: c["00"],
      red: c["08"],
      green: c["0B"],
      yellow: c["0A"],
      blue: c["0D"],
      magenta: c["0E"],
      cyan: c["0C"],
      white: c["05"],
      brightBlack: c["03"],
      brightRed: c["08"],
      brightGreen: c["0B"],
      brightYellow: c["0A"],
      brightBlue: c["0D"],
      brightMagenta: c["0E"],
      brightCyan: c["0C"],
      brightWhite: c["07"],
    },
    ui: {
      bg: c["00"],
      bgChrome: c["01"],
      bgHover: c["02"],
      border: c["01"],
      selection: c["02"],
      unfocusedFill: c["00"],
      fg: c["05"],
      fgMuted: c["04"],
      fgFaint: c["03"],
      fgBright: c["06"],
      accent: c["0D"],
      accentFg: c["00"],
      danger: c["08"],
    },
  };
}

// Parse a base16/tinted-theming scheme (YAML or JSON text) into a Theme, or
// null if it isn't a complete 16-color scheme. Used by the Settings paste/file
// import; the gallery calls themeFromBase16 directly on its bundled palettes.
export function base16ToTheme(text: string): Theme | null {
  const parsed = parseBase16(text);
  if (!parsed) return null;
  const name = parsed.name ?? "Imported";
  return themeFromBase16(parsed.colors, { id: `base16-${slugify(name)}`, name });
}
