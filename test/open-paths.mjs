// What a command-line path argument means (electron/open-paths.cjs).
//
// This is the door every "open this file" request comes through on Windows and
// Linux — a double click, an "Open With", a `specterm shot.png` typed into
// another terminal — and it used to be a door only `.md` fit through. The cases
// worth pinning down are therefore the ones on either side of it: what gets in,
// what is deliberately ignored, and what a relative path resolves against.
//
// A pure function over an argv array and a cwd, so this runs in milliseconds
// with no Electron in sight. The wiring itself — cold start, and the warm start
// that forwards a file to the running window — is covered in e2e.mjs, which
// launches the app with a real image path on its command line.
//
// Run: node test/open-paths.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { filePathsFromArgv, MAX_OPEN_PATHS } = require(
  path.join(root, "electron", "open-paths.cjs")
);

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const eq = (name, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  check(name, g === w, g === w ? "" : `got ${g} want ${w}`);
};

// A throwaway directory standing in for whatever the shell was sitting in.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specterm-open-paths-"));
const file = (name, body = "x") => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
};

const EXE = "/opt/Specterm/specterm"; // argv[0], never a file to open

try {
  const png = file("shot.png");
  const md = file("notes.md");
  const txt = file("notes.txt");
  const upper = file("SHOT.PNG");
  const noExt = file("Makefile");
  const subdir = path.join(dir, "sub");
  fs.mkdirSync(subdir);

  // --- the bug this exists for ---------------------------------------------
  // An image named on the command line has to come through. It used to be
  // dropped here, which is why `specterm shot.png` opened nothing at all.
  eq("an image path is opened", filePathsFromArgv([EXE, png], dir), [png]);
  eq("a markdown path still is", filePathsFromArgv([EXE, md], dir), [md]);
  eq(
    "so is a plain text file — the CLI opens what the sidebar opens",
    filePathsFromArgv([EXE, txt], dir),
    [txt]
  );
  eq("extension case doesn't matter", filePathsFromArgv([EXE, upper], dir), [upper]);
  eq("nor does having no extension at all", filePathsFromArgv([EXE, noExt], dir), [noExt]);

  // --- relative paths ------------------------------------------------------
  eq(
    "a relative path resolves against the shell's cwd",
    filePathsFromArgv([EXE, "shot.png"], dir),
    [png]
  );
  eq(
    "and so does a dotted one",
    filePathsFromArgv([EXE, path.join(".", "sub", "..", "shot.png")], dir),
    [png]
  );
  eq(
    "the same argument against another cwd finds nothing",
    filePathsFromArgv([EXE, "shot.png"], subdir),
    []
  );

  // --- what is deliberately ignored ----------------------------------------
  // Each of these has to leave the app booting normally rather than refusing to
  // start or guessing at what was meant.
  eq(
    "a path that doesn't exist is ignored",
    filePathsFromArgv([EXE, path.join(dir, "typo.png")], dir),
    []
  );
  eq("a directory is ignored", filePathsFromArgv([EXE, subdir], dir), []);
  eq(
    "so is the app directory itself, which is argv[1] when unpackaged",
    filePathsFromArgv(["electron", root, png], dir),
    [png]
  );
  eq(
    "flags are not paths",
    filePathsFromArgv([EXE, "--user-data-dir=/tmp/x", "--no-sandbox", png], dir),
    [png]
  );
  eq("argv[0] is never opened", filePathsFromArgv([png], dir), []);
  eq("an empty argv is fine", filePathsFromArgv([], dir), []);
  eq("so is a missing one", filePathsFromArgv(undefined, dir), []);

  // --- several files -------------------------------------------------------
  const many = [png, md, txt];
  eq("every file argument is opened, in order", filePathsFromArgv([EXE, ...many], dir), many);

  // A glob can hand us the whole directory. Opening it as tabs is not what
  // anyone meant, and stat-ing it all sits on the boot path, so both are bounded.
  const flood = [];
  for (let i = 0; i < 40; i++) flood.push(file(`flood-${i}.png`));
  const opened = filePathsFromArgv([EXE, ...flood], dir);
  check(
    "a glob of forty files opens a bounded handful",
    opened.length === MAX_OPEN_PATHS,
    `opened=${opened.length} cap=${MAX_OPEN_PATHS}`
  );

  // --- absolute paths are returned as given --------------------------------
  check(
    "an absolute path comes back absolute",
    path.isAbsolute(filePathsFromArgv([EXE, png], dir)[0]),
    filePathsFromArgv([EXE, png], dir)[0]
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
