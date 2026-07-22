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
      const decoded = decodeURIComponent(rest.slice(slash));
      if (decoded) onCwd(decoded);
    } catch (_) {
      // Malformed percent-encoding — ignore this report and keep the last
      // known cwd rather than storing a corrupted path.
    }
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
