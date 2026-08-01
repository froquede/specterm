// The README's hero animation.
//
// Not a test: nothing here asserts. It drives the built app through one short
// scripted workflow — a split with a rendered document, a pane that starts
// waiting while you're looking elsewhere, and the jump back to it — capturing
// frames throughout, and encodes them to a GIF.
//
// Everything it shows is fixture data. The app runs against a throwaway HOME
// containing nothing but the demo project and a .bashrc that sets a neutral
// prompt, so no real path, hostname or username can end up in a published
// image. The two actions that would otherwise be typed as raw escape sequences
// are shell scripts in the fixture, so the recording shows `./build.sh` rather
// than a line of `\033]9;…` noise.
//
// Encoding is pure JS (pngjs + gifenc) rather than shelling out to ffmpeg or
// ImageMagick: contributors on all three supported platforms can run this with
// nothing installed beyond `npm install`.
//
// Run: node scripts/hero-gif.mjs [outFile] [themeId]   (after `vite build`)
import { _electron as electron } from "playwright";
import { launchOptions } from "../test/launch.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { PNG } from "pngjs";
import gifenc from "gifenc";

const { GIFEncoder, quantize, applyPalette } = gifenc;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outFile =
  process.argv[2] ?? path.join(root, "docs", "assets", "specterm.gif");
const themeId = process.argv[3] ?? "catppuccin-mocha";

// 960x600 keeps the GIF inside the ~880px GitHub renders a README at, without
// paying for pixels nobody sees.
const WIDTH = 960;
const HEIGHT = 600;
const FPS = 8;
const FRAME_MS = Math.round(1000 / FPS);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[gif]", ...a);

// --- Fixture -----------------------------------------------------------------
const home = fs.mkdtempSync(path.join(os.tmpdir(), "specterm-hero-home-"));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "specterm-hero-"));
const demo = path.join(home, "demo");
fs.mkdirSync(path.join(demo, "src"), { recursive: true });

// A neutral prompt: no username, no hostname, no real path.
fs.writeFileSync(
  path.join(home, ".bashrc"),
  [
    "PS1='\\[\\e[38;5;110m\\]demo\\[\\e[0m\\] \\[\\e[38;5;245m\\]›\\[\\e[0m\\] '",
    "unset PROMPT_COMMAND",
    "export LANG=C.UTF-8",
  ].join("\n") + "\n"
);

fs.writeFileSync(
  path.join(demo, "ARCHITECTURE.md"),
  `# Architecture

Specterm renders markdown inline, Mermaid included.

\`\`\`mermaid
graph LR
  A[shell] -->|OSC| B(terminal)
  B --> C{waiting?}
  C -->|yes| D[dot on the tab]
  C -->|no| E[keep going]
\`\`\`

A pane is a first-class surface: it can hold a shell, a rendered document or a
syntax-highlighted file, and a split inherits the directory it came from.
`
);

// The two escape sequences the demo needs, behind names a reader can follow.
const script = (body) => `#!/bin/bash\n${body}\n`;
fs.writeFileSync(
  path.join(demo, "docs.sh"),
  script(
    `printf '\\033]1337;OpenMD;path=${demo}/ARCHITECTURE.md;mode=split\\007'`
  ),
  { mode: 0o755 }
);
fs.writeFileSync(
  path.join(demo, "build.sh"),
  script(
    [
      "echo 'compiling…'",
      "sleep 4",
      "echo 'done in 4.1s'",
      // OSC 9 — the standard "notify the user" sequence. Any tool that emits
      // one flags the pane it ran in.
      `printf '\\033]9;Build finished - 0 errors\\007'`,
    ].join("\n")
  ),
  { mode: 0o755 }
);
for (const f of ["main.ts", "pane.ts", "osc.ts"]) {
  fs.writeFileSync(path.join(demo, "src", f), `// ${f}\n`);
}

// --- Launch ------------------------------------------------------------------
const app = await electron.launch(
  launchOptions(root, profile, {
    env: { HOME: home, SPECTERM_SHELL: "/bin/bash" },
  })
);
const win = await app.firstWindow();
await win.waitForSelector(".xterm-screen canvas", { timeout: 30000 });
await win.setViewportSize({ width: WIDTH, height: HEIGHT });
await sleep(1200);

async function type(text, { enter = true, delay = 55 } = {}) {
  await win.keyboard.type(text, { delay });
  if (enter) await win.keyboard.press("Enter");
}

