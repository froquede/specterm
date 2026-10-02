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

// The plugin API major version this build implements. A manifest asks for one
// with `engines.specterm: "^1"`; anything else is listed but cannot be enabled.
const API_VERSION = 1;

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

function engineMajor(range) {
  const m = typeof range === "string" ? /^\^(\d+)(\.\d+){0,2}$/.exec(range.trim()) : null;
  return m ? Number(m[1]) : null;
}

// Validated, normalised manifest — or a thrown Error whose message is shown in
// Settings next to the plugin, so it has to read as an instruction.
function parseManifest(dir, raw) {
  const m = JSON.parse(raw);
  if (!m || typeof m !== "object") throw new Error("the manifest is not a JSON object");
  if (typeof m.id !== "string" || !ID_RE.test(m.id)) throw new Error(`"id" must match ${ID_RE}`);
  if (m.id !== path.basename(dir)) throw new Error(`"id" must match its folder name (${path.basename(dir)})`);
  const major = engineMajor(m.engines?.specterm);
  if (major === null) throw new Error(`"engines.specterm" must be a caret range, like "^${API_VERSION}"`);
  if (major !== API_VERSION) {
    throw new Error(`needs plugin API ${major}, this Specterm provides ${API_VERSION}`);
  }

  const out = {
    id: m.id,
    name: text(m.name, "name"),
    version: text(m.version, "version"),
    host: m.host === undefined ? null : innerFile(dir, m.host, "host"),
    panel: m.panel === undefined ? null : innerFile(dir, m.panel, "panel"),
    style: m.style === undefined ? null : innerFile(dir, m.style, "style"),
    sidebarViews: [],
    tabBarButton: null,
    commands: [],
  };

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
    });
  }

  if (m.tabBarButton !== undefined) {
    const b = m.tabBarButton;
    const view = name(b?.view, "tabBarButton.view");
    if (!viewIds.has(view)) throw new Error(`"tabBarButton.view" names no sidebar view (${view})`);
    out.tabBarButton = {
      view,
      icon: name(b.icon, "tabBarButton.icon"),
      title: text(b.title, "tabBarButton.title"),
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
    } else if (typeof c.invoke === "string") {
      if (!out.host) throw new Error(`"commands[${i}].invoke" needs a "host" module`);
      action = { invoke: name(c.invoke, `commands[${i}].invoke`) };
    } else {
      throw new Error(`"commands[${i}]" needs "toggleView" or "invoke"`);
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
    sidebarViews: manifest.sidebarViews,
    tabBarButton: manifest.tabBarButton,
    commands: manifest.commands,
  };
}

// --- the registry -------------------------------------------------------------

function createPlugins({ app, ipcMain, shell, protocol, utilityProcess, openWindows }) {
  const userData = app.getPath("userData");
  const pluginsDir = path.join(userData, "plugins");
  const statePath = path.join(userData, "plugins.json");
  const dataDir = path.join(userData, "plugin-data");

  // { enabled: { [id]: true }, contributions: [...] } — the second half is the
  // boot answer for the next launch.
  let state = null;

  // id -> { id, dir, manifest | null, error | null }
  const discovered = new Map();
  // id -> "starting" | "active" | "failed"
  const hostStatus = new Map();
  const hostErrors = new Map();
  const badges = new Map();
  let discoveredOnce = false;

  // Read once, synchronously, the first time a window's boot flags are built.
  // One small file, and only the first window pays for it.
  function loadState() {
    if (state) return state;
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      state = {
        enabled: parsed && typeof parsed.enabled === "object" && parsed.enabled ? parsed.enabled : {},
        contributions: Array.isArray(parsed?.contributions) ? parsed.contributions : [],
      };
    } catch (_) {
      state = { enabled: {}, contributions: [] };
    }
    return state;
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

  const isEnabled = (id) => loadState().enabled[id] === true;

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
    return [...discovered.values()]
      .map((p) => ({
        id: p.id,
        name: p.manifest?.name ?? p.id,
        version: p.manifest?.version ?? null,
        dir: p.dir,
        enabled: isEnabled(p.id),
        error: p.error ?? hostErrors.get(p.id) ?? null,
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
    if (JSON.stringify(next) !== JSON.stringify(s.contributions)) {
      s.contributions = next;
      writeState();
    }
    sendAll("plugins:changed", { contributions: next, plugins: list() });
  }

  async function discover() {
    discovered.clear();
    let entries = [];
    try {
      entries = await fs.promises.readdir(pluginsDir, { withFileTypes: true });
    } catch (_) {
      return; // no plugins folder: nothing installed
    }
    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map(async (e) => {
          const dir = path.join(pluginsDir, e.name);
          try {
            const raw = await fs.promises.readFile(path.join(dir, MANIFEST), "utf-8");
            const manifest = parseManifest(dir, raw);
            discovered.set(manifest.id, { id: manifest.id, dir, manifest, error: null });
          } catch (err) {
            const error =
              err.code === "ENOENT" ? `no ${MANIFEST} in this folder` : `invalid manifest: ${err.message}`;
            discovered.set(e.name, { id: e.name, dir, manifest: null, error });
          }
        })
    );
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
      case "open-external":
        if (running(msg.id) && /^https?:\/\//i.test(String(msg.url))) {
          void shell.openExternal(String(msg.url));
        }
        return;
    }
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
    // Only the files the manifest names — not anything else in the folder.
    if (![p.manifest.panel, p.manifest.style].includes(rel)) {
      return new Response("not found", { status: 404 });
    }
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
    event.returnValue = discoveredOnce ? currentContributions() : loadState().contributions;
  });

  ipcMain.handle("plugins:list", () => list());

  // Everything a window needs to catch up with, asked for once it has
  // subscribed to the changes — so whatever was published before it was
  // listening is not lost.
  ipcMain.handle("plugins:state", () => ({
    contributions: discoveredOnce ? currentContributions() : loadState().contributions,
    plugins: list(),
    badges: Object.fromEntries(badges),
  }));

  ipcMain.handle("plugins:set-enabled", async (_event, id, enabled) => {
    const p = discovered.get(id);
    if (!p) throw new Error(`no plugin "${id}"`);
    if (enabled && !p.manifest) throw new Error(p.error || `plugin "${id}" cannot be enabled`);
    const s = loadState();
    if (enabled) s.enabled[id] = true;
    else delete s.enabled[id];
    writeState();
    if (enabled) await activate(p);
    else await deactivate(id);
    publish();
    return list();
  });

  ipcMain.handle("plugins:invoke", async (_event, id, method, args) => {
    if (hostStatus.get(id) !== "active") throw new Error(`plugin "${id}" is not running`);
    if (typeof method !== "string" || !NAME_RE.test(method)) throw new Error("invalid method name");
    return request({ type: "invoke", id, method, args: Array.isArray(args) ? args : [] }, INVOKE_TIMEOUT_MS);
  });

  async function start() {
    loadState();
    await discover();
    discoveredOnce = true;
    await Promise.all(
      [...discovered.values()].filter((p) => p.manifest && isEnabled(p.id)).map(activate)
    );
    publish();
  }

  return {
    // Whether the next window has plugin contributions to collect at boot.
    hasBootContributions: () =>
      (discoveredOnce ? currentContributions() : loadState().contributions).length > 0,
    start,
    // On quit: the host goes with the app, and nothing is waited on.
    stop() {
      if (host) {
        const proc = host;
        host = null;
        proc.kill();
      }
    },
  };
}

module.exports = { registerPluginScheme, createPlugins, parseManifest, API_VERSION };
