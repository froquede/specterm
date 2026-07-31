// How every harness launches the app.
//
// One place, for one reason: the suites open and close a few dozen windows
// between them, and by default each one comes up in front of whatever you were
// doing and takes the keyboard with it. That makes the tests something you run
// when you have nothing else to do, which is the opposite of what a test suite
// is for. `SPECTERM_BACKGROUND_WINDOWS` (see `raise()` in electron/main.cjs)
// makes the app show its windows *inactive* — they appear, they render, they
// are driveable and screenshottable, they just never steal focus.
//
// Set `SPECTERM_TEST_FOREGROUND=1` to get the old behaviour back, which is worth
// having when you want to watch a run happen.
//
// The Chromium switches are the other half. A window that never gets focus is a
// window Chromium considers occluded, and it throttles occluded renderers to
// about a frame a second — which turns a 150ms CSS transition into two seconds
// and a green suite into a red one that says nothing about the app. These three
// switch that off, and they are the reason this can't just be an env var.
export const launchArgs = (root, userDataDir, extra = []) => [
  root,
  `--user-data-dir=${userDataDir}`,
  ...(process.env.SPECTERM_TEST_FOREGROUND === "1"
    ? []
    : [
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        "--disable-features=CalculateNativeWinOcclusion",
      ]),
  ...extra,
];

export const launchEnv = (extra = {}) => ({
  ...process.env,
  ...(process.env.SPECTERM_TEST_FOREGROUND === "1"
    ? {}
    : { SPECTERM_BACKGROUND_WINDOWS: "1" }),
  ...extra,
});

/** The options object for `electron.launch()`, ready to spread or pass. */
export const launchOptions = (root, userDataDir, opts = {}) => ({
  args: launchArgs(root, userDataDir, opts.args),
  cwd: root,
  env: launchEnv(opts.env),
});
