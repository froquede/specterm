import { For, onCleanup, onMount, Show } from "solid-js";
import { ICON_STROKE } from "../lib/icons";
import { IconArrowRight, IconPlugins } from "../lib/icons-lazy";
import { dismissPluginsAutoUpdated, pluginsAutoUpdated } from "../stores/plugins";

// What automatic updates installed in the background, said once: which plugins
// moved and from which version to which. They are already running the new
// code by then (see applyUpdate in electron/plugins.cjs), so the dialog only
// informs; OK, Escape or a click outside closes it.
export default function PluginsUpdatedDialog() {
  let ok!: HTMLButtonElement;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      dismissPluginsAutoUpdated();
    }
  };
  onMount(() => {
    window.addEventListener("keydown", onKey, true);
    ok.focus();
  });
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  return (
    <div
      class="plugins-updated-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) dismissPluginsAutoUpdated();
      }}
    >
      <div class="plugins-updated" role="dialog" aria-modal="true" aria-labelledby="plugins-updated-title">
        <div class="plugins-updated-head">
          <IconPlugins size={16} stroke-width={ICON_STROKE} />
          <h2 id="plugins-updated-title" class="plugins-updated-title">
            Some plugins updated to a new version
          </h2>
        </div>
        <ul class="plugins-updated-list">
          <For each={pluginsAutoUpdated() ?? []}>
            {(u) => (
              <li class="plugins-updated-item" data-plugin={u.id}>
                <span class="plugins-updated-name">{u.name}</span>
                <span class="plugins-updated-versions">
                  <Show when={u.from}>
                    {(from) => (
                      <>
                        <span>{from()}</span>
                        <IconArrowRight size={12} stroke-width={ICON_STROKE} />
                      </>
                    )}
                  </Show>
                  <span class="plugins-updated-to">{u.to}</span>
                </span>
              </li>
            )}
          </For>
        </ul>
        <div class="plugins-updated-actions">
          <button ref={ok} type="button" class="settings-action plugins-updated-ok" onClick={dismissPluginsAutoUpdated}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
