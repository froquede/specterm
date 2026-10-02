// The Vault's host side: walking a vault for its notes and reading them in
// batches, run in Specterm's plugin host process. Moved from electron/main.cjs
// when the Vault became a built-in plugin.

const fs = require("fs");
const path = require("path");

const VAULT_MAX_FILES = 20000;
const VAULT_MD = /\.(md|markdown)$/i;

function activate(ctx) {
  // Every markdown file under a vault root, with the mtime the renderer uses to
  // re-read only what changed since its last look. One round trip for the whole
  // walk: asking per directory would cost the renderer one IPC per folder.
  //
  // Hidden entries (.git, .obsidian, …) and node_modules are skipped, and
  // symlinks are not followed — a link back up the tree would otherwise walk
  // forever. The cap keeps a vault opened at the wrong level (home, say) from
  // handing the renderer a list it has no use for; `truncated` says it happened.
  ctx.handle("list-markdown-files", async (root) => {
    const files = [];
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop();
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch (_) {
        continue; // unreadable folder: index the rest
      }
      const found = [];
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "node_modules") stack.push(full);
        } else if (e.isFile() && VAULT_MD.test(e.name)) {
          found.push(full);
        }
      }
      const stats = await Promise.all(
        found.map((p) => fs.promises.stat(p).then((s) => s, () => null))
      );
      for (let i = 0; i < found.length; i++) {
        if (!stats[i]) continue;
        if (files.length >= VAULT_MAX_FILES) return { files, truncated: true };
        files.push({ path: found[i], mtimeMs: stats[i].mtimeMs, size: stats[i].size });
      }
    }
    return { files, truncated: false };
  });

  // Several text files in one round trip, for building a vault's index. A file
  // over `maxBytes`, or one that can't be read, comes back as null rather than
  // failing the batch: the index lists it by name and skips its contents.
  ctx.handle("read-text-files", async (paths, maxBytes) => {
    const limit = Math.max(1, Number(maxBytes) || 0);
    const list = Array.isArray(paths) ? paths.slice(0, 1000) : [];
    return Promise.all(
      list.map(async (p) => {
        try {
          const { size } = await fs.promises.stat(p);
          if (size > limit) return null;
          return await fs.promises.readFile(p, "utf-8");
        } catch (_) {
          return null;
        }
      })
    );
  });

  // One note's text, for the outline of the note in the active pane, which
  // may live outside any vault.
  ctx.handle("read-text-file", (filePath) => fs.promises.readFile(String(filePath), "utf-8"));
}

module.exports = { activate };
