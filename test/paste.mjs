// The paste rules (src/lib/paste.ts).
//
// joinWrappedLines is the one place in the app that decides, from shape alone,
// whether a line break was authored or was a wrap — and it decides it about
// text that is about to be executed. So the cases worth pinning down are the
// refusals: everything it declines to join has to come out byte-for-byte as it
// arrived, because the cost of a wrong join is a command nobody wrote.
//
// Pure functions, no Electron and no DOM — this runs in milliseconds. Type
// annotations are stripped by node, so paste.ts must stay erasable TypeScript
// (no enums, no parameter properties).
//
// Run: node --experimental-strip-types test/paste.mjs
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const { joinWrappedLines, preparePaste } = await import(
  path.join(root, "src", "lib", "paste.ts")
);

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const eq = (name, got, want) =>
  check(name, got === want, got === want ? "" : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// A pane 120 columns wide, which is what the `cols` argument means everywhere
// below. Rows near that width are candidates for having been wrapped by it.
const COLS = 120;

// --- the case this exists for --------------------------------------------
// One sudo command a chat pane wrapped across two rows. Pasted as-is the first
// row runs on its own, which is the bug.
{
  const head =
    "sudo apt-get install -y build-essential libssl-dev pkg-config curl git ca-certificates gnupg lsb-release";
  const wrapped = `${head}\nsoftware-properties-common`;
  eq(
    "wrapped command joins into one line",
    joinWrappedLines(wrapped, COLS),
    `${head} software-properties-common`
  );
}

// Three rows wrapped at the same column, tail shorter than the rest.
{
  const a = "docker run -d --name postgres -e POSTGRES_PASSWORD=hunter2 -e POSTGRES_DB=app -p 5432:5432 -v pgdata:/var/lib";
  const b = "/postgresql/data --restart unless-stopped --health-cmd 'pg_isready -U postgres' --health-interval 10s post";
  const c = "gres:16-alpine";
  eq(
    "three wrapped rows join",
    joinWrappedLines(`${a}\n${b}\n${c}`, COLS),
    `${a} ${b} ${c}`
  );
}

// The Enter the user copied along with the command survives the join, so a
// paste that used to run still runs — as one command instead of two.
{
  const head = "npm install --save-dev @typescript-eslint/parser @typescript-eslint/eslint-plugin eslint-config-prettier";
  eq(
    "trailing newline is preserved",
    joinWrappedLines(`${head}\neslint-plugin-import\n`, COLS),
    `${head} eslint-plugin-import\n`
  );
}

// CRLF from a Windows clipboard is the same break.
{
  const head = "curl -fsSL https://example.com/install.sh -o /tmp/install.sh --retry 3 --retry-delay 2 --silent --connect-time";
  eq(
    "CRLF joins like LF",
    joinWrappedLines(`${head}\r\nout 10`, COLS),
    `${head} out 10`
  );
}

// --- the refusals ---------------------------------------------------------
const refuses = (name, text, cols = COLS) =>
  eq(name, joinWrappedLines(text, cols), text);

refuses("single line is untouched", "sudo apt-get update\n");

// Two commands, both long, the second shorter — uniform by the only measure
// two rows can be. Only the pane width separates this from a real wrap.
refuses(
  "two long unrelated commands",
  "docker run -d --name pg -e POSTGRES_PASSWORD=secret postgres:16\ndocker exec -it pg psql -U postgres -c 'select 1'"
);

// Short rows carry no width signal at all.
refuses("a list of short commands", "cd /srv/app\nnpm ci\nnpm test");

refuses(
  "a blank row separates paragraphs",
  "sudo systemctl daemon-reload and then some more text to push this past the floor\n\nsudo systemctl restart app"
);

refuses(
  "indentation is a chosen shape",
  "for f in *.log; do gzip --best --keep --force --verbose -- \"$f\" ; done ; echo done\n  echo finished"
);

refuses(
  "explicit backslash continuation",
  "ffmpeg -i input.mov -c:v libx264 -preset slow -crf 18 -c:a aac -b:a 192k -movflags \\\nfaststart out.mp4"
);

refuses(
  "operator at the end of a row",
  "sudo apt-get update -o Acquire::Retries=3 -o Acquire::http::Timeout=20 --quiet &&\nsudo apt-get upgrade -y"
);

refuses(
  "shell keyword at the end of a row",
  "if command -v docker >/dev/null 2>&1 && command -v docker-compose >/dev/null; then\n  echo ok"
);

refuses(
  "a row that continues a block",
  "if [ -f /etc/os-release ]; then echo present; echo checking further along the line\nfi"
);

// Escape sequences mean this is not a command line; don't reason about shape.
refuses(
  "control characters pass through",
  "echo hello and a good deal more text so the row clears the width floor\n\x1b[31mred\x1b[0m"
);

// Wrapped somewhere narrower than this pane — the rows are uniform, but not at
// this pane's column, so it is not ours to unwrap.
refuses(
  "wrapped at a narrower width than the pane",
  "sudo apt-get install -y build-essential libssl-dev\npkg-config"
);

// Without a pane width the floor is all there is, so the same text joins.
eq(
  "no cols hint falls back to the width floor",
  joinWrappedLines(
    "sudo apt-get install -y build-essential libssl-dev\npkg-config"
  ),
  "sudo apt-get install -y build-essential libssl-dev pkg-config"
);

// --- the paste that is a whole file --------------------------------------
// Dumping a file into a shell is ordinary, and the rules above can only ever
// decline one. They have to decline it by returning, not by throwing: this used
// to reach `Math.max(...rows)`, which passes one argument per row and blows the
// stack somewhere north of a hundred thousand of them — a RangeError out of the
// paste handler, so the paste simply vanished.
{
  const row = "x".repeat(80);
  const huge = Array.from({ length: 200_000 }, () => row).join("\n");
  let threw = null;
  let out = null;
  try {
    out = joinWrappedLines(huge, COLS);
  } catch (e) {
    threw = e;
  }
  check("a 200k-row paste does not throw", threw === null, threw && String(threw));
  check("a 200k-row paste comes back byte for byte", out === huge);
  // The ceiling is on rows as well as bytes, so a merely long paste is declined
  // rather than joined into one implausible line.
  const many = Array.from({ length: 200 }, () => row).join("\n");
  eq("a 200-row paste is left alone", joinWrappedLines(many, COLS), many);
}

// --- preparePaste ---------------------------------------------------------
eq(
  "newlines become CR, as Enter sends",
  preparePaste("cd /srv/app\nnpm ci\nnpm test", false, COLS),
  "cd /srv/app\rnpm ci\rnpm test"
);

eq(
  "bracketed mode wraps the payload",
  preparePaste("npm ci", true, COLS),
  "\x1b[200~npm ci\x1b[201~"
);

eq(
  "a payload cannot close the bracket early",
  preparePaste("npm \x1b[201~ci", true, COLS),
  "\x1b[200~npm ci\x1b[201~"
);

eq(
  "no bracketing when the program never asked",
  preparePaste("npm ci", false, COLS),
  "npm ci"
);

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
