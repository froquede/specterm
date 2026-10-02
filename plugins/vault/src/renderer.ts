import type { PluginRendererApi } from "../../../src/stores/plugins";
import { addVault, attachStorage, isVault, onVaultsChanged, removeVault, setSelectedVault } from "./vaults";

// The Vault's renderer module: loaded in every window after its first paint,
// for the parts that work before the panel is ever opened — the folder menu's
// "Open as vault" and the offer over a folder Obsidian has opened. Kept small:
// the index, the panel and quick open load only when one of them opens.

export function activate(api: PluginRendererApi): () => void {
  const detach = attachStorage(api.storage);

  // Register a folder as a vault and show it in the panel.
  function openVault(path: string) {
    addVault(path);
    setSelectedVault(path);
    api.showView("vault");
  }

  const offAction = api.fileTree.addFolderAction({
    id: "toggle",
    title: (path) => (isVault(path) ? "Remove from vaults" : "Open as vault"),
    run: (path) => (isVault(path) ? removeVault(path) : openVault(path)),
  });

  // A folder Obsidian has opened carries a .obsidian directory. That's a
  // strong hint it is a vault here too, so the tree offers it — never adds it
  // on its own, since indexing a folder is something the user should choose.
  const offBanner = api.fileTree.addFolderBanner({
    id: "obsidian",
    match: (path, names) =>
      !isVault(path) && names.includes(".obsidian")
        ? { text: "Obsidian vault folder", action: "Open as vault" }
        : null,
    run: openVault,
  });

  // The menu's label and the offer both depend on the list.
  const offChanged = onVaultsChanged(() => api.fileTree.refresh());

  return () => {
    offChanged();
    offBanner();
    offAction();
    detach();
  };
}
