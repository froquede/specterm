// Detect which monospace fonts are actually installed, for the terminal font
// picker. Two sources, merged:
//   1. A curated candidate list probed via canvas text metrics — works in any
//      webview with no permissions and no user gesture, and is the guaranteed
//      baseline.
//   2. The full OS font list via the Local Font Access API (queryLocalFonts),
//      when the platform exposes it (Electron/Chromium), filtered to monospace.
//      Best-effort: if it's absent or denied, the curated list still stands.
// Only monospace fonts are surfaced — a proportional font would break the
// terminal's column alignment. Google Fonts / remote fonts are a future add.

// Popular monospace families across macOS, Windows and Linux, plus common
// developer installs. Availability is probed at runtime, so listing one that
// isn't installed is harmless.
const CANDIDATES = [
  "JetBrains Mono",
  "JetBrainsMono Nerd Font",
  "Fira Code",
  "FiraCode Nerd Font",
  "Fira Mono",
  "Cascadia Code",
  "Cascadia Mono",
  "Source Code Pro",
  "Hack",
  "Hack Nerd Font",
  "Iosevka",
  "IBM Plex Mono",
  "Roboto Mono",
  "Ubuntu Mono",
  "DejaVu Sans Mono",
  "Liberation Mono",
  "Inconsolata",
  "Anonymous Pro",
  "Space Mono",
  "Victor Mono",
  "MonoLisa",
  "Menlo",
  "Monaco",
  "SF Mono",
  "SFMono-Regular",
  "Andale Mono",
  "Courier New",
  "Consolas",
  "Lucida Console",
  "Noto Sans Mono",
  "PT Mono",
  "Droid Sans Mono",
  "Go Mono",
  "Meslo LG S",
  "MesloLGS NF",
];

// A wide/narrow mix so proportional fonts render at a clearly different width
// from a monospace fallback, and so the availability probe is sensitive.
const PROBE_STRING = "mmmmmmmmmmlli";
const PROBE_SIZE = "72px";

let sharedCtx: CanvasRenderingContext2D | null = null;
function ctx(): CanvasRenderingContext2D {
  if (!sharedCtx) {
    sharedCtx = document.createElement("canvas").getContext("2d")!;
  }
  return sharedCtx;
}

// Width of PROBE_STRING rendered with a given CSS font-family value.
function widthOf(fontFamily: string): number {
  const c = ctx();
  c.font = `${PROBE_SIZE} ${fontFamily}`;
  return c.measureText(PROBE_STRING).width;
}

const quoted = (family: string) => `"${family.replace(/"/g, "")}"`;

// The classic canvas font-detection trick: when a font is installed, rendering
// with it differs from the generic baseline it would otherwise fall back to.
// Comparing against all three generics avoids a false negative when the font
// happens to share metrics with one of them.
function isAvailable(family: string): boolean {
  const q = quoted(family);
  return (
    widthOf(`${q}, monospace`) !== widthOf("monospace") ||
    widthOf(`${q}, serif`) !== widthOf("serif") ||
    widthOf(`${q}, sans-serif`) !== widthOf("sans-serif")
  );
}

// True when the family renders every glyph at the same advance width — the
// defining property of a monospace font. Assumes the family is installed (an
// absent family falls back to the proportional default and reads as false).
function isMonospace(family: string): boolean {
  const c = ctx();
  c.font = `${PROBE_SIZE} ${quoted(family)}`;
  const wi = c.measureText("i").width;
  const wm = c.measureText("m").width;
  const wW = c.measureText("W").width;
  if (!wi || !wm || !wW) return false;
  return Math.abs(wi - wm) < 0.5 && Math.abs(wi - wW) < 0.5;
}

interface LocalFontData {
  family: string;
}

// Sorted list of installed monospace font families available to the terminal.
export async function detectMonospaceFonts(): Promise<string[]> {
  const found = new Set<string>();

  for (const family of CANDIDATES) {
    if (isAvailable(family) && isMonospace(family)) found.add(family);
  }

  // Augment with the real OS font list where the Local Font Access API exists.
  try {
    const query = (
      window as unknown as {
        queryLocalFonts?: () => Promise<LocalFontData[]>;
      }
    ).queryLocalFonts;
    if (typeof query === "function") {
      const fonts = await query.call(window);
      for (const family of new Set(fonts.map((f) => f.family))) {
        if (!found.has(family) && isMonospace(family)) found.add(family);
      }
    }
  } catch {
    // Local Font Access unavailable or denied — the curated list stands.
  }

  return [...found].sort((a, b) => a.localeCompare(b));
}
