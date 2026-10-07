import { createSignal, For, onMount, Show } from "solid-js";
import type { PluginInfo } from "../backends/types";
import {
  checkPluginUpdates,
  installPlugin,
  loadPluginAutoUpdate,
  loadPluginList,
  pluginList,
  removePlugin,
  setPluginAutoUpdate,
  setPluginEnabled,
  updatePlugin,
} from "../stores/plugins";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(
  // Electron prefixes what a main-process handler threw with where it came from.
  /^Error invoking remote method '[^']+': (?:Error: )?/,
  ""
);

// Settings > Plugins: what is installed, the switch for each, the field that
// adds one from its git URL, and the updates for the ones added that way.
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

  const [checking, setChecking] = createSignal(false);
  // Set by a check from the button that found nothing, until the next one.
  const [upToDate, setUpToDate] = createSignal(false);
  const [updating, setUpdating] = createSignal<string | null>(null);
  // id -> the version it moved to, from the button or the check above.
  const [updated, setUpdated] = createSignal<Record<string, string>>({});
  const [autoUpdate, setAutoUpdate] = createSignal(true);

  onMount(() => {
    void loadPluginList();
    void loadPluginAutoUpdate().then(setAutoUpdate);
  });

  const builtIn = () => (pluginList() ?? []).filter((p) => p.builtIn);
  const external = () => (pluginList() ?? []).filter((p) => !p.builtIn);
  const updatable = () => external().some((p) => p.installed);

  async function checkUpdates() {
    setChecking(true);
    setUpToDate(false);
    setUpdated({});
    setFailure(null);
    try {
      const installed = await checkPluginUpdates();
      setUpdated(Object.fromEntries(installed.map((u) => [u.id, u.to])));
      setUpToDate(installed.length === 0 && !external().some((p) => p.update || p.updateError));
    } catch (err) {
      // Per-plugin failures come back in the list; this is the call itself.
      console.error("[plugins] update check failed:", message(err));
    } finally {
      setChecking(false);
    }
  }

  async function update(id: string) {
    setBusy(id);
    setUpdating(id);
    setFailure(null);
    setUpdated({});
    setUpToDate(false);
    try {
      const version = await updatePlugin(id);
      setUpdated({ [id]: version });
    } catch (err) {
      setFailure({ id, message: message(err) });
    } finally {
      setUpdating(null);
      setBusy(null);
    }
  }

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
        <Show when={plugin().update}>
          {(next) => (
            <div class="plugins-settings-update">
              <span class="plugins-settings-update-text">
                {next().version} is available
              </span>
              <button
                type="button"
                class="settings-action plugins-settings-update-button"
                disabled={busy() !== null}
                onClick={() => void update(plugin().id)}
              >
                {updating() === plugin().id ? "Updating…" : `Update to ${next().version}`}
              </button>
            </div>
          )}
        </Show>
        <Show when={updated()[plugin().id]}>
          {(version) => (
            <p class="settings-hint plugins-settings-updated">Updated to {version()} and reloaded.</p>
          )}
        </Show>
        <Show
          when={
            plugin().error ??
            (failure()?.id === plugin().id ? failure()!.message : null) ??
            plugin().updateError
          }
        >
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

        <Show when={updatable()}>
          <div class="plugins-settings-check">
            <button
              type="button"
              class="settings-reset plugins-settings-check-button"
              disabled={checking() || busy() !== null}
              onClick={() => void checkUpdates()}
            >
              {checking() ? "Checking…" : "Check for updates"}
            </button>
            <Show when={upToDate()}>
              <span class="plugins-settings-up-to-date">All up to date</span>
            </Show>
          </div>
          <div class="settings-row plugins-settings-auto">
            <label class="settings-label" for="plugins-settings-auto-update">
              Update automatically
            </label>
            <input
              id="plugins-settings-auto-update"
              type="checkbox"
              class="settings-checkbox"
              checked={autoUpdate()}
              onChange={(e) => {
                const on = e.currentTarget.checked;
                setAutoUpdate(on);
                void setPluginAutoUpdate(on).then(setAutoUpdate);
              }}
            />
          </div>
          <p class="settings-hint">
            New minor and patch releases install by themselves, at launch and every 6 hours, and
            a dialog says which. A new major version waits for you. Anyone who can tag a release
            in a plugin's repository can then run new code here.
          </p>
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
