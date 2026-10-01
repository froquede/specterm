import { createSignal } from "solid-js";
import { normalize, equalPath } from "../lib/fspath";
import { getBackend } from "../backends";
import { buildNote, type Note } from "../lib/vault-index";
import { isVault, onVaultsRemoved } from "./vaults";

// The index of one vault, kept apart from the vault list (stores/vaults) so
// only the lazily loaded vault panel and quick open ever load it.
//
// One vault's index at a time, held only while something is using it. Each
// consumer (the panel, quick open) acquires it on mount and releases it on
// unmount; when nothing holds it the index is dropped after a short grace, so
// closing and reopening quick open doesn't re-read the vault, but a window that
// stopped using vaults doesn't keep every note in memory for the rest of its
// life.
//
// Building it is bounded: a file over MAX_FILE_BYTES is listed by name only,
// and once MAX_TOTAL_CHARS of text is held the remaining notes are too.

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_CHARS = 32 * 1024 * 1024;
const READ_BATCH = 200;
const RELEASE_AFTER_MS = 60_000;
// A refresh asked for within this long of the last one reuses it: opening the
// panel and quick open back to back shouldn't walk the vault twice.
const FRESH_MS = 2_000;

export interface VaultIndex {
  root: string;
  notes: Note[];
  // The host stopped listing at its cap.
  truncated: boolean;
  // Some notes are listed by name only (too big, or over the memory budget).
  partial: boolean;
}

const [index, setIndex] = createSignal<VaultIndex | null>(null);
const [indexing, setIndexing] = createSignal(false);
export { index as vaultIndex, indexing as vaultIndexing };

let holders = 0;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
// Bumped by every refresh and release, so a build that was overtaken (the
// vault switched, the index was dropped) discards its result instead of
// installing a stale one.
let generation = 0;
let lastRefreshAt = 0;
let lastRefreshRoot = "";

function releaseIndex() {
  generation++;
  setIndex(null);
  setIndexing(false);
  lastRefreshRoot = "";
}

/** Hold the index alive. Returns the matching release. */
export function acquireVaultIndex(): () => void {
  holders++;
  if (releaseTimer) {
    clearTimeout(releaseTimer);
    releaseTimer = null;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders = Math.max(0, holders - 1);
    if (holders === 0) {
      releaseTimer = setTimeout(() => {
        releaseTimer = null;
        if (holders === 0) releaseIndex();
      }, RELEASE_AFTER_MS);
    }
  };
}

/**
 * Bring the index for `root` up to date: list the vault, re-read only notes
 * whose mtime moved, drop the ones that are gone. Switching vaults replaces the
 * previous index outright.
 */
export async function refreshVaultIndex(root: string, force = false): Promise<void> {
  const prev = index();
  const sameRoot = prev !== null && equalPath(prev.root, root);
  if (
    !force &&
    sameRoot &&
    equalPath(lastRefreshRoot, root) &&
    Date.now() - lastRefreshAt < FRESH_MS
  ) {
    return;
  }
  const gen = ++generation;
  lastRefreshAt = Date.now();
  lastRefreshRoot = root;
  if (!sameRoot) setIndex(null);
  setIndexing(true);
  try {
    const backend = await getBackend();
    const listing = await backend.listMarkdownFiles(root);
    if (gen !== generation) return;

    const known = new Map<string, Note>();
    if (sameRoot && prev) for (const n of prev.notes) known.set(n.path, n);

    const notes: Note[] = [];
    const toRead: { path: string; mtimeMs: number; size: number }[] = [];
    for (const f of listing.files) {
      const old = known.get(normalize(f.path));
      if (old && old.mtimeMs === f.mtimeMs) notes.push(old);
      else toRead.push(f);
    }

    // Kept notes count against the budget first, so a refresh never evicts
    // text it already had in favour of a file that just appeared.
    let budget = MAX_TOTAL_CHARS;
    for (const n of notes) budget -= n.text?.length ?? 0;

    let partial = notes.some((n) => n.text === null);
    for (let i = 0; i < toRead.length; i += READ_BATCH) {
      const batch = toRead.slice(i, i + READ_BATCH);
      const affordable = budget > 0;
      const texts = affordable
        ? await backend.readTextFiles(
            batch.map((f) => f.path),
            MAX_FILE_BYTES
          )
        : batch.map(() => null);
      if (gen !== generation) return;
      for (let j = 0; j < batch.length; j++) {
        let text = texts[j] ?? null;
        if (text !== null && text.length > budget) text = null;
        if (text === null) partial = true;
        else budget -= text.length;
        notes.push(buildNote(root, batch[j].path, batch[j].mtimeMs, text));
      }
    }

    setIndex({ root: normalize(root), notes, truncated: listing.truncated, partial });
  } catch (err) {
    if (gen === generation) {
      console.warn("[vault] indexing failed:", err);
      setIndex({ root: normalize(root), notes: [], truncated: false, partial: true });
    }
  } finally {
    if (gen === generation) setIndexing(false);
  }
}

// A vault removed here or in another window takes its index with it.
onVaultsRemoved(() => {
  const idx = index();
  if (idx && !isVault(idx.root)) releaseIndex();
});
