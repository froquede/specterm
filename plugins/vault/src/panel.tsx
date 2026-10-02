import { createSignal, onCleanup } from "solid-js";
import { render } from "solid-js/web";
import type { PluginPanelApi } from "../../../src/components/PluginView";
import { setNoteStructure } from "./vault-index";
import { attachStorage } from "./vaults";
import { VaultPanel } from "./vault-panel";
import { QuickOpen } from "./quick-open";
import "./vault.css";

// The Vault's panel module: the sidebar view ("vault") and quick open (the
// "quick-open" overlay), told apart by the id Specterm mounts them with.

export function mount(el: HTMLElement, api: PluginPanelApi): () => void {
  setNoteStructure(api.noteStructure);
  const detach = attachStorage(api.storage);
  const dispose = render(() => {
    const [activeFile, setActiveFile] = createSignal<string | null>(null);
    onCleanup(api.onActiveFile(setActiveFile));
    return api.viewId === "quick-open" ? (
      <QuickOpen api={api} activeFile={activeFile} />
    ) : (
      <VaultPanel api={api} activeFile={activeFile} />
    );
  }, el);
  return () => {
    dispose();
    detach();
  };
}
