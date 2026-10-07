// Plugins: finding them, turning them on and off, and the one process their host
// code runs in. The design is in docs/plugin-architecture.md; this is the main
// process half of it.
//
// A plugin is a folder under <userData>/plugins/ with a `specterm-plugin.json`
// manifest. Everything the manifest declares is static data — sidebar views, a
// tab-bar button, shortcuts — so the renderer can draw it without running any
// plugin code. Code comes in two optional parts:
//
//   host  — a CommonJS module run in the plugin host, a utilityProcess shared by
//           every plugin. Never in this process: node-pty lives here, so every
//           byte every terminal prints goes through this event loop, and a plugin
//           doing something slow and synchronous would stall all of them. It also
//           means a plugin that crashes takes the host down, not the app.
//   panel — an ES module the renderer imports when one of the plugin's views is
//           first opened, served over the specterm-plugin:// scheme below.
//
// Nothing here is on the path to the first shell. The one thing a window needs
// at boot — which buttons and views exist — comes from the last run's answer,
// stored in plugins.json and handed over synchronously by the preload, only when
// there is something to hand over (see `hasBootContributions`). Discovery, the
// host process and activation all wait for the first window to have painted.

const fs = require("fs");
const path = require("path");
const {
  parseSource,
  describeSource,
  fetchSource,
  releaseVersion,
  prereleaseVersion,
  remoteTags,
  newestRelease,
  remoteCommit,
  newer,
} = require("./plugin-install.cjs");

// The plugin API version this build implements. A manifest asks for one with a
// caret range, `engines.specterm: "^1.1"`: same major, and a minor no newer than
// this one. Anything else is listed with the reason but cannot be enabled.
//
//   1.0 — sidebar views, tab-bar button and badge, commands, invoke and events.
//   1.1 — ctx.toast and api.onReveal, api.renderMarkdown, api.platform,
//         api.openExternal, and `ownHeader` on a sidebar view.
//   1.2 — api.onActiveCwd, api.openFile and api.storage; built-in plugins.
//   1.3 — overlays, the renderer module (file-tree folder actions and banners,
//         commands it runs), api.onActiveFile, api.revealHeading,
//         api.noteStructure, api.showView, and tabBarButton.order.
const API_VERSION = { major: 1, minor: 3 };

const SCHEME = "specterm-plugin";
const MANIFEST = "specterm-plugin.json";
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/; // view, command and method names
const MAX_TEXT = 80;
const MAX_VIEWS = 4;
const MAX_COMMANDS = 16;

// How long a call into the host may take before the caller gets an error. The
// host is a separate process, so a plugin that never answers costs its caller a
// rejected promise, not a hung panel.
const INVOKE_TIMEOUT_MS = 30_000;
const LIFECYCLE_TIMEOUT_MS = 10_000;

// The update check for plugins added from Settings: a minute after start (never
// on the boot path), then every 6 hours. The env var is for the tests.
const UPDATE_FIRST_CHECK_MS = Number(process.env.SPECTERM_PLUGIN_UPDATE_DELAY_MS) || 60_000;
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Must run before `app` is ready: Chromium fixes the privileged schemes at
// startup. `standard` + `secure` lets a panel be imported as an ES module from
// the app's page, and `corsEnabled` is what lets that cross-origin import load.
function registerPluginScheme(protocol) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

const CONTENT_TYPES = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

// --- manifest ---------------------------------------------------------------

function text(value, field) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT) {
    throw new Error(`"${field}" must be a non-empty string of at most ${MAX_TEXT} characters`);
  }
  return value.trim();
}

function name(value, field) {
  if (typeof value !== "string" || !NAME_RE.test(value)) {
    throw new Error(`"${field}" must match ${NAME_RE}`);
  }
  return value;
}

// A file the manifest points at, which must exist and stay inside the plugin's
// folder: the protocol handler serves exactly these, so a `../` here would hand
// the renderer any file on disk.
function innerFile(dir, rel, field) {
  if (typeof rel !== "string" || !rel) throw new Error(`"${field}" must be a relative path`);
  const full = path.resolve(dir, rel);
  if (!full.startsWith(dir + path.sep)) throw new Error(`"${field}" points outside the plugin`);
  if (!fs.existsSync(full)) throw new Error(`"${field}" (${rel}) does not exist`);
  return path.relative(dir, full).split(path.sep).join("/");
}

function engineRange(range) {
  const m = typeof range === "string" ? /^\^(\d+)(?:\.(\d+))?(?:\.\d+)?$/.exec(range.trim()) : null;
  return m ? { major: Number(m[1]), minor: Number(m[2] ?? 0) } : null;
}

