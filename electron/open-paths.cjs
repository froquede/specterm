// What a path handed to Specterm on the command line means.
//
// Windows and Linux deliver a "launched with this file" in argv — a double
// click on a registered type, an "Open With", or a plain `specterm notes.md`
// typed into another terminal. It arrives on a cold start through
// `process.argv`, and on a warm one through the `second-instance` event, which
// is why this is a pure function over an argv array rather than something that
// reads `process` itself. (macOS uses the `open-file` event instead and never
// comes through here.)
//
// The rule is deliberately the one the sidebar already follows: **a path
// argument opens exactly the way clicking that file in the file tree does.**
// The renderer routes by extension — markdown to the preview, images to the
// image viewer, anything else to the text viewer, which refuses binaries on its
// own — so nothing here needs a list of extensions to keep in sync with it, and
// a `.png` can't be filtered out on the way past. That filtering is precisely
// what this used to do: it looked for `*.md` and nothing else, so every other
// viewable file the app has was silently dropped at the door.
//
// What is decided here, and why:
//   - **flags are not paths.** Anything starting with `-` is Chromium's or ours
//     (`--user-data-dir=…`, `--no-sandbox`), never a file to open.
//   - **relative paths resolve against the shell's cwd**, not the app's. The
//     renderer loads them as `file://` URLs, where a relative path would resolve
//     against `dist/index.html` and quietly 404. On a second instance the cwd
//     that matters belongs to the *other* process, which Electron hands us.
//   - **only regular files.** A directory argument is ignored rather than
//     guessed at (unpackaged, `argv[1]` is the app directory itself), and so is
//     a path that doesn't exist — a typo'd filename should start the terminal
//     you asked for, not refuse to start.
//   - **the extension is taken at its word.** No sniffing: this runs before the
//     first window, on the one path the "instant to open" pillar protects, and
//     a viewer that is handed something it can't read already says so (the image
//     pane shows "Can't load this image", the text pane refuses binaries).
"use strict";

const fs = require("fs");
const path = require("path");

// A glob can put thousands of arguments in argv, and every one of them costs a
// stat here — on the boot path, in front of the first shell. Scanning stops
// after this many arguments and opening stops after MAX_OPEN_PATHS files, so
// `specterm *` in a large directory opens a handful of tabs instead of five
// hundred, and costs a bounded number of syscalls either way.
const MAX_SCANNED_ARGS = 64;
const MAX_OPEN_PATHS = 8;

/**
 * The files an argv array is asking to open, as absolute paths.
 *
 * @param {string[]} argv     Full argv, including the executable at [0].
 * @param {string} [cwd]      Working directory relative paths resolve against.
 * @returns {string[]}        Absolute paths to existing regular files.
 */
function filePathsFromArgv(argv, cwd) {
  const out = [];
  if (!Array.isArray(argv)) return out;

  const base = cwd || process.cwd();
  const args = argv.slice(1, 1 + MAX_SCANNED_ARGS);

  for (const arg of args) {
    if (typeof arg !== "string" || arg === "" || arg.startsWith("-")) continue;

    let resolved;
    try {
      resolved = path.resolve(base, arg);
    } catch {
      continue; // unrepresentable path (embedded NUL, …)
    }

    try {
      if (!fs.statSync(resolved).isFile()) continue;
    } catch {
      continue; // missing, or not ours to read
    }

    out.push(resolved);
    if (out.length >= MAX_OPEN_PATHS) break;
  }

  return out;
}

module.exports = { filePathsFromArgv, MAX_OPEN_PATHS, MAX_SCANNED_ARGS };
