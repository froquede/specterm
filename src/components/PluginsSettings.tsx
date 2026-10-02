import { createSignal, For, onMount, Show } from "solid-js";
import { loadPluginList, pluginList, setPluginEnabled } from "../stores/plugins";

// Settings > Plugins: what is installed, and the switch for each.
//
// A plugin found on disk starts off. Turning one on runs its code with the same
// access the app has, so the hint says so plainly rather than burying it.
export default function PluginsSettings() {
  const [busy, setBusy] = createSignal<string | null>(null);
  const [failure, setFailure] = createSignal<{ id: string; message: string } | null>(null);

  onMount(() => void loadPluginList());

  async function toggle(id: string, enabled: boolean) {
    setBusy(id);
    setFailure(null);
    try {
      await setPluginEnabled(id, enabled);
    } catch (err) {
      setFailure({ id, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div class="settings-section plugins-settings">
      <Show
        when={(pluginList() ?? []).length > 0}
        fallback={
          <p class="settings-hint">
            No plugins installed. A plugin is a folder in the <code>plugins</code> folder of
            Specterm's data directory.
          </p>
        }
      >
        <For each={pluginList() ?? []}>
          {(plugin) => (
            <div class="plugins-settings-item" data-plugin={plugin.id}>
              <div class="settings-row">
                <label class="settings-label" for={`plugin-${plugin.id}`}>
                  {plugin.name}
                  <Show when={plugin.version}>
                    <span class="plugins-settings-version"> {plugin.version}</span>
                  </Show>
                </label>
                <input
                  id={`plugin-${plugin.id}`}
                  type="checkbox"
                  class="settings-checkbox"
                  checked={plugin.enabled}
                  disabled={busy() !== null || (!plugin.enabled && plugin.error !== null)}
                  onChange={(e) => void toggle(plugin.id, e.currentTarget.checked)}
                />
              </div>
              <Show when={plugin.error ?? (failure()?.id === plugin.id ? failure()!.message : null)}>
                {(message) => <div class="settings-error">{message()}</div>}
              </Show>
            </div>
          )}
        </For>
        <p class="settings-hint">
          A plugin runs with the same access to your files, network and terminals as Specterm
          itself. Turn on only plugins you trust.
        </p>
      </Show>
    </div>
  );
}
