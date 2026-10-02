// The plugin host: a utilityProcess shared by every plugin's host module. See
// plugins.cjs for why it is not the main process.
//
// Each plugin gets a `ctx` and everything it registers through it is tracked, so
// turning a plugin off undoes it completely: handlers, timers and its own
// `onDispose` callbacks. A plugin that keeps something alive behind ctx's back
// (a raw setInterval, a socket) outlives its deactivation only until the last
// plugin goes off, when main kills this process.

const path = require("path");

const port = process.parentPort;

// id -> { mod, dir, handlers: Map, timers: Set, disposers: [] }
const plugins = new Map();

function post(msg) {
  port.postMessage(msg);
}

function reply(callId, ok, valueOrError) {
  if (ok) post({ type: "reply", callId, ok: true, value: valueOrError });
  else post({ type: "reply", callId, ok: false, error: String(valueOrError?.message ?? valueOrError) });
}

// Drop the plugin's modules from the require cache, so turning it off and on
// again (or updating it in place) loads the code that is on disk now.
function forget(dir) {
  const prefix = dir + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(prefix)) delete require.cache[key];
  }
}

function makeContext(id, storagePath, entry) {
  const track = (dispose) => {
    entry.disposers.push(dispose);
    return { dispose };
  };
  return {
    id,
    apiVersion: 1,
    storagePath,
    // A method the plugin's panel can call: `api.invoke(method, ...args)`.
    handle(method, fn) {
      if (typeof fn !== "function") throw new TypeError("handle(method, fn): fn must be a function");
      entry.handlers.set(method, fn);
      return track(() => entry.handlers.delete(method));
    },
    // Heard by every window's panel through `api.on(event, cb)`.
    emit(event, payload) {
      post({ type: "emit", id, event: String(event), payload });
    },
    // The count or dot on the plugin's tab-bar button, in every window.
    // A positive number, "dot", or null to clear it.
    setBadge(value) {
      post({ type: "badge", id, value });
    },
    openExternal(url) {
      post({ type: "open-external", id, url: String(url) });
    },
    setInterval(fn, ms) {
      const t = setInterval(fn, ms);
      entry.timers.add(t);
      return t;
    },
    setTimeout(fn, ms) {
      const t = setTimeout(() => {
        entry.timers.delete(t);
        fn();
      }, ms);
      entry.timers.add(t);
      return t;
    },
    clearTimer(t) {
      clearTimeout(t);
      clearInterval(t);
      entry.timers.delete(t);
    },
    onDispose(fn) {
      return track(fn);
    },
  };
}

async function deactivate(id) {
  const entry = plugins.get(id);
  if (!entry) return;
  plugins.delete(id);
  for (const t of entry.timers) {
    clearTimeout(t);
    clearInterval(t);
  }
  entry.timers.clear();
  try {
    await entry.mod?.deactivate?.();
  } catch (err) {
    console.error(`[plugin ${id}] deactivate threw:`, err);
  }
  for (const dispose of entry.disposers.reverse()) {
    try {
      dispose();
    } catch (err) {
      console.error(`[plugin ${id}] a disposer threw:`, err);
    }
  }
  entry.handlers.clear();
  forget(entry.dir);
}

async function activate({ id, file, dir, storagePath }) {
  await deactivate(id);
  const entry = { mod: null, dir, handlers: new Map(), timers: new Set(), disposers: [] };
  plugins.set(id, entry);
  forget(dir);
  entry.mod = require(file);
  if (typeof entry.mod?.activate !== "function") {
    throw new Error("the host module must export an activate(ctx) function");
  }
  await entry.mod.activate(makeContext(id, storagePath, entry));
}

port.on("message", async ({ data: msg }) => {
  if (!msg || typeof msg !== "object") return;
  try {
    switch (msg.type) {
      case "activate":
        await activate(msg);
        return reply(msg.callId, true, null);
      case "deactivate":
        await deactivate(msg.id);
        return reply(msg.callId, true, null);
      case "invoke": {
        const fn = plugins.get(msg.id)?.handlers.get(msg.method);
        if (!fn) throw new Error(`plugin "${msg.id}" has no method "${msg.method}"`);
        return reply(msg.callId, true, await fn(...msg.args));
      }
    }
  } catch (err) {
    reply(msg.callId, false, err);
  }
});

// A plugin's stray rejection must not take every other plugin down with it.
process.on("unhandledRejection", (err) => console.error("[plugin host] unhandled rejection:", err));
