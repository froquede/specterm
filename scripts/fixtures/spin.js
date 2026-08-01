// Eye candy for the hero recording (scripts/hero-gif.mjs copies this into the
// throwaway demo project). The classic ASCII torus, in colour.
//
// It re-reads the terminal size on every frame rather than measuring once, so
// dragging the split divider reflows it live — which is the point of showing it
// beside a pane being resized.
//
// The redraw interval is an argument so a recording can pin it to its own frame
// interval: sampling an 18fps animation at 8fps lands on uneven angular steps
// and reads as judder, where one draw per captured frame is smooth.
//
// Run: node spin.js [seconds] [intervalMs]
const chars = ".,-~:;=!*#$@";
// Tokyo Night-ish ramp: deep blue in the shadows through cyan to warm highlight.
const hues = [60, 61, 67, 73, 74, 80, 116, 152, 158, 194, 223, 229];

let A = 0;
let B = 0;
// Last size drawn at, so a resize can clear the screen instead of painting a
// smaller frame on top of a bigger one and leaving its edges behind.
let lastW = 0;
let lastH = 0;

const INTERVAL = Number(process.argv[3] || 55);

// Deliberately NOT the alternate screen. xterm clears the alt buffer on resize
// rather than reflowing it, so every step of a divider drag blanks the pane
// until the next repaint lands — measurably, two frames in three. The normal
// buffer reflows and keeps its content, and the scrolling that would otherwise
// make this unusable is handled by never writing a newline on the bottom row.
// `?7l` turns autowrap off, and it is the difference between a clean frame and
// a smeared one. A resize reaches this process as SIGWINCH, which lands some
// milliseconds after the grid actually changed; a draw in that gap still uses
// the old, wider size. With autowrap on, every one of those rows spills onto
// the next line and the picture stretches down the pane. With it off the
// overhang is simply clipped at the right margin and the next frame is correct.
// Cursor hidden for the same reason any full-screen program hides it.
process.stdout.write("\x1b[?7l\x1b[2J\x1b[?25l");

function frame() {
  const W = Math.max(20, (process.stdout.columns || 60) - 1);
  const H = Math.max(10, (process.stdout.rows || 24) - 1);
  // Keep it circular in whichever direction is tighter. A character cell is
  // about twice as tall as it is wide, so the horizontal radius wants to be
  // double the vertical one — but in a short, wide pane it is the height that
  // runs out first, and scaling only by width would draw a flat ellipse.
  const ry = Math.min(H / 2.5, W / 4.6);
  const rx = ry * 2;

  const buf = new Array(W * H).fill(" ");
  const zed = new Array(W * H).fill(0);

  for (let j = 0; j < 6.28; j += 0.06) {
    for (let i = 0; i < 6.28; i += 0.015) {
      const c = Math.sin(i);
      const d = Math.cos(j);
      const e = Math.sin(A);
      const f = Math.sin(j);
      const g = Math.cos(A);
      const h = d + 2;
      const D = 1 / (c * h * e + f * g + 5);
      const l = Math.cos(i);
      const m = Math.cos(B);
      const n = Math.sin(B);
      const t = c * h * g - f * e;

      const x = Math.round(W / 2 + rx * D * (l * h * m - t * n));
      const y = Math.round(H / 2 + ry * D * (l * h * n + t * m));
      const o = x + W * y;
      const N = Math.round(
        8 * ((f * e - c * d * g) * m - c * d * e - f * g - l * d * n)
      );

      if (y >= 0 && y < H && x >= 0 && x < W && D > zed[o]) {
        zed[o] = D;
        buf[o] = chars[N > 0 ? Math.min(N, chars.length - 1) : 0];
      }
    }
  }

  // Every row positioned absolutely, and not a newline anywhere in the frame.
  //
  // Newlines are what let a frame scroll the screen, and a scrolled frame never
  // recovers: the image ends up jammed against the bottom of the pane with the
  // top cut off, and stays there because every later frame starts from wherever
  // the viewport now is. It only takes one write of more rows than the pane has
  // — which happens whenever the pane shrinks between reading the size and
  // writing the frame, since SIGWINCH lands a few milliseconds later.
  //
  // With `\x1b[row;1H` there is nothing to scroll: a row beyond the bottom is
  // clamped by the terminal instead of pushing the screen up, so a stale size
  // costs at most one imperfect frame rather than permanently displacing the
  // picture.
  let out = "";
  let last = -1;
  for (let y = 0; y < H; y++) {
    out += "\x1b[" + (y + 1) + ";1H";
    for (let x = 0; x < W; x++) {
      const ch = buf[x + W * y];
      if (ch !== " ") {
        const idx = chars.indexOf(ch);
        if (idx !== last) {
          out += "\x1b[38;5;" + hues[idx] + "m";
          last = idx;
        }
      }
      out += ch;
    }
  }
  // `\x1b[J` erases from the cursor to the end of the screen, so a pane that
  // just got shorter drops its leftovers *after* the new frame is painted.
  // Clearing beforehand would blank the pane for a frame on every step of a
  // resize drag, which is its own kind of flicker.
  const resized = W !== lastW || H !== lastH;
  lastW = W;
  lastH = H;
  process.stdout.write(out + "\x1b[0m" + (resized ? "\x1b[J" : ""));

  A += 0.0009 * INTERVAL;
  B += 0.00045 * INTERVAL;
}

const timer = setInterval(frame, INTERVAL);

// Redraw the instant the size changes, rather than waiting for the next tick.
// xterm clears the alternate screen buffer on resize — it does not reflow it,
// because a full-screen program is expected to repaint itself on SIGWINCH. Wait
// for the timer instead and the pane is genuinely blank in the meantime: with a
// 62ms tick that is a visible hole every time a divider moves.
process.stdout.on("resize", frame);

function stop() {
  clearInterval(timer);
  process.stdout.write("\x1b[0m\x1b[?7h\x1b[?25h\x1b[2J\x1b[H");
  process.exit(0);
}

process.on("SIGINT", stop);
setTimeout(stop, Number(process.argv[2] || 30) * 1000);
