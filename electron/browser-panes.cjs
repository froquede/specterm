// Browser panes: the host side of the <webview> pages the renderer lays over
// its panes (src/lib/browser-registry.ts).
//
// A page is someone else's code running inside the app, so everything about
// how it runs is decided here, not by the element that asks for it:
//
//   - only the app's own windows may embed one, only in the browser session
//     (`persist:browser`, apart from the app's), and only at an http(s) or
//     about:blank address;
//   - whatever the element asked for, the page gets no preload, no Node, a
//     sandbox and context isolation;
//   - it may go full screen and write to the clipboard; every other
//     permission (camera, microphone, location, notifications…) is refused;
//   - it never navigates to anything but http(s): no file://, no custom
//     schemes handed to the OS;
//   - a new window it opens becomes a browser tab in the window it is in.
//
// And one convenience: with a page focused, its keystrokes go to its own
// process and the app's window never sees them, so the app's shortcuts would
// stop working. The renderer sends the chords it answers to (browser:chords);
// a keystroke matching one is taken from the page before it sees it and sent
// back to the window (browser:key), which replays it through its dispatcher.

const PARTITION = "persist:browser";

// What a page may have without asking anyone. Full screen is the video
// player's button; the clipboard write is a page's own "copy" button.
const ALLOWED_PERMISSIONS = new Set(["fullscreen", "clipboard-sanitized-write", "pointerLock"]);

function isLoadable(url) {
  return url === "about:blank" || /^https?:\/\//i.test(url || "");
}

function isWeb(url) {
  return /^https?:\/\//i.test(url || "");
}

// The same rule as the renderer's chordMatchesEvent, against Electron's Input.
function chordMatchesInput(chord, input) {
  if (!!chord.ctrl !== !!input.control) return false;
  if (!!chord.shift !== !!input.shift) return false;
  if (!!chord.meta !== !!input.meta) return false;
  if (!!chord.alt !== !!input.alt) return false;
  if (chord.code) return input.code === chord.code;
  return String(input.key).toLowerCase() === String(chord.key).toLowerCase();
}

function registerBrowserPanes({ app, ipcMain, session, isAppWindow }) {
  // Chords per window, by its webContents id.
  const chordsByHost = new Map();

  ipcMain.on("browser:chords", (event, chords) => {
    const id = event.sender.id;
    if (!chordsByHost.has(id)) event.sender.once("destroyed", () => chordsByHost.delete(id));
    chordsByHost.set(id, Array.isArray(chords) ? chords.filter((c) => c && typeof c.key === "string") : []);
  });

  let sessionReady = false;
  function prepareSession() {
    if (sessionReady) return;
    sessionReady = true;
    const ses = session.fromPartition(PARTITION);
    // Sites that sniff for Electron (Google's sign-in among them) refuse it;
    // without its token, and the app's own, this is the Chromium it is.
    ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|specterm)\/\S+/gi, ""));
    ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
  }

  function setUpGuest(guest) {
    const host = () => guest.hostWebContents;

    guest.setWindowOpenHandler(({ url }) => {
      const h = host();
      if (isWeb(url) && h && !h.isDestroyed()) h.send("browser:open", url);
      return { action: "deny" };
    });

    const guard = (event, url) => {
      if (!isLoadable(url)) event.preventDefault();
    };
    guest.on("will-navigate", guard);
    guest.on("will-redirect", guard);

    guest.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const h = host();
      if (!h || h.isDestroyed()) return;
      const chords = chordsByHost.get(h.id);
      if (!chords || !chords.some((c) => chordMatchesInput(c, input))) return;
      event.preventDefault();
      h.send("browser:key", {
        key: input.key,
        code: input.code,
        ctrl: !!input.control,
        shift: !!input.shift,
        alt: !!input.alt,
        meta: !!input.meta,
      });
    });
  }

  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event, webPreferences, params) => {
      if (!isAppWindow(contents) || params.partition !== PARTITION || !isLoadable(params.src)) {
        event.preventDefault();
        return;
      }
      delete webPreferences.preload;
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
      webPreferences.webSecurity = true;
      webPreferences.allowRunningInsecureContent = false;
      webPreferences.partition = PARTITION;
      prepareSession();
    });
    if (contents.getType() === "webview") setUpGuest(contents);
  });
}

module.exports = { registerBrowserPanes, chordMatchesInput, isLoadable };
