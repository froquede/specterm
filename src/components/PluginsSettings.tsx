import { createSignal, For, onMount, Show } from "solid-js";
import type { PluginInfo } from "../backends/types";
import {
  installPlugin,
  loadPluginList,
  pluginList,
  removePlugin,
  setPluginEnabled,
} from "../stores/plugins";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(
  // Electron prefixes what a main-process handler threw with where it came from.
  /^Error invoking remote method '[^']+': (?:Error: )?/,
  ""
);

// Settings > Plugins: what is installed, the switch for each, and the field
// that adds one from its git URL.
//
// Built-in plugins ship with the app and are on by default; external ones are
// everyone else's code, so they are listed apart and the hint under them says
// plainly what turning one on means. Adding a plugin from its URL is the user
// opting in, so it is on once it is added.
export default function PluginsSettings() {
  const [busy, setBusy] = createSignal<string | null>(null);
  const [failure, setFailure] = createSignal<{ id: string; message: string } | null>(null);
  const [confirming, setConfirming] = createSignal<string | null>(null);

  const [source, setSource] = createSignal("");
  const [installing, setInstalling] = createSignal(false);
  const [installError, setInstallError] = createSignal<string | null>(null);
  const [added, setAdded] = createSignal<string | null>(null);

  onMount(() => void loadPluginList());

  const builtIn = () => (pluginList() ?? []).filter((p) => p.builtIn);
  const external = () => (pluginList() ?? []).filter((p) => !p.builtIn);

  async function toggle(id: string, enabled: boolean) {
    setBusy(id);
    setFailure(null);
    try {
      await setPluginEnabled(id, enabled);
    } catch (err) {
      setFailure({ id, message: message(err) });
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setConfirming(null);
    setBusy(id);
    setFailure(null);
    try {
      await removePlugin(id);
    } catch (err) {
      setFailure({ id, message: message(err) });
    } finally {
      setBusy(null);
    }
  }

  async function add(e: SubmitEvent) {
    e.preventDefault();
    const url = source().trim();
    if (!url || installing()) return;
    setInstalling(true);
    setInstallError(null);
    setAdded(null);
    try {
      const id = await installPlugin(url);
      setSource("");
      setAdded(pluginList()?.find((p) => p.id === id)?.name ?? id);
    } catch (err) {
      setInstallError(message(err));
    } finally {
      setInstalling(false);
    }
  }

  const Item = (props: { plugin: PluginInfo }) => {
    const plugin = () => props.plugin;
    return (
      <div class="plugins-settings-item" data-plugin={plugin().id}>
        <div class="settings-row">
          <label class="settings-label" for={`plugin-${plugin().id}`}>
            {plugin().name}
            <Show when={plugin().version}>
              <span class="plugins-settings-version"> {plugin().version}</span>
            </Show>
          </label>
          <input
            id={`plugin-${plugin().id}`}
            type="checkbox"
            class="settings-checkbox"
            checked={plugin().enabled}
            disabled={busy() !== null || (!plugin().enabled && plugin().error !== null)}
            onChange={(e) => void toggle(plugin().id, e.currentTarget.checked)}
          />
        </div>
        <Show when={plugin().installed}>
          {(installed) => (
            <div class="plugins-settings-source">
              <span class="plugins-settings-source-url" title={installed().source}>
                {installed().source}
                <Show when={!installed().ref}>
                  <span> @ {installed().commit.slice(0, 7)}</span>
                </Show>
              </span>
              <Show
                when={confirming() === plugin().id}
                fallback={
                  <button
                    type="button"
                    class="settings-reset plugins-settings-remove"
                    disabled={busy() !== null}
                    onClick={() => setConfirming(plugin().id)}
                  >
                    Remove
                  </button>
                }
              >
                <span class="plugins-settings-confirm">
                  <button
                    type="button"
                    class="settings-reset plugins-settings-remove-confirm"
                    onClick={() => void remove(plugin().id)}
                  >
                    Delete it
                  </button>
                  <button type="button" class="settings-reset" onClick={() => setConfirming(null)}>
                    Keep
                  </button>
                </span>
              </Show>
            </div>
          )}
        </Show>
        <Show when={plugin().error ?? (failure()?.id === plugin().id ? failure()!.message : null)}>
          {(text) => <div class="settings-error">{text()}</div>}
        </Show>
      </div>
    );
  };

  return (
    <div class="settings-section plugins-settings">
      <Show when={builtIn().length > 0}>
        <section class="plugins-settings-group" data-group="built-in">
          <h3 class="plugins-settings-group-title">Built in</h3>
          <For each={builtIn()}>{(plugin) => <Item plugin={plugin} />}</For>
          <p class="settings-hint">Ship with Specterm and are on unless you turn them off.</p>
        </section>
      </Show>

      <section class="plugins-settings-group" data-group="external">
        <h3 class="plugins-settings-group-title">External</h3>
        <Show
          when={external().length > 0}
          fallback={<p class="settings-hint plugins-settings-empty">No external plugins yet.</p>}
        >
          <For each={external()}>{(plugin) => <Item plugin={plugin} />}</For>
        </Show>

        <form class="plugins-settings-add" onSubmit={(e) => void add(e)}>
          <label class="settings-label" for="plugins-settings-add-url">
            Add from a URL
          </label>
          <div class="plugins-settings-add-row">
            <input
              id="plugins-settings-add-url"
              class="settings-search plugins-settings-add-input"
              type="text"
              placeholder="Git repository URL"
              spellcheck={false}
              autocomplete="off"
              value={source()}
              disabled={installing()}
              onInput={(e) => {
                setSource(e.currentTarget.value);
                setInstallError(null);
                setAdded(null);
              }}
            />
            <button
              type="submit"
              class="settings-action plugins-settings-add-button"
              disabled={installing() || !source().trim()}
            >
              {installing() ? "Adding…" : "Add"}
            </button>
          </div>
          <Show when={installError()}>
            {(text) => <div class="settings-error plugins-settings-add-error">{text()}</div>}
          </Show>
          <Show when={added()}>
            {(name) => <p class="settings-hint plugins-settings-added">Added {name()} and turned it on.</p>}
          </Show>
          <p class="settings-hint">
            Installs the newest release. Add <code>#tag</code> to pick one, or paste a folder link
            (<code>…/tree/&lt;tag&gt;/&lt;folder&gt;</code>).
          </p>
        </form>

        <p class="settings-hint">
          External plugins get the same access to your files, network and terminals as Specterm.
          Add only ones you trust.
        </p>
      </section>
    </div>
  );
}
