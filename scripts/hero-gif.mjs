// The README's hero animation.
//
// Not a test: nothing here asserts. It drives the built app through the thing
// the terminal is actually for — three agents working at once, each flagging
// its pane as it finishes, and walking through them with one keystroke —
// capturing frames throughout, and encodes them to a GIF.
//
// Everything it shows is fixture data. The app runs against a throwaway HOME
// containing nothing but the demo project and a .bashrc that sets a neutral
// prompt, so no real path, hostname or username can end up in a published
// image. The escape sequence the demo needs lives inside a fixture script, so
// the recording shows `./agent.sh` rather than a line of `\033]9;…` noise.
//
// Encoding is pure JS (pngjs + gifenc) rather than shelling out to ffmpeg or
// ImageMagick: contributors on all three supported platforms can run this with
// nothing installed beyond `npm install`. Frames are diffed against each other
// and unchanged pixels written as transparent, which is what keeps a
// twenty-second animation of a mostly-static screen down to a sane size.
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
const themeId = process.argv[3] ?? "tokyo-night";

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

// Ubuntu's /etc/bash.bashrc greets every fresh interactive shell with a hint
// about sudo until this file exists. Three of the panes here are fresh shells.
fs.writeFileSync(path.join(home, ".sudo_as_admin_successful"), "");

// A stand-in for a coding agent: prints its working notes at a given pace, then
// emits OSC 9 — the standard "notify the user" sequence, which is all any tool
// has to do to light up the pane it ran in.
fs.writeFileSync(
  path.join(demo, "agent.sh"),
  `#!/bin/bash
# The work is preset per task name so the recording shows a short command.
case "$1" in
  refactor) step=3.6; msg='Refactor complete - 3 files'
            lines=("reading src/pane.ts" "src/pane.ts   +18 -7" \\
                   "src/osc.ts     +4 -2" "src/main.ts   +11 -3") ;;
  tests)    step=2.6; msg='42 passed, 0 failed'
            lines=("vitest run" "osc.spec.ts     18 ok" "attention.spec  24 ok") ;;
  lint)     step=1.6; msg='Lint clean'
            lines=("eslint src" "0 problems") ;;
esac
mag=$'\\033[35m'; dim=$'\\033[38;5;245m'; grn=$'\\033[32m'; rst=$'\\033[0m'
printf '%s*%s %s\\n' "$mag" "$rst" "$1"
for line in "\${lines[@]}"; do
  sleep "$step"
  printf '%s  . %s%s\\n' "$dim" "$line" "$rst"
done
sleep "$step"
printf '%s  v %s%s\\n' "$grn" "$msg" "$rst"
printf '\\033]9;%s\\007' "$msg"
`,
  { mode: 0o755 }
);

