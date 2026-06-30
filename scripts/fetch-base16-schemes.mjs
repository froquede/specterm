// Regenerates src/data/base16-schemes.json — the built-in theme gallery.
//
// Pulls every base16 scheme from the tinted-theming/schemes repo (the de-facto
// base16 collection) and vendors them as a compact JSON array so the gallery
// works offline. Run manually to refresh:
//
//   node scripts/fetch-base16-schemes.mjs
//
// One GitHub API call lists the files; the YAML bodies come from the
// raw.githubusercontent.com CDN (no API rate limit), fetched in parallel.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REF = "spec-0.11";
const TREE_URL = `https://api.github.com/repos/tinted-theming/schemes/git/trees/${REF}?recursive=1`;
const RAW = (path) => `https://raw.githubusercontent.com/tinted-theming/schemes/${REF}/${path}`;

const BASE16_KEYS = [
  "00", "01", "02", "03", "04", "05", "06", "07",
  "08", "09", "0A", "0B", "0C", "0D", "0E", "0F",
];

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data", "base16-schemes.json");

function field(text, name) {
  const m = text.match(new RegExp(`^${name}\\s*:\\s*["']?(.+?)["']?\\s*$`, "im"));
  return m ? m[1].trim() : undefined;
}

// Parse a base16 YAML body into { name, variant, colors }, or null if it isn't
// a complete 16-color scheme.
function parseScheme(text) {
  const colors = {};
  for (const key of BASE16_KEYS) {
    const m = text.match(new RegExp(`base${key}\\s*:\\s*["']?#?([0-9a-fA-F]{6})`, "i"));
    if (m) colors[key] = `#${m[1].toLowerCase()}`;
  }
  if (BASE16_KEYS.some((k) => !colors[k])) return null;
  return {
    name: field(text, "name") ?? "Untitled",
    variant: field(text, "variant"),
    colors,
  };
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": "specterm-build" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

// Run async tasks with a bounded concurrency so we don't open 325 sockets.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    })
  );
  return out;
}

const tree = await fetchText(TREE_URL).then(JSON.parse);
const paths = tree.tree
  .map((n) => n.path)
  .filter((p) => /^base16\/.+\.yaml$/.test(p))
  .sort();

console.log(`Found ${paths.length} base16 schemes; downloading…`);

const results = await mapLimit(paths, 16, async (path) => {
  const slug = path.replace(/^base16\//, "").replace(/\.yaml$/, "");
  try {
    const parsed = parseScheme(await fetchText(RAW(path)));
    if (!parsed) {
      console.warn(`skip (incomplete): ${slug}`);
      return null;
    }
    return { slug, name: parsed.name, variant: parsed.variant ?? null, colors: parsed.colors };
  } catch (err) {
    console.warn(`skip (error): ${slug} — ${err.message}`);
    return null;
  }
});

const schemes = results.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
await writeFile(OUT, JSON.stringify(schemes, null, 0) + "\n");
console.log(`Wrote ${schemes.length} schemes → ${OUT}`);
