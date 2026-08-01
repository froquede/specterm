import type { Terminal } from "@xterm/xterm";
import { getBackend } from "../backends";

// Hosts an OSC 7 report may name and still mean "this machine". Shells send the
// real hostname far more often than they send `localhost` — zsh's default is
// `%m`, the short hostname — so without the machine's own name here, every
// genuine report would be discarded as remote. Resolved once at startup; until
// it lands only the unambiguous forms are accepted, which costs nothing because
// the cwd is also read from the shell process (see terminal-registry).
const localHosts = new Set(["", "localhost"]);

getBackend()
  .then((backend) => backend.getHostname())
  .then((host) => {
    const name = host.trim().toLowerCase();
    if (!name) return;
    localHosts.add(name);
    // os.hostname() can be the FQDN while the shell sends only the first label.
    localHosts.add(name.split(".")[0]);
  })
  .catch(() => {
    /* Hostname unavailable — the local-only forms above still work. */
  });

export interface OscOpenMarkdown {
  path: string;
  mode: "split" | "tab";
}

// OSC 7 — the shell reporting its working directory, as `file://<host>/<path>`.
// zsh and fish emit it out of the box and most prompt frameworks (starship,
// oh-my-posh) add it; a plain bash usually does not, which is why the live cwd
// is also read from the shell process itself (see the `pty-cwd` handler in
// electron/main.cjs). This path is the cheap one when it's available: it
// arrives the moment the directory changes, with no IPC and no OS lookup.
//
// The payload is a URL, so the path is percent-encoded — a directory with a
// space arrives as `%20`. Anything we can't decode or that names another host
// is dropped rather than guessed at: a remote path from an ssh session doesn't
// exist locally, and opening a new pane there would just fail.
export function registerCwdHandler(
  term: Terminal,
  onCwd: (cwd: string) => void
): void {
  term.parser.registerOscHandler(7, (data: string) => {
    if (!data.startsWith("file://")) return false;

    // file://host/path — the first slash after the host begins the path.
    const rest = data.slice("file://".length);
    const slash = rest.indexOf("/");
    if (slash === -1) return false;

    // A host we don't recognise means the shell is somewhere else (ssh), where
    // the path names a directory on that machine and opening a local pane in it
    // would be wrong. Drop the report and keep the locally-read cwd.
    const host = rest.slice(0, slash).toLowerCase();
    if (!localHosts.has(host)) return true;

    try {
      // A Windows file URI is file:///C:/path — empty host, and the path keeps a
      // leading slash before the drive letter (/C:/...). Strip that slash so the
      // value is a real Windows path node can spawn in; POSIX paths (/home/...)
      // have no drive colon and are left untouched.
      const decoded = decodeURIComponent(rest.slice(slash)).replace(
        /^\/([A-Za-z]:)/,
        "$1"
      );
      if (decoded) onCwd(decoded);
    } catch (_) {
      // Malformed percent-encoding — ignore this report and keep the last
      // known cwd rather than storing a corrupted path.
    }
    return true;
  });
}

// OSC 1337 ; Attention ; kind=<permission|idle> — a program in the pane saying
// it has stopped and is waiting on the user.
//
// Written by the Claude Code hooks the Settings panel installs (see
// lib/claude-hooks.ts): the hook process is a child of `claude`, so its
// controlling terminal is this pane's pty and the sequence arrives here and
// nowhere else — which is what makes the answer per-pane without anything
// having to be correlated after the fact.
//
// Registered independently of the OpenMD handler above. xterm keeps a stack of
// handlers per OSC identifier and tries them newest-first until one returns
// true, so each ignores (returns false for) payloads that aren't its own.
export function registerAttentionHandler(
  term: Terminal,
  onAttention: (kind: "permission" | "idle") => void
): void {
  term.parser.registerOscHandler(1337, (data: string) => {
    if (!data.startsWith("Attention;")) return false;

    const params: Record<string, string> = {};
    for (const part of data.split(";").slice(1)) {
      const eqIdx = part.indexOf("=");
      if (eqIdx > 0) params[part.slice(0, eqIdx)] = part.slice(eqIdx + 1);
    }

    // An unknown or missing kind still means "look at me" — the sequence was
    // addressed to us, so it's handled either way; only the emphasis differs.
    onAttention(params.kind === "permission" ? "permission" : "idle");
    return true;
  });
}

// --- Desktop notifications (OSC 9 / 777 / 99) -------------------------------
//
// The three sequences a program already uses to say "look at me" with something
// to say. Unlike the private OSC above, nothing has to be installed for these:
// they are what agents and long-running tools emit out of the box, so Codex,
// OpenCode, aider and a `make` wrapper all land here with no setup at all.
//
// Registering them costs nothing on the output hot path. xterm's parser is
// already scanning for `ESC ]` and dispatching on the numeric identifier; three
// more entries in that map are three dictionary inserts at pane creation, and
// the handlers only ever run when one of these sequences actually arrives.

// What a notification may contribute to the UI. Long enough for a real sentence,
// short enough that a program can't push a novel into a tooltip.
const NOTIFY_MAX_LEN = 200;

// OSC 99 arrives in chunks, so partial notifications have to be held. Both caps
// exist so a program that opens chunks and never closes them can't grow this
// without bound — it drops the oldest instead.
const NOTIFY_MAX_PENDING = 8;
const NOTIFY_MAX_ACCUM = 512;

/** Collapse whitespace and clamp — terminal payloads are arbitrary bytes. */
function tidyNotification(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > NOTIFY_MAX_LEN
    ? `${flat.slice(0, NOTIFY_MAX_LEN - 1)}…`
    : flat;
}