// --- Staging, before the camera rolls ----------------------------------------

// Theme. Driven through the picker rather than poked into storage: theme
// changes propagate through the host (see lib/store-sync), so a written value
// wouldn't reach the running window.
await win.click(".tab-settings");
await win.waitForSelector("#theme-select", { timeout: 10000 });
await win.selectOption("#theme-select", themeId);
await sleep(500);
await win.click(".tab-settings");
await sleep(400);

// Point the file tree at the project. Electron writes .cache and .pki into
// HOME, and a sidebar listing those says nothing about the app.
await win.click(".tab-actions button:first-child");
await win.waitForSelector(".file-tree", { timeout: 10000 });
await win.locator('.file-tree-entry:has-text("demo")').first().click();
await sleep(600);

// Into the project, on a clean screen, so the recording opens on a bare prompt.
await win.click(".xterm-screen");
await type(`cd ${demo} && clear`);
await sleep(1400);

// --- Capture -----------------------------------------------------------------
const frames = [];
let rolling = true;
const camera = (async () => {
  while (rolling) {
    const started = Date.now();
    try {
      frames.push(await win.screenshot({ type: "png" }));
    } catch (_) {
      // The window is mid-relayout — skip this frame rather than die.
    }
    const spent = Date.now() - started;
    if (spent < FRAME_MS) await sleep(FRAME_MS - spent);
  }
})();

const hold = (ms) => sleep(ms);

const stillDir = path.join(path.dirname(outFile), "stills");
fs.mkdirSync(stillDir, { recursive: true });
async function still(name) {
  await win.screenshot({ path: path.join(stillDir, `${name}.png`) });
}

// 1. A shell doing shell things.
await hold(500);
await type("ls src", { delay: 65 });
await hold(900);

// 2. A rendered document beside it, in a split.
await type("./docs.sh", { delay: 65 });
await hold(3000);
await still("01-split-markdown");

// 3. Start a build, then walk away from it — a pane you're looking at has
//    nothing to tell you, so the feature only means anything once you've left.
await win.click(".xterm-screen");
await type("./build.sh", { delay: 65 });
await hold(700);
await win.keyboard.press("Alt+ArrowRight");
await hold(4200);
await still("02-pane-waiting");

// 4. Jump straight to whatever is waiting.
await win.keyboard.press("Control+Shift+U");
await hold(2000);
await still("03-jumped-back");

rolling = false;
await camera;
log(`captured ${frames.length} frames`);

await app.close();
fs.rmSync(profile, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });

// --- Encode ------------------------------------------------------------------
// Box-downscale by an integer factor when the display is HiDPI, so the GIF is
// the CSS size regardless of the machine that recorded it.
function decode(buf) {
  const png = PNG.sync.read(buf);
  const scale = Math.max(1, Math.round(png.width / WIDTH));
  if (scale === 1)
    return { data: png.data, width: png.width, height: png.height };

  const w = Math.floor(png.width / scale);
  const h = Math.floor(png.height / scale);
  const out = Buffer.alloc(w * h * 4);
  const n = scale * scale;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = ((y * scale + dy) * png.width + (x * scale + dx)) * 4;
          r += png.data[i];
          g += png.data[i + 1];
          b += png.data[i + 2];
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

log("encoding…");
const first = decode(frames[0]);

// One palette for the whole animation, built from a sample of frames. A
// per-frame palette tracks colour better but rewrites the colour table on every
// frame, which costs far more bytes than it saves on a mostly-static terminal —
// and makes flat backgrounds shimmer between frames.
const sample = [];
for (let i = 0; i < frames.length; i += Math.ceil(frames.length / 12)) {
  sample.push(decode(frames[i]).data);
}
const palette = quantize(Buffer.concat(sample), 256, { format: "rgb565" });

const encoder = GIFEncoder();
for (let i = 0; i < frames.length; i++) {
  const { data, width, height } = decode(frames[i]);
  const indexed = applyPalette(data, palette, "rgb565");
  encoder.writeFrame(indexed, width, height, {
    palette: i === 0 ? palette : undefined,
    delay: FRAME_MS,
    dispose: 1,
    transparent: false,
  });
  if (i % 25 === 0) log(`  ${i}/${frames.length}`);
}
encoder.finish();

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, encoder.bytes());
const kb = Math.round(fs.statSync(outFile).size / 1024);
log(
  `wrote ${outFile}  ${first.width}x${first.height}  ${frames.length} frames  ${kb}KB  theme=${themeId}`
);