// Validated, normalised manifest — or a thrown Error whose message is shown in
// Settings next to the plugin, so it has to read as an instruction.
function parseManifest(dir, raw) {
  const m = JSON.parse(raw);
  if (!m || typeof m !== "object") throw new Error("the manifest is not a JSON object");
  if (typeof m.id !== "string" || !ID_RE.test(m.id)) throw new Error(`"id" must match ${ID_RE}`);
  if (m.id !== path.basename(dir)) throw new Error(`"id" must match its folder name (${path.basename(dir)})`);
  const wants = engineRange(m.engines?.specterm);
  const provides = `${API_VERSION.major}.${API_VERSION.minor}`;
  if (wants === null) throw new Error(`"engines.specterm" must be a caret range, like "^${provides}"`);
  if (wants.major !== API_VERSION.major || wants.minor > API_VERSION.minor) {
    const newer = wants.major > API_VERSION.major || wants.minor > API_VERSION.minor;
    throw new Error(
      `needs plugin API ${wants.major}.${wants.minor}, this Specterm provides ${provides}` +
        (newer ? "; update Specterm" : "")
    );
  }

  const out = {
    id: m.id,
    name: text(m.name, "name"),
    version: text(m.version, "version"),
    host: m.host === undefined ? null : innerFile(dir, m.host, "host"),
    panel: m.panel === undefined ? null : innerFile(dir, m.panel, "panel"),
    style: m.style === undefined ? null : innerFile(dir, m.style, "style"),
    // Loaded in every window after its first paint, whether or not any of the
    // plugin's views is open: for what has to exist before one is (a folder
    // action in the file tree, the command a shortcut runs). Keep it small.
    renderer: m.renderer === undefined ? null : innerFile(dir, m.renderer, "renderer"),
    sidebarViews: [],
    overlays: [],
    tabBarButton: null,
    commands: [],
    // When the host module starts. "startup": as soon as the plugin is on
    // (after the first window has painted), for plugins that work in the
    // background, like a poller behind a badge. "view": on the first call from
    // its panel, for plugins that only answer their own view; until then the
    // plugin costs no process at all.
    activation: "startup",
  };
  if (m.activation !== undefined) {
    if (m.activation !== "startup" && m.activation !== "view") {
      throw new Error(`"activation" must be "startup" or "view"`);
    }
    if (m.activation === "view" && !m.host) throw new Error(`"activation": "view" needs a "host" module`);
    out.activation = m.activation;
  }

  const views = m.sidebarViews ?? [];
  if (!Array.isArray(views) || views.length > MAX_VIEWS) {
    throw new Error(`"sidebarViews" must be a list of at most ${MAX_VIEWS}`);
  }
  if (views.length && !out.panel) throw new Error(`"sidebarViews" needs a "panel" module to render them`);
  const viewIds = new Set();
  for (const [i, v] of views.entries()) {
    const id = name(v?.id, `sidebarViews[${i}].id`);
    if (viewIds.has(id)) throw new Error(`sidebar view "${id}" is declared twice`);
    viewIds.add(id);
    out.sidebarViews.push({
      id,
      title: text(v.title, `sidebarViews[${i}].title`),
      icon: name(v.icon, `sidebarViews[${i}].icon`),
      // The panel draws its own header (a back button, a title that changes)
      // instead of the one the frame gives it.
      ownHeader: v.ownHeader === true,
    });
  }

  // Overlays: a view shown over the window rather than in the sidebar, like a
  // palette. The core draws the backdrop and closes it on Escape or a click
  // outside; the panel module draws the rest, mounted with the overlay's id.
  const overlays = m.overlays ?? [];
  if (!Array.isArray(overlays) || overlays.length > MAX_VIEWS) {
    throw new Error(`"overlays" must be a list of at most ${MAX_VIEWS}`);
  }
  if (overlays.length && !out.panel) throw new Error(`"overlays" needs a "panel" module to render them`);
  const overlayIds = new Set();
  for (const [i, o] of overlays.entries()) {
    const id = name(o?.id, `overlays[${i}].id`);
    if (overlayIds.has(id) || viewIds.has(id)) throw new Error(`view "${id}" is declared twice`);
    overlayIds.add(id);
    out.overlays.push({ id });
  }

  if (m.tabBarButton !== undefined) {
    const b = m.tabBarButton;
    const view = name(b?.view, "tabBarButton.view");
    if (!viewIds.has(view)) throw new Error(`"tabBarButton.view" names no sidebar view (${view})`);
    out.tabBarButton = {
      view,
      icon: name(b.icon, "tabBarButton.icon"),
      title: text(b.title, "tabBarButton.title"),
      // Where it sits among the plugin buttons: lower first, then by id.
      order: Number.isFinite(b.order) ? Number(b.order) : 100,
    };
  }

  // Shortcuts are declarative: a key plus what it does, so the keymap can carry
  // them from the first frame without loading any plugin code. Plugin rows are
  // registered after the core's, and the dispatcher takes the first match, so a
  // plugin can never take over a chord the app already uses.
  const commands = m.commands ?? [];
  if (!Array.isArray(commands) || commands.length > MAX_COMMANDS) {
    throw new Error(`"commands" must be a list of at most ${MAX_COMMANDS}`);
  }
  for (const [i, c] of commands.entries()) {
    const id = name(c?.id, `commands[${i}].id`);
    if (typeof c.key !== "string" || !/^[a-z0-9]$/.test(c.key)) {
      throw new Error(`"commands[${i}].key" must be a single lowercase letter or digit`);
    }
    let action;
    if (typeof c.toggleView === "string") {
      if (!viewIds.has(c.toggleView)) throw new Error(`"commands[${i}].toggleView" names no sidebar view`);
      action = { toggleView: c.toggleView };
    } else if (typeof c.toggleOverlay === "string") {
      if (!overlayIds.has(c.toggleOverlay)) throw new Error(`"commands[${i}].toggleOverlay" names no overlay`);
      action = { toggleOverlay: c.toggleOverlay };
    } else if (typeof c.invoke === "string") {
      if (!out.host) throw new Error(`"commands[${i}].invoke" needs a "host" module`);
      action = { invoke: name(c.invoke, `commands[${i}].invoke`) };
    } else if (typeof c.run === "string") {
      if (!out.renderer) throw new Error(`"commands[${i}].run" needs a "renderer" module`);
      action = { run: name(c.run, `commands[${i}].run`) };
    } else {
      throw new Error(`"commands[${i}]" needs "toggleView", "toggleOverlay", "invoke" or "run"`);
    }
    out.commands.push({
      id,
      title: text(c.title, `commands[${i}].title`),
      key: c.key,
      shift: c.shift === true,
      ...action,
    });
  }
  return out;
}

// What a window needs to draw a plugin: static data plus where to load its code.
// The version rides on the URLs so an updated plugin is never served from the
// renderer's module cache.
function contributionOf(manifest) {
  const url = (rel) =>
    rel ? `${SCHEME}://${manifest.id}/${rel}?v=${encodeURIComponent(manifest.version)}` : null;
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    panel: url(manifest.panel),
    style: url(manifest.style),
    renderer: url(manifest.renderer),
    sidebarViews: manifest.sidebarViews,
    overlays: manifest.overlays,
    tabBarButton: manifest.tabBarButton,
    commands: manifest.commands,
  };
}

