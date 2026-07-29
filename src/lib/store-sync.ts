// Keeping every window's copy of the persisted stores in agreement.
//
// Settings, theme and favorites live in localStorage, but each window holds them
// in its own signals — so without this, changing the theme in one window would
// leave the others on the old one until the next launch. The writer persists as
// it always did and then says which store moved; every other window re-reads
// that one from storage.
//
// Stores register their own reload here rather than being imported by name, so
// this module stays free of cycles with the stores that call into it.
import { getBackend, type UnlistenFn } from "../backends";

const CHANNEL = "store-changed";

type Reload = () => void;

const reloaders = new Map<string, Reload>();

// Set while applying a change that came from another window, so a reload can
// never bounce back out as a fresh broadcast.
let applying = false;

let unlisten: UnlistenFn | null = null;

export function registerStoreSync(name: string, reload: Reload) {
  reloaders.set(name, reload);
}

/** Tell the other windows that `name` was just written to storage. */
export function publishStoreChange(name: string) {
  if (applying) return;
  void getBackend()
    .then((backend) => backend.broadcast(CHANNEL, name))
    .catch(() => {
      /* single-window backend, or host bridge gone — nothing to sync with. */
    });
}

/** Start listening for other windows' writes. Safe to call more than once. */
export async function initStoreSync() {
  if (unlisten) return;
  const backend = await getBackend();
  unlisten = await backend.onBroadcast((channel, payload) => {
    if (channel !== CHANNEL) return;
    const reload = reloaders.get(String(payload));
    if (!reload) return;
    applying = true;
    try {
      reload();
    } finally {
      applying = false;
    }
  });
}