// The ASCII torus that runs in the pane you sit in. Kept as a real file rather
// than a string in here, so it stays readable and lintable.
fs.copyFileSync(
  path.join(__dirname, "fixtures", "spin.js"),
  path.join(demo, "spin.js")
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

async function type(text, { enter = true, delay = 42 } = {}) {
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

// Sidebar shut. It carries no part of this story and costs a quarter of the
// width three panes have to share.
if (await win.locator(".file-tree, .settings-sidebar").count()) {
  await win.click(".tab-actions button:first-child");
  await sleep(400);
}

await win.click(".xterm-screen");
await type(`cd ${demo} && clear`);
await sleep(1400);

// --- Capture -----------------------------------------------------------------
// Every captured frame written out as a PNG, for inspecting the recording frame
// by frame. Off unless asked for: it is a few hundred files and ~15MB.
const dumpDir = process.env.HERO_DUMP_FRAMES || null;
if (dumpDir) {
  fs.rmSync(dumpDir, { recursive: true, force: true });
  fs.mkdirSync(dumpDir, { recursive: true });
}

const frames = [];
let rolling = true;
const camera = (async () => {
  while (rolling) {
    const started = Date.now();
    try {
      const shot = await win.screenshot({ type: "png" });
      frames.push(shot);
      if (dumpDir) {
        fs.writeFileSync(
          path.join(dumpDir, `f${String(frames.length - 1).padStart(3, "0")}.png`),
          shot
        );
      }
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
const still = (name) =>
  win.screenshot({ path: path.join(stillDir, `${name}.png`) });

// Drag a split divider. `direction` is the handle's own axis: "h" is the
// vertical bar between columns (moves left/right), "v" a horizontal bar
// between stacked panes (moves up/down).
async function dragHandle(direction, index, byPx) {
  const h = await win
    .locator(`.split-handle-${direction}`)
    .nth(index)
    .boundingBox();
  if (!h) return;

  // Off-centre along the handle's long axis: a 20px `.split-flip` button sits
  // centred on it and stops propagation on pointerdown, so a grab at the middle
  // toggles the split direction instead of starting a drag.
  const gx = direction === "h" ? h.x + h.width / 2 : h.x + h.width * 0.28;
  const gy = direction === "h" ? h.y + h.height * 0.28 : h.y + h.height / 2;

  await win.mouse.move(gx, gy);
  await win.mouse.down();
  // In steps, so the recording catches the panes reflowing rather than snapping
  // from one layout to the other between two frames.
  await win.mouse.move(
    direction === "h" ? gx + byPx : gx,
    direction === "h" ? gy : gy + byPx,
    { steps: 26 }
  );
  await win.mouse.up();
}

// Drag a pane by its title-bar and drop it on the middle of another. The
// central 40% box of a pane means "swap" (see computeDropEdge in
// stores/pane-drag.ts); the edges would split instead.
async function swapPanes(sourceIndex, targetIndex) {
  const panes = win.locator("[data-pane-id]");
  const src = await panes.nth(sourceIndex).locator(".pane-titlebar").boundingBox();
  const dst = await panes.nth(targetIndex).boundingBox();
  if (!src || !dst) return;

  await win.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
  await win.mouse.down();
  // Past the drag threshold first, then across in steps so the recording shows
  // the drop-zone highlight tracking the cursor rather than teleporting.
  await win.mouse.move(src.x + src.width / 2 + 25, src.y + src.height / 2 + 18, {
    steps: 5,
  });
  await win.mouse.move(dst.x + dst.width / 2, dst.y + dst.height / 2, {
    steps: 26,
  });
  await sleep(500);
  await win.mouse.up();
}

// 1. Split off a column for the work, and start the long job in it.
await hold(400);
await win.keyboard.press("Control+Shift+Enter");
await hold(700);
await type("./agent.sh refactor");
await hold(600);

// 2. Two more agents stacked under it.
await win.keyboard.press("Control+Shift+S");
await hold(700);
await type("./agent.sh tests");
await hold(600);
await win.keyboard.press("Control+Shift+S");
await hold(700);
await type("./agent.sh lint");
await hold(600);

// 3. Back to the left column — the pane you actually sit in while they run.
await win.keyboard.press("Alt+ArrowLeft");
await hold(600);
// Half the capture interval: an exact 2:1 ratio, so every captured frame
// lands on an animation frame (no aliasing judder), and the animation is
// twice as quick to redraw itself at a new size while a divider moves.
await type(`node spin.js 40 ${Math.round(FRAME_MS / 2)}`);
await hold(2600);
await still("01-agents-running");

// 4. Splits are not a fixed grid. The divider goes wherever you put it, and
//    everything under it — including a program redrawing 18 times a second —
//    refits as it moves.
await dragHandle("h", 0, 250);
await hold(1300);
await dragHandle("h", 0, -340);
await hold(1400);
await dragHandle("h", 0, 160);
await hold(1100);
await still("02-resized");

// 5. Panes are not fixed in place either: drag one by its title-bar onto the
//    middle of another and the two trade places, running programs and all.
await swapPanes(0, 2);
await hold(1600);
await still("03-swapped");

// 6. And the other axis. The torus landed in a short pane, so the horizontal
//    dividers give it its height back.
await dragHandle("v", 0, -165);
await hold(800);
await dragHandle("v", 1, 95);
await hold(2200);
await still("04-regrown");

// 7. The agents finish out of order, each flagging its own pane with what it
//    said — none of them the pane you are looking at.
await hold(4500);
await still("05-panes-waiting");

// 8. One keystroke per pane, and each flag goes out as you arrive.
await win.keyboard.press("Control+Shift+U");
await hold(1700);
await win.keyboard.press("Control+Shift+U");
await hold(1700);
await win.keyboard.press("Control+Shift+U");
await hold(2200);
await still("06-cleared");

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

// One palette for the whole animation, built from a sample of frames. A
// per-frame palette tracks colour better but rewrites the colour table on every
// frame, which costs far more than it saves on a mostly-static terminal — and
// makes flat backgrounds shimmer between frames. 255 colours, not 256: the last
// index is kept back to mean "unchanged since the previous frame".
const sample = [];
for (let i = 0; i < frames.length; i += Math.ceil(frames.length / 12)) {
  sample.push(decode(frames[i]).data);
}
const palette = quantize(Buffer.concat(sample), 255, { format: "rgb565" });
palette.push([0, 0, 0]);
const TRANSPARENT = palette.length - 1;

const encoder = GIFEncoder();
let previous = null;
let firstSize = null;

for (let i = 0; i < frames.length; i++) {
  const { data, width, height } = decode(frames[i]);
  if (!firstSize) firstSize = `${width}x${height}`;
  const indexed = applyPalette(data, palette, "rgb565");

  // Everything identical to the frame before becomes transparent, and with
  // `dispose: 1` the previous frame shows through it. On a terminal, where most
  // of the screen holds still between frames, that is nearly all of it.
  let payload = indexed;
  if (previous) {
    payload = Uint8Array.from(indexed);
    for (let p = 0; p < payload.length; p++) {
      if (payload[p] === previous[p]) payload[p] = TRANSPARENT;
    }
  }

  encoder.writeFrame(payload, width, height, {
    palette: i === 0 ? palette : undefined,
    delay: FRAME_MS,
    dispose: 1,
    transparent: i > 0,
    transparentIndex: TRANSPARENT,
  });

  previous = indexed;
  if (i % 25 === 0) log(`  ${i}/${frames.length}`);
}
encoder.finish();

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, encoder.bytes());
const kb = Math.round(fs.statSync(outFile).size / 1024);
log(
  `wrote ${outFile}  ${firstSize}  ${frames.length} frames  ${kb}KB  theme=${themeId}`
);