/** Join a title and body into the single line the tooltip shows. */
function joinNotification(title: string, body: string): string {
  const t = title.trim();
  const b = body.trim();
  if (t && b) return tidyNotification(`${t} — ${b}`);
  return tidyNotification(t || b);
}

// Kitty allows `e=1`, meaning the payload is base64-encoded UTF-8. Decoded via
// TextDecoder rather than atob alone: atob yields one char per *byte*, so any
// non-ASCII text would arrive mojibaked.
function decodeNotificationPayload(raw: string, encoded: boolean): string {
  if (!encoded) return raw;
  try {
    const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch (_) {
    // Malformed base64 — drop the chunk rather than showing its raw form.
    return "";
  }
}

/**
 * The standard "notify the user" sequences, in all three spellings.
 *
 *   OSC 9  ; <message>                    iTerm2's, and the most widely emitted.
 *   OSC 777; notify ; <title> ; <body>    urxvt's, carried on by many terminals.
 *   OSC 99 ; <metadata> ; <payload>       Kitty's, chunked and optionally base64.
 *
 * `onNotify` gets one tidied line. Every handler returns false for a payload it
 * doesn't own so the handler stack (see registerAttentionHandler above) keeps
 * working — xterm tries handlers for an identifier newest-first until one
 * returns true.
 */
export function registerNotificationHandler(
  term: Terminal,
  onNotify: (text: string) => void
): void {
  // OSC 9 — `9;<message>`.
  //
  // The trap: ConEmu overloaded this same identifier with a set of numbered
  // sub-commands, and `9;4;<state>;<progress>` is a *progress bar* that tools
  // emit continuously while they work. Treating those as notifications would
  // fire one per progress tick. Anything shaped like `<digits>;` is therefore a
  // ConEmu control rather than a message and is declined. A genuine message
  // that merely starts with a digit ("3 tests failed") has a space, not a
  // semicolon, after it, so it still gets through.
  term.parser.registerOscHandler(9, (data: string) => {
    if (/^\d+(;|$)/.test(data)) return true; // ConEmu sub-command; swallow, don't notify.
    const text = tidyNotification(data);
    if (text) onNotify(text);
    return true;
  });

  // OSC 777 — `777;notify;<title>;<body>`. Only the `notify` sub-command is
  // ours; urxvt defines others. The body may itself contain semicolons, so it
  // is everything after the title rather than a single field.
  term.parser.registerOscHandler(777, (data: string) => {
    const parts = data.split(";");
    if (parts[0] !== "notify") return false;
    const text = joinNotification(parts[1] ?? "", parts.slice(2).join(";"));
    if (text) onNotify(text);
    return true;
  });

  // OSC 99 — Kitty's protocol. `99;<k=v:k=v>;<payload>`, where a notification
  // may be split across several sequences sharing an `i=` identifier: `d=0`
  // means more is coming, `d=1` (the default) closes it. `p=` says whether the
  // payload is the title or the body.
  //
  // The pending map is closed over per terminal, so it is dropped when the
  // terminal is — there is nothing to unregister and nothing to leak.
  const pending = new Map<string, { title: string; body: string }>();

  term.parser.registerOscHandler(99, (data: string) => {
    const sep = data.indexOf(";");
    const meta = sep === -1 ? data : data.slice(0, sep);
    const payload = sep === -1 ? "" : data.slice(sep + 1);

    const params: Record<string, string> = {};
    for (const pair of meta.split(":")) {
      const eq = pair.indexOf("=");
      if (eq > 0) params[pair.slice(0, eq)] = pair.slice(eq + 1);
    }

    // `close`, `alive` and the `?` capability query are protocol traffic, not
    // something to show. Swallow them — we deliberately don't answer the query,
    // and a program that gets no reply simply doesn't use the protocol.
    const kind = params.p ?? "title";
    if (kind !== "title" && kind !== "body") return true;

    const id = params.i ?? "";
    let entry = pending.get(id);
    if (!entry) {
      // Oldest-out rather than unbounded growth. Map iterates in insertion
      // order, so the first key is the least recently started.
      if (pending.size >= NOTIFY_MAX_PENDING) {
        const oldest = pending.keys().next().value;
        if (oldest !== undefined) pending.delete(oldest);
      }
      entry = { title: "", body: "" };
      pending.set(id, entry);
    }

    const chunk = decodeNotificationPayload(payload, params.e === "1");
    entry[kind] = (entry[kind] + chunk).slice(0, NOTIFY_MAX_ACCUM);

    // `d=0` means the program has more to send under this id.
    if (params.d === "0") return true;

    pending.delete(id);
    const text = joinNotification(entry.title, entry.body);
    if (text) onNotify(text);
    return true;
  });
}

export function registerOscHandler(
  term: Terminal,
  onOpenMarkdown: (params: OscOpenMarkdown) => void
): void {
  term.parser.registerOscHandler(1337, (data: string) => {
    if (!data.startsWith("OpenMD;")) return false;

    const params: Record<string, string> = {};
    const parts = data.split(";").slice(1);
    for (const part of parts) {
      const eqIdx = part.indexOf("=");
      if (eqIdx > 0) {
        params[part.slice(0, eqIdx)] = part.slice(eqIdx + 1);
      }
    }

    if (params.path) {
      onOpenMarkdown({
        path: params.path,
        mode: (params.mode as "split" | "tab") || "split",
      });
      return true;
    }

    return false;
  });
}