// --- the registry -------------------------------------------------------------

function createPlugins({ app, ipcMain, shell, protocol, utilityProcess, openWindows, bundledDir }) {
  const userData = app.getPath("userData");
  const pluginsDir = path.join(userData, "plugins");
  const statePath = path.join(userData, "plugins.json");
  const dataDir = path.join(userData, "plugin-data");

  // { enabled: { [id]: true }, disabled: { [id]: true }, installed: {...},
  // contributions: [...] }. `enabled` lists the external plugins the user
  // turned on, `disabled` the built-in ones they turned off: each kind is
  // recorded only when it differs from its default. `installed` is where each
  // plugin added from Settings came from (`{ source, ref, commit, installedAt }`),
  // which is also what makes it removable from there: a folder put in place by
  // hand is the user's, never deleted by us. `contributions` is the external
  // half of the next launch's boot answer. `autoUpdate: false` is there only
  // when the user turned automatic plugin updates off.
  let state = null;

  // Built-in plugins: the same contract, shipped inside the app and on by
  // default. Read synchronously with the state, because they are part of the
  // first frame from the very first launch (and the first launch after an
  // update that changed one), when there is no cached answer to fall back on.
  // A handful of small files from the app's own folder.
  let bundled = null; // id -> { id, dir, manifest | null, error | null, builtIn: true }

  // id -> { id, dir, manifest | null, error | null }
  const discovered = new Map();
  // id -> "starting" | "active" | "failed"
  const hostStatus = new Map();
  const hostErrors = new Map();
  const badges = new Map();
  let discoveredOnce = false;
  // What the last update check found, in memory only: the next launch checks
  // again. id -> { ref, version, auto }, and id -> why the check (or the
  // automatic update) failed.
  const updates = new Map();
  const updateErrors = new Map();
  // id -> the release an automatic update could not install. It is not tried
  // on its own again (each try stops the working copy and restarts it), only
  // from the button, until a newer release replaces it on offer.
  const failedAuto = new Map();
  // id -> the update swapping its folder right now. Turning the plugin on, or
  // its panel's first call starting it, waits for the swap, so neither starts
  // a copy that is half moved.
  const swapping = new Map();

  // Read once, synchronously, the first time a window's boot flags are built.
  // One small file, and only the first window pays for it.
  function loadState() {
    if (state) return state;
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      const map = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
      state = {
        enabled: map(parsed?.enabled),
        disabled: map(parsed?.disabled),
        installed: map(parsed?.installed),
        contributions: Array.isArray(parsed?.contributions) ? parsed.contributions : [],
        ...(parsed?.autoUpdate === false ? { autoUpdate: false } : {}),
      };
    } catch (_) {
      state = { enabled: {}, disabled: {}, installed: {}, contributions: [] };
    }
    loadBundled();
    return state;
  }

  function loadBundled() {
    if (bundled) return bundled;
    bundled = new Map();
    if (!bundledDir) return bundled;
    let names = [];
    try {
      names = fs.readdirSync(bundledDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name);
    } catch (_) {
      return bundled;
    }
    for (const name of names) {
      const dir = path.join(bundledDir, name);
      try {
        const manifest = parseManifest(dir, fs.readFileSync(path.join(dir, MANIFEST), "utf-8"));
        bundled.set(manifest.id, { id: manifest.id, dir, manifest, error: null, builtIn: true });
      } catch (err) {
        // A broken built-in is a build mistake, never the user's; say so loudly.
        console.error(`[plugins] built-in plugin "${name}" is invalid:`, err.message);
        bundled.set(name, { id: name, dir, manifest: null, error: `invalid manifest: ${err.message}`, builtIn: true });
      }
    }
    return bundled;
  }

  function writeState() {
    const tmp = `${statePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, statePath);
    } catch (err) {
      console.error("[plugins] could not save plugins.json:", err.message);
    }
  }

  const isBuiltIn = (id) => loadBundled().has(id);
  const isEnabled = (id) =>
    isBuiltIn(id) ? loadState().disabled[id] !== true : loadState().enabled[id] === true;

  // What a window draws at boot, before discovery has run: the built-ins as
  // they are now, plus the external plugins as the last run left them.
  function bootContributions() {
    if (discoveredOnce) return currentContributions();
    const s = loadState();
    const builtIns = [...loadBundled().values()]
      .filter((p) => p.manifest && isEnabled(p.id))
      .map((p) => contributionOf(p.manifest));
    const external = s.contributions.filter((c) => !isBuiltIn(c.id));
    return [...builtIns, ...external].sort((a, b) => a.id.localeCompare(b.id));
  }

  function currentContributions() {
    const out = [];
    for (const p of discovered.values()) {
      if (p.manifest && isEnabled(p.id) && hostStatus.get(p.id) !== "failed") {
        out.push(contributionOf(p.manifest));
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  function list() {
    const installed = loadState().installed;
    return [...discovered.values()]
      .map((p) => ({
        id: p.id,
        name: p.manifest?.name ?? p.id,
        version: p.manifest?.version ?? null,
        dir: p.dir,
        builtIn: p.builtIn === true,
        enabled: isEnabled(p.id),
        running: hostStatus.get(p.id) === "active",
        error: p.error ?? hostErrors.get(p.id) ?? null,
        installed: (!p.builtIn && installed[p.id]) || null,
        update: updates.get(p.id) ?? null,
        updateError: updateErrors.get(p.id) ?? null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  function sendAll(channel, ...args) {
    for (const win of openWindows()) win.webContents.send(channel, ...args);
  }

  // Tell every window what changed, and remember it as the next launch's boot
  // answer. Skipped when nothing changed, so a launch whose cache was right
  // costs the windows nothing.
  function publish() {
    const s = loadState();
    const next = currentContributions();
    // Only the external plugins are cached: the built-ins are read fresh at
    // every boot (see loadBundled).
    const external = next.filter((c) => !isBuiltIn(c.id));
    if (JSON.stringify(external) !== JSON.stringify(s.contributions)) {
      s.contributions = external;
      writeState();
    }
    sendAll("plugins:changed", { contributions: next, plugins: list() });
  }

  // Read into a new map and swapped in at the end, so a window asking for a
  // plugin's files while this runs (after an install) never finds it missing.
  async function discover() {
    const found = new Map();
    for (const p of loadBundled().values()) found.set(p.id, p);
    let entries = [];
    try {
      entries = await fs.promises.readdir(pluginsDir, { withFileTypes: true });
    } catch (_) {
      entries = []; // no plugins folder: nothing installed
    }
    // A symlinked folder counts: it is how a plugin is developed in place, from
    // the repo it lives in.
    const isFolder = async (e) =>
      e.isDirectory() ||
      (e.isSymbolicLink() &&
        (await fs.promises.stat(path.join(pluginsDir, e.name)).then((s) => s.isDirectory(), () => false)));
    const folders = [];
    for (const e of entries) {
      if (!e.name.startsWith(".") && (await isFolder(e))) folders.push(e);
    }
    await Promise.all(
      folders
        .map(async (e) => {
          const dir = path.join(pluginsDir, e.name);
          try {
            const raw = await fs.promises.readFile(path.join(dir, MANIFEST), "utf-8");
            const manifest = parseManifest(dir, raw);
            if (isBuiltIn(manifest.id)) {
              // Listed under its folder name, so it doesn't replace the
              // built-in it collides with.
              found.set(`${e.name} (external)`, {
                id: `${e.name} (external)`,
                dir,
                manifest: null,
                error: `"${manifest.id}" is the id of a built-in plugin; give this one another id`,
              });
              return;
            }
            found.set(manifest.id, { id: manifest.id, dir, manifest, error: null });
          } catch (err) {
            const error =
              err.code === "ENOENT" ? `no ${MANIFEST} in this folder` : `invalid manifest: ${err.message}`;
            found.set(e.name, { id: e.name, dir, manifest: null, error });
          }
        })
    );
    discovered.clear();
    for (const [id, p] of found) discovered.set(id, p);
  }

  // --- the plugin host process ----------------------------------------------

  let host = null;
  let nextCallId = 1;
  const pending = new Map(); // callId -> { resolve, reject, timer }

  function startHost() {
    if (host) return host;
    host = utilityProcess.fork(path.join(__dirname, "plugin-host.cjs"), [], {
      serviceName: "Specterm Plugin Host",
    });
    const proc = host;
    proc.on("message", onHostMessage);
    proc.on("exit", (code) => {
      if (host !== proc) return;
      host = null;
      for (const [, call] of pending) {
        clearTimeout(call.timer);
        call.reject(new Error(`plugin host exited (code ${code})`));
      }
      pending.clear();
      // Anything still running in it is gone. Unexpected unless we killed it,
      // and we only kill it when nothing is running in it.
      let changed = false;
      for (const [id, status] of hostStatus) {
        if (status === "failed") continue;
        hostStatus.set(id, "failed");
        hostErrors.set(id, `the plugin host stopped (code ${code}); turn the plugin off and on to restart it`);
        changed = true;
      }
      if (changed) publish();
    });
    return proc;
  }

  function stopHostIfIdle() {
    for (const status of hostStatus.values()) {
      if (status === "active" || status === "starting") return;
    }
    if (host) {
      const proc = host;
      host = null;
      proc.kill();
    }
  }

  function request(msg, timeoutMs) {
    const proc = startHost();
    const callId = nextCallId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(callId);
        reject(new Error(`plugin "${msg.id}" did not answer within ${timeoutMs / 1000}s`));
      }, timeoutMs);
      pending.set(callId, { resolve, reject, timer });
      proc.postMessage({ ...msg, callId });
    });
  }

  // What a plugin says while it is still inside activate() counts: setting the
  // badge first thing is the obvious way to write one.
  const running = (id) => {
    const status = hostStatus.get(id);
    return status === "active" || status === "starting";
  };

  function onHostMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "reply": {
        const call = pending.get(msg.callId);
        if (!call) return;
        pending.delete(msg.callId);
        clearTimeout(call.timer);
        if (msg.ok) call.resolve(msg.value);
        else call.reject(new Error(msg.error || "plugin call failed"));
        return;
      }
      case "emit":
        if (running(msg.id)) sendAll("plugins:event", msg.id, msg.event, msg.payload);
        return;
      case "badge": {
        if (!running(msg.id)) return;
        const value = normaliseBadge(msg.value);
        if (value === null) badges.delete(msg.id);
        else badges.set(msg.id, value);
        sendAll("plugins:badge", msg.id, value);
        return;
      }
      case "toast": {
        if (!running(msg.id)) return;
        const toast = normaliseToast(msg.toast);
        if (toast) sendAll("plugins:toast", msg.id, toast);
        return;
      }
      case "open-external":
        if (running(msg.id) && /^https?:\/\//i.test(String(msg.url))) {
          void shell.openExternal(String(msg.url));
        }
        return;
    }
  }

  // A toast is a short heads-up under the plugin's button: bounded text, so a
  // plugin can't paint a wall over the window, and a payload handed to its
  // panel if the toast is clicked.
  function normaliseToast(t) {
    if (!t || typeof t !== "object" || typeof t.title !== "string" || !t.title.trim()) return null;
    const clip = (v, n) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
    return {
      title: clip(t.title, 80),
      tag: clip(t.tag, 40),
      body: clip(t.body, 300),
      more: Number.isInteger(t.more) && t.more > 0 ? t.more : 0,
      payload: t.payload === undefined ? null : t.payload,
    };
  }

  function normaliseBadge(value) {
    if (value === "dot") return "dot";
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
    return null;
  }

  async function activate(p) {
    if (!p.manifest?.host) return;
    hostStatus.set(p.id, "starting");
    hostErrors.delete(p.id);
    const storagePath = path.join(dataDir, p.id);
    try {
      await fs.promises.mkdir(storagePath, { recursive: true });
      await request(
        { type: "activate", id: p.id, file: path.join(p.dir, p.manifest.host), dir: p.dir, storagePath },
        LIFECYCLE_TIMEOUT_MS
      );
      // Turned off while it was starting: undo it.
      if (!isEnabled(p.id)) return deactivate(p.id);
      hostStatus.set(p.id, "active");
    } catch (err) {
      hostStatus.set(p.id, "failed");
      hostErrors.set(p.id, `failed to start: ${err.message}`);
      // Let it undo whatever it registered before failing — unless the host is
      // what failed, in which case there is nothing left to undo.
      if (host) await request({ type: "deactivate", id: p.id }, LIFECYCLE_TIMEOUT_MS).catch(() => {});
      stopHostIfIdle();
    }
  }

  async function deactivate(id) {
    const status = hostStatus.get(id);
    hostStatus.delete(id);
    hostErrors.delete(id);
    if (badges.delete(id)) sendAll("plugins:badge", id, null);
    if (status && host) {
      await request({ type: "deactivate", id }, LIFECYCLE_TIMEOUT_MS).catch((err) =>
        console.error(`[plugins] ${id} did not deactivate cleanly:`, err.message)
      );
    }
    stopHostIfIdle();
  }

  // --- wiring ---------------------------------------------------------------

  protocol.handle(SCHEME, async (req) => {
    const url = new URL(req.url);
    const p = discovered.get(url.hostname);
    if (!p?.manifest || !isEnabled(p.id)) return new Response("not found", { status: 404 });
    const rel = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    // The files the manifest names, and whatever sits beside them in their
    // folders (a bundler's shared chunks) — never the rest of the plugin, so
    // its host module and manifest are not readable from the page.
    const entries = [p.manifest.panel, p.manifest.style, p.manifest.renderer].filter(Boolean);
    const dirs = entries.map((e) => path.posix.dirname(e)).filter((d) => d !== ".");
    const allowed =
      entries.includes(rel) ||
      (!rel.split("/").includes("..") && dirs.some((d) => rel.startsWith(d + "/")));
    if (!allowed) return new Response("not found", { status: 404 });
    try {
      const body = await fs.promises.readFile(path.join(p.dir, rel));
      return new Response(body, {
        headers: {
          "content-type": CONTENT_TYPES[path.extname(rel)] ?? "application/octet-stream",
          "access-control-allow-origin": "*",
          "cache-control": "no-cache",
        },
      });
    } catch (_) {
      return new Response("not found", { status: 404 });
    }
  });

  // The boot answer, collected by the preload over a blocking channel — only on
  // launches where `hasBootContributions()` stamped the flag, so a user with no
  // plugins never pays for the round trip.
  ipcMain.on("plugins-boot-sync", (event) => {
    event.returnValue = bootContributions();
  });

  ipcMain.handle("plugins:list", () => list());

  // Everything a window needs to catch up with, asked for once it has
  // subscribed to the changes — so whatever was published before it was
  // listening is not lost.
  ipcMain.handle("plugins:state", () => ({
    contributions: bootContributions(),
    plugins: list(),
    badges: Object.fromEntries(badges),
  }));

  ipcMain.handle("plugins:set-enabled", async (_event, id, enabled) => {
    await swapping.get(id);
    const p = discovered.get(id);
    if (!p) throw new Error(`no plugin "${id}"`);
    if (enabled && !p.manifest) throw new Error(p.error || `plugin "${id}" cannot be enabled`);
    const s = loadState();
    if (isBuiltIn(id)) {
      if (enabled) delete s.disabled[id];
      else s.disabled[id] = true;
    } else if (enabled) s.enabled[id] = true;
    else delete s.enabled[id];
    writeState();
    if (enabled) {
      if (p.manifest.activation === "startup") await activate(p);
    } else await deactivate(id);
    publish();
    return list();
  });

  // Starts a view-activated plugin's host on its panel's first call. Calls that
  // arrive while it starts wait for the same activation.
  const activating = new Map();
  async function ensureRunning(id) {
    await swapping.get(id);
    if (hostStatus.get(id) === "active") return;
    const p = discovered.get(id);
    if (!p?.manifest?.host || !isEnabled(id) || p.manifest.activation !== "view" || hostStatus.get(id) === "failed") {
      throw new Error(`plugin "${id}" is not running`);
    }
    if (!activating.has(id)) {
      activating.set(
        id,
        activate(p).finally(() => {
          activating.delete(id);
          publish();
        })
      );
    }
    await activating.get(id);
    if (hostStatus.get(id) !== "active") throw new Error(hostErrors.get(id) || `plugin "${id}" failed to start`);
  }

  ipcMain.handle("plugins:invoke", async (_event, id, method, args) => {
    if (typeof method !== "string" || !NAME_RE.test(method)) throw new Error("invalid method name");
    await ensureRunning(id);
    return request({ type: "invoke", id, method, args: Array.isArray(args) ? args : [] }, INVOKE_TIMEOUT_MS);
  });

  // --- adding and removing from Settings --------------------------------------

  // One at a time, and never before the first discovery: each of these ends in
  // a fresh discovery of its own, and two of them interleaved could each see
  // the other's half-moved folder.
  let queue = Promise.resolve();
  let started = null;
  const serial = (fn) => {
    const run = queue.then(() => started).then(fn);
    queue = run.catch(() => {});
    return run;
  };

  // Clone the release into a hidden folder next to the installed plugins (the
  // same disk, so the last step is a rename), check its manifest as discovery
  // would, and only then move it into place. Whatever fails leaves nothing
  // behind. Adding a plugin is the user's opt-in, so it is turned on.
  async function install(input) {
    const source = parseSource(input);
    await fs.promises.mkdir(pluginsDir, { recursive: true });
    const staging = await fs.promises.mkdtemp(path.join(pluginsDir, ".install-"));
    try {
      const fetched = await fetchSource(source, path.join(staging, "clone"));
      let raw;
      try {
        raw = await fs.promises.readFile(path.join(fetched.dir, MANIFEST), "utf-8");
      } catch (_) {
        throw new Error(
          `no ${MANIFEST} in ${source.subdir ? `"${source.subdir}"` : "the repository's root"}` +
            (source.subdir ? "" : "; for a plugin in a subfolder, add #<tag>:<folder> to the URL")
        );
      }
      let id;
      try {
        id = JSON.parse(raw)?.id;
      } catch (err) {
        throw new Error(`invalid manifest: ${err.message}`);
      }
      if (typeof id !== "string" || !ID_RE.test(id)) throw new Error(`invalid manifest: "id" must match ${ID_RE}`);
      if (isBuiltIn(id)) throw new Error(`"${id}" is the id of a built-in plugin`);
      // A folder copied in by hand can carry the same id under another name:
      // installing over it would leave two plugins with one id, and Remove
      // could then delete the hand-copied one.
      const target = path.join(pluginsDir, id);
      if (fs.existsSync(target) || discovered.has(id)) {
        throw new Error(`a plugin called "${id}" is already installed; remove it first`);
      }

      const ready = path.join(staging, "ready", id);
      await fs.promises.mkdir(path.dirname(ready));
      await fs.promises.rename(fetched.dir, ready);
      // The repo's history is not part of the plugin: where it came from is
      // recorded in the state instead.
      await fs.promises.rm(path.join(ready, ".git"), { recursive: true, force: true, maxRetries: 3 });
      try {
        parseManifest(ready, raw);
      } catch (err) {
        throw new Error(`invalid manifest: ${err.message}`);
      }
      await fs.promises.rename(ready, target);

      const s = loadState();
      s.installed[id] = {
        source: describeSource(source),
        ref: fetched.ref,
        commit: fetched.commit,
        installedAt: new Date().toISOString(),
      };
      s.enabled[id] = true;
      writeState();
      await discover();
      const p = discovered.get(id);
      if (p?.manifest?.activation === "startup") await activate(p);
      publish();
      return { id, plugins: list() };
    } finally {
      await fs.promises.rm(staging, { recursive: true, force: true, maxRetries: 3 }).catch((err) =>
        console.error("[plugins] could not clean up after an install:", err.message)
      );
    }
  }

  async function remove(id) {
    const s = loadState();
    const p = discovered.get(id);
    if (!p || p.builtIn || !s.installed[id]) throw new Error(`"${id}" was not added from Settings, so it is not removed from here`);
    await deactivate(id);
    delete s.enabled[id];
    delete s.installed[id];
    writeState();
    // A symlink is someone's working copy: drop the link, never what it points at.
    const stat = await fs.promises.lstat(p.dir).catch(() => null);
    if (stat?.isSymbolicLink()) await fs.promises.unlink(p.dir);
    else if (stat) await fs.promises.rm(p.dir, { recursive: true, force: true, maxRetries: 3 });
    updates.delete(id);
    updateErrors.delete(id);
    failedAuto.delete(id);
    await discover();
    publish();
    return list();
  }

  // --- updates ----------------------------------------------------------------

  // What is newer than the installed copy, or null. A plugin that follows
  // releases (installed at a release tag, or from a repo that had none yet) is
  // offered the newest release tag above it; one pinned to a branch or to some
  // other tag is offered that ref again once it has moved to another commit.
  //
  // `auto`: whether automatic updates may install it without asking. Only a
  // release semver calls compatible with the installed one (a minor or patch
  // of the same major; below 1.0.0, only a patch): a new major can change what
  // the plugin does or what it reaches, and a branch is not a release anyone
  // signed off on. When both exist, the compatible release comes first; the
  // new major is offered on the check after it.
  async function findUpdate(record, tagsOf) {
    const source = parseSource(record.source);
    const installed = releaseVersion(record.ref, source.subdir);
    // At a pre-release, the release it leads to (or a newer one) is offered,
    // never installed on its own: the pre-release was a choice.
    const pre = !installed && prereleaseVersion(record.ref, source.subdir);
    if (installed || pre || !record.ref) {
      const tags = await tagsOf(source.url);
      const isNewer = (release) => {
        if (!release) return false;
        const v = releaseVersion(release.tag, source.subdir);
        if (pre) return !newer(pre, v);
        return !installed || newer(v, installed);
      };
      const compatible = installed && newestRelease(tags, source.subdir, installed);
      if (isNewer(compatible)) return { ref: compatible.tag, version: compatible.version, auto: true };
      const latest = newestRelease(tags, source.subdir);
      if (isNewer(latest)) return { ref: latest.tag, version: latest.version, auto: false };
      if (installed || pre) return null;
    }
    const commit = await remoteCommit(source.url, record.ref, { interactive: false });
    return commit && commit !== record.commit ? { ref: record.ref, version: commit.slice(0, 7), auto: false } : null;
  }

  // Automatic updates are on unless turned off in Settings; like the other
  // switches, only the difference from the default is stored.
  const autoUpdates = () => loadState().autoUpdate !== false;

  // The window that tells the user what was updated in the background: the
  // focused one, else the first. One dialog, not one per window.
  function announce(updated) {
    const windows = openWindows();
    const target = windows.find((w) => w.isFocused()) ?? windows[0];
    target?.webContents.send("plugins:auto-updated", updated);
  }

  // Asks every repo a plugin was added from what it has now: one ls-remote per
  // repo, however many plugins live in it, and never a prompt (see git() in
  // plugin-install.cjs). A failure is kept per plugin and shown in Settings.
  // Queued with installs and updates, so it never reads a record mid-change.
  //
  // With automatic updates on, what may be installed without asking is
  // installed right away. `announce`: a check nobody is watching (at launch,
  // every 6 hours) shows a dialog with what moved; the one from Settings shows
  // it inline instead.
  //
  // A check asked for while one runs joins it. If either of them is a
  // background one, what it installed is announced: a check from the button
  // that a background one joined must not swallow the dialog.
  let checking = null;
  let announceChecked = false;
  function checkUpdates({ announce: shouldAnnounce = false } = {}) {
    if (shouldAnnounce) announceChecked = true;
    checking ??= serial(async () => {
      const s = loadState();
      const tags = new Map();
      const tagsOf = (url) => {
        if (!tags.has(url)) tags.set(url, remoteTags(url, { interactive: false }));
        return tags.get(url);
      };
      const targets = [...discovered.values()].filter((p) => !p.builtIn && s.installed[p.id]);
      await Promise.all(
        targets.map(async (p) => {
          try {
            const offer = await findUpdate(s.installed[p.id], tagsOf);
            if (offer) updates.set(p.id, offer);
            else updates.delete(p.id);
            // The reason an automatic update failed stays next to the offer
            // for as long as that release is the one on offer.
            if (failedAuto.get(p.id) !== offer?.ref) {
              failedAuto.delete(p.id);
              updateErrors.delete(p.id);
            }
          } catch (err) {
            updateErrors.set(p.id, `could not check for updates: ${err.message}`);
          }
        })
      );
      const updated = [];
      if (autoUpdates()) {
        for (const [id, offer] of [...updates]) {
          if (!offer.auto || failedAuto.get(id) === offer.ref) continue;
          const p = discovered.get(id);
          const from = p?.manifest?.version ?? null;
          try {
            const { version } = await applyUpdate(id, { interactive: false });
            updated.push({ id, name: discovered.get(id)?.manifest?.name ?? id, from, to: version });
          } catch (err) {
            // Still offered, with the reason: the button in Settings retries.
            failedAuto.set(id, offer.ref);
            updateErrors.set(id, err.message);
          }
        }
      }
      publish();
      return { plugins: list(), updated };
    }).then((result) => {
      if (announceChecked && result.updated.length) announce(result.updated);
      return result;
    }).finally(() => {
      checking = null;
      announceChecked = false;
    });
    return checking;
  }

  // Windows refuses a rename for a moment while something (an antivirus, the
  // indexer) still has a file in the folder open.
  async function move(from, to) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fs.promises.rename(from, to);
      } catch (err) {
        if (attempt >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(err.code)) throw err;
        await new Promise((r) => setTimeout(r, 100 * attempt));
      }
    }
  }

  // Moves an added plugin to what the last check offered, without a restart.
  // The release is fetched and its manifest validated before anything running
  // is touched; then the plugin is turned off, the folders are swapped, and the
  // new copy is started once to see that it can: every plugin with a host,
  // including one whose view is not open (it goes back to sleep after). If it
  // cannot start, the old copy goes back and the error says so. Open views
  // reload, because their URLs carry the version (see contributionOf). Not
  // queued itself: the IPC handler and the check, which already runs in the
  // queue, call it.
  //
  // The old copy is only ever deleted once a working copy is confirmed in its
  // place. If putting it back fails, or the app quits mid-swap, it stays in the
  // staging folder, and the next launch puts it back (see recoverUpdates).
  async function applyUpdate(id, { interactive = true } = {}) {
    const s = loadState();
    const p = discovered.get(id);
    const record = s.installed[id];
    if (!p || p.builtIn || !record) throw new Error(`"${id}" was not added from Settings, so it is not updated from here`);
    const offer = updates.get(id);
    if (!offer) throw new Error("no update to install; check for updates first");
    const source = parseSource(record.source);
    const staging = await fs.promises.mkdtemp(path.join(pluginsDir, ".update-"));
    let keepStaging = false;
    let doneSwapping;
    swapping.set(id, new Promise((resolve) => (doneSwapping = resolve)));
    try {
      const fetched = await fetchSource({ ...source, ref: offer.ref }, path.join(staging, "clone"), { interactive });
      const ready = path.join(staging, "ready", id);
      await fs.promises.mkdir(path.dirname(ready));
      await move(fetched.dir, ready);
      await fs.promises.rm(path.join(ready, ".git"), { recursive: true, force: true, maxRetries: 3 });
      let manifest;
      try {
        manifest = parseManifest(ready, await fs.promises.readFile(path.join(ready, MANIFEST), "utf-8"));
      } catch (err) {
        throw new Error(`${offer.version} cannot be installed: ${err.code === "ENOENT" ? `no ${MANIFEST}` : err.message}`);
      }

      const wasRunning = hostStatus.get(id) === "active";
      // Back to how it was: running if it was, or if it starts with the app.
      const restart = async (plugin) => {
        if (!plugin?.manifest || !isEnabled(id)) return;
        if (plugin.manifest.activation === "startup" || wasRunning) await activate(plugin);
      };
      const previous = path.join(staging, "previous");
      // The old copy back in place. If that fails too, the plugin is left
      // without a folder until the next launch restores it from `previous`.
      const putBack = async () => {
        try {
          await move(previous, p.dir);
        } catch (err) {
          keepStaging = true;
          throw new Error(
            `could not put ${p.manifest?.version ?? "the installed copy"} back (${err.message}); it will be restored the next time Specterm starts`
          );
        }
        await discover();
        await restart(discovered.get(id));
      };

      await deactivate(id);
      try {
        await move(p.dir, previous);
      } catch (err) {
        await restart(p);
        throw new Error(`could not move the installed copy aside: ${err.message}`);
      }
      // From here until a working copy is confirmed, the only good copy is
      // `previous`: a quit now leaves it for the next launch.
      keepStaging = true;
      try {
        await move(ready, p.dir);
      } catch (err) {
        await putBack();
        keepStaging = false;
        throw new Error(`could not put ${offer.version} in place: ${err.message}`);
      }
      await discover();
      const fresh = discovered.get(id);
      // Started once, enabled or not running, to see that it can start.
      if (fresh?.manifest?.host && isEnabled(id)) {
        await activate(fresh);
        if (hostStatus.get(id) === "failed") {
          const why = hostErrors.get(id);
          await deactivate(id);
          try {
            await move(p.dir, path.join(staging, "failed"));
          } catch (err) {
            // The broken copy is stuck in place; `previous` waits for the
            // next launch, which keeps whichever copy is in the folder.
            throw new Error(`${offer.version} did not start (${why}), and could not be moved aside: ${err.message}`);
          }
          await putBack();
          keepStaging = false;
          publish();
          throw new Error(`${offer.version} did not start (${why}), so ${p.manifest?.version ?? "the installed copy"} was kept`);
        }
        if (!(fresh.manifest.activation === "startup" || wasRunning)) await deactivate(id);
      }
      keepStaging = false;

      s.installed[id] = {
        ...record,
        // A source that named a tag now names the new one; one that follows
        // the newest release, or a branch, reads as it did.
        source: describeSource({ ...source, ref: source.ref === null ? null : offer.ref }),
        ref: fetched.ref,
        commit: fetched.commit,
        updatedAt: new Date().toISOString(),
      };
      writeState();
      // Recorded: from here a quit keeps the new copy (see recoverUpdates).
      await fs.promises.writeFile(path.join(staging, "done"), "").catch(() => {});
      updates.delete(id);
      updateErrors.delete(id);
      failedAuto.delete(id);
      publish();
      return { version: manifest.version, plugins: list() };
    } finally {
      swapping.delete(id);
      doneSwapping();
      if (!keepStaging) {
        await fs.promises.rm(staging, { recursive: true, force: true, maxRetries: 3 }).catch((err) =>
          console.error("[plugins] could not clean up after an update:", err.message)
        );
      }
    }
  }

  // At launch, before discovery: what an update or an install left behind when
  // the app quit (or a rename failed) in the middle. Until an update writes
  // `done` (after its record is saved), its `previous` is the plugin's working
  // copy, the one plugins.json describes: it goes back in place, and whatever
  // is in the plugin's folder (nothing, or a copy that was never validated)
  // goes. Either way the staging folder goes. Only the hidden folders this file
  // creates are looked at, so a launch with nothing left behind costs one
  // readdir.
  async function recoverUpdates() {
    let entries = [];
    try {
      entries = await fs.promises.readdir(pluginsDir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || !/^\.(update|install)-/.test(e.name)) continue;
      const staging = path.join(pluginsDir, e.name);
      const previous = path.join(staging, "previous");
      try {
        const unfinished =
          e.name.startsWith(".update-") &&
          !fs.existsSync(path.join(staging, "done")) &&
          fs.existsSync(path.join(previous, MANIFEST));
        if (unfinished) {
          const id = JSON.parse(await fs.promises.readFile(path.join(previous, MANIFEST), "utf-8"))?.id;
          if (typeof id === "string" && ID_RE.test(id)) {
            const dir = path.join(pluginsDir, id);
            if (fs.existsSync(dir)) await move(dir, path.join(staging, "unfinished"));
            await move(previous, dir);
            console.warn(`[plugins] restored "${id}" from an update that did not finish`);
          }
        }
        await fs.promises.rm(staging, { recursive: true, force: true, maxRetries: 3 });
      } catch (err) {
        console.error(`[plugins] could not clean up ${e.name}:`, err.message);
      }
    }
  }

  ipcMain.handle("plugins:install", (_event, source) => serial(() => install(source)));
  ipcMain.handle("plugins:remove", (_event, id) => serial(() => remove(String(id))));
  ipcMain.handle("plugins:check-updates", () => checkUpdates());
  ipcMain.handle("plugins:update", (_event, id) => serial(() => applyUpdate(String(id), { interactive: true })));
  ipcMain.handle("plugins:auto-update", () => autoUpdates());
  ipcMain.handle("plugins:set-auto-update", (_event, on) => {
    const s = loadState();
    if (on) delete s.autoUpdate;
    else s.autoUpdate = false;
    writeState();
    return autoUpdates();
  });
  // For the tests: the check the timers run, dialog included.
  ipcMain.handle("plugins:check-updates-background", () => checkUpdates({ announce: true }));

  let updateTimers = [];
  function scheduleUpdateChecks() {
    const run = () => {
      if (Object.keys(loadState().installed).length === 0) return;
      checkUpdates({ announce: true }).catch((err) => console.error("[plugins] update check failed:", err.message));
    };
    updateTimers = [setTimeout(run, UPDATE_FIRST_CHECK_MS), setInterval(run, UPDATE_INTERVAL_MS)];
  }

  function start() {
    return (started ??= discoverAndActivate());
  }

  async function discoverAndActivate() {
    loadState();
    await recoverUpdates();
    await discover();
    discoveredOnce = true;
    await Promise.all(
      [...discovered.values()]
        .filter((p) => p.manifest && isEnabled(p.id) && p.manifest.activation === "startup")
        .map(activate)
    );
    publish();
    scheduleUpdateChecks();
  }

  return {
    // Whether the next window has plugin contributions to collect at boot.
    hasBootContributions: () => bootContributions().length > 0,
    start,
    // On quit: the host goes with the app, and nothing is waited on.
    stop() {
      for (const timer of updateTimers) clearTimeout(timer);
      if (host) {
        const proc = host;
        host = null;
        proc.kill();
      }
    },
  };
}

module.exports = { registerPluginScheme, createPlugins, parseManifest, API_VERSION };
