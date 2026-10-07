# Plugin architecture (draft)

## Recommendation

There is one plugin contract with two kinds of plugin:

- **Bundled plugins** live in this repo, ship inside the app and are on by default. They are for features anyone can use (GitHub, Vault) that should still stay out of the core's boot path and wiring.
- **External plugins** are git repos cloned into `~/.config/specterm/plugins/<id>/` (see Distribution). They start disabled until the user turns them on in Settings. They are for features tied to one company or service, like the Sprint Platform inbox in PR #84.

Every plugin has:

- a **manifest** declaring what it adds to the UI,
- an optional **host module**, which runs in a separate plugin-host process and never in the main process,
- a **panel module**, which runs in the renderer and mounts into an element the core gives it.

The core uses the same contract for both kinds. A bundled plugin that needs to reach around the contract is a sign the contract is missing something.

## Why: what PR #84 and the Vault had to touch

PR #84 (the inbox) edited 12 core files. Commit `1efdced` (the Vault) edited 18. Each of those edits is a point the core should offer through a contract:

| Need | Who needed it | Contract |
|---|---|---|
| Background work (polling, network, file access) | Inbox (`inbox.cjs`), Vault (`list-markdown-files`, `read-text-files`) | `host.activate(ctx)` in the plugin-host process. `ctx` exposes `handle(method, fn)`, `emit(event, payload)`, `openExternal(url)` (relayed to main), `storagePath` and `onDispose(fn)`. |
| Renderer-to-host calls | Inbox (9 preload methods, 9 `ElectronBackend` methods), Vault (2 of each) | One fixed bridge: `plugin.invoke(id, method, args)` and `plugin.onEvent(id, cb)`. Main relays between the renderer and the plugin host. The preload never changes for a plugin again. |
| Sidebar view | Both: `SidebarView` union, `VALID` list, `<Show>` and lazy import in `App.tsx`, a toggle function | Manifest `sidebarViews: [{ id, title, icon }]`. The core owns the slot and calls `mount(el, api)`, which returns `dispose`. |
| Tab bar button and badge | Both | Manifest `tabBarButton: { view, icon, title }`. The badge comes from the host (`ctx.setBadge(count \| "dot" \| null)`), so every window shows the same value without any panel code loaded. |
| Rebindable shortcut | Both: `KeymapContext` field, `createKeymap` parameter | Manifest `commands: [{ id, title, key, shift, toggleView \| invoke }]`. Declarative, so they work from the first frame without loading plugin code. Registered through `registerBindings` after the core rows (the first match wins, so a plugin cannot take a core chord), with ids `plugin.<id>.<command>`, which makes them rebindable in Settings like any other row. |
| Toast anchored to the button | Inbox | `api.toast({ title, body, onClick })`. The placement code in #84 moves into core once. |
| Icon | Both | The manifest names an icon from a fixed list (`src/lib/plugin-icons.ts`). An unknown name falls back to `plug`. The "no glyphs" rule in `CLAUDE.md` still holds. |
| Styles | Inbox (`inbox-panel.css`), Vault (`vault.css`, `file-tree.css`) | The plugin's CSS is injected on mount and removed on dispose, using the core's theme variables. |
| File-tree folder menu item and folder banner | Vault ("Open as vault", the `.obsidian/` hint in `FileTree.tsx`) | Manifest `fileTree.folderActions: [{ id, title, when }]` and `fileTree.folderBanner`. `when` is evaluated by the plugin against the path; the core only renders. |
| Modal palette | Vault (`QuickOpen.tsx`) | `api.showPalette(provider)`, where the provider returns items for a query. Quick open becomes a core palette with a Vault provider. |
| Active file and opening files | Vault (`activeFile`, `onOpenFile(path, "split" \| "tab")`) | `api.activeFile()` (a subscription) and `api.openFile(path, mode)`. |
| Markdown structure | Vault (`noteStructure` in `src/lib/markdown.ts`, kept on the same markdown-it instance as the preview so outline entry N is preview heading N) | `api.markdown.structure(text)` from the core, so a plugin never parses with a different parser than the preview renders with. |
| Scrolling the preview | Vault (`querySelectorAll("h1, …")[i].scrollIntoView()` on the core's DOM) | `api.revealHeading(paneId, index)`. Plugins never query the core's DOM. |
| Settings and persisted state | Neither yet | A Plugins section in Settings, and `api.storage` namespaced per plugin, synced across windows through `registerStoreSync` and `publishStoreChange`. |

## Pillars

**Performance.** `node-pty` runs in the main process (`main.cjs:20`, `pty.spawn` at `main.cjs:1137`), so every byte of every terminal goes through the main event loop. Plugin host code in that process, as #84 does with `registerInbox`, means any slow synchronous work in a plugin (a big `JSON.parse`, a sync directory walk) stalls every terminal in every window. Host modules therefore run in **one shared `utilityProcess`**. It starts lazily when the first plugin with a host module activates, and it stops when the last one is disabled. It also contains crashes: a plugin that throws takes down the plugin host, not the app. There is no hook into the pty output path in v1.

**Instant to open.** Nothing from a plugin is on the path to the first shell:
- the plugin host starts after `ready-to-show`;
- panel code is a dynamic import on first open, as with `GithubPanel` and `VaultPanel` today.

To avoid the tab bar jumping when plugin buttons arrive later, main keeps a small cache of the enabled plugins' static contributions (buttons, views, commands). It stamps that cache into the launch arguments, as it already does for the window kind (`additionalArguments: [boot.arg]`). So the buttons render in the first frame and their code loads later. The gate is `test/perf-boot.mjs` with fixture plugins enabled. I have not measured this yet.

**No leaks.**
- On the host side, killing the plugin host when the last plugin is disabled bounds anything a plugin forgot to clean up.
- On the renderer side, every registration (binding, listener, injected CSS, mounted view, palette provider) goes into a per-plugin disposal bag that the core empties on disable.
- The fixture e2e checks that listener counts return to baseline after a disable.

**Reuse the existing architecture.** Shortcuts use `registerBindings`, state sync uses `registerStoreSync` and `publishStoreChange`, panels follow the lazy-panel pattern, the boot cache follows the launch-argument pattern, and the bridge is one method pair on `Backend`.

**No regressions.** Moving GitHub and Vault onto the contract must keep `test/e2e-vault.mjs`, `test/vault-index.mjs` and the GitHub e2e coverage passing unchanged. They are the proof that the move did not change behaviour.

## Rendering

The core never hands its Solid instance to plugins. A plugin gets an element and an `api` object, and it renders however it likes. Sharing the core's Solid would tie every external plugin to the core's exact version. Bundled plugins are built with the app, so they can share Solid at no cost.

## Versioning

The manifest declares `engines.specterm: "^1"`. The core refuses to enable a plugin whose major version does not match, and says why in Settings. This applies to external plugins only, since bundled plugins are versioned with the app.

## Trust

The host module has full Node access, and the panel runs in the same renderer as the terminals, so it can read what is on screen. v1 does not pretend otherwise. External plugins are opt-in per install, and the Settings toggle says what turning one on means. Isolating panels in an iframe is possible later, but it is not part of v1.

## Distribution

An external plugin is a plain git repo with the manifest at its root. There is no registry. This has three advantages:
- **Private plugins work with no extra setup.** Cloning uses the user's own git credentials, so a private repo like the inbox needs no token handling in Specterm. Background update checks (`git ls-remote --tags`) run with `GIT_TERMINAL_PROMPT=0`. Without credentials, the check fails silently and is reported in Settings; it never opens a prompt.
- **No service to run.** There is nothing for us to host.
- **The model is already familiar.** Claude Code plugin marketplaces work the same way.

Three rules keep it safe and fast:

- **Pin to a tag, never a branch.** The install records the tag and its commit hash. Updating means moving to a newer tag, which the user sees and accepts. Following `main` would mean anyone with push access to the plugin repo runs code on every user's machine the next time the app starts.
- **Release tags carry the built output.** The install is a clone and nothing else: no `npm install` and no build on the user's machine. That avoids needing a Node toolchain, avoids running dependency lifecycle scripts at install time, and keeps install time predictable.
- **A plugin can live in a subfolder of a larger repo.** The install takes a path inside the repo, and the plugin's tags carry a prefix (`<plugin-id>-v<semver>`) so they never collide with the host repo's own tags. Update checks look only at tags with that prefix. The inbox lives at `apps/specterm-inbox` in `nexfar/nf-sprint-planner`, next to `apps/mcp`, which is already a client of the same messages API. That way an API change and the matching client change go in the same PR.

## Updates

Bundled plugins update with the app. External plugins added from Settings update themselves (`electron/plugins.cjs`, "updates"):

- **Checking.** The first check runs a minute after start (after the first window has painted) and then every 6 hours; "Check for updates" in Settings > Plugins runs one on demand. It runs `git ls-remote --tags` once per plugin repo (several plugins in one repo share the call), with `GIT_TERMINAL_PROMPT=0`, so a check never opens a prompt. A failure is kept per plugin and shown under it in Settings.
- **What counts as newer.** A plugin installed at a release tag (or from a repo that had none yet) looks at the release tags with its prefix. The newest release of the installed major comes first; a newer major is offered after it. A plugin pinned to a branch or to some other tag is offered that ref again once it points at another commit.
- **Automatic by default.** With "Update automatically" on (the default; `autoUpdate: false` in `plugins.json` when turned off), a minor or patch release of the installed major is installed as soon as a check finds it. A check nobody is watching (at launch, every 6 hours) then opens one dialog, in the focused window, listing each plugin with its old and new version; a check from the Settings button says it next to the plugin instead. A new major version and a moved branch are never installed without asking: they show as a dot on the Settings button and an "Update to …" button under the plugin.
- **Installing never touches the running copy until the new one is ready.** The tag is cloned into a hidden `.update-*` folder next to the plugins and its manifest is validated (including `engines.specterm`). Then the plugin is turned off (its disposal list is emptied and its host module is unloaded), the folders are swapped and the plugin is turned on again, with no app restart. An open view remounts with the new panel, because App keys it on the plugin's version. If the new copy fails to start, the previous one goes back and the error shows in Settings.
- **Trust.** Automatic updates mean trusting everyone who can push a release tag to that repo, from then on. Settings says so under the switch. A new major always asks, because it can change what the plugin does or what it can access.
- **Not built:** a per-plugin setting (only the global switch exists), the tag's message in Settings, and checking a release's `engines.specterm` before offering it (an incompatible one fails at install, with the reason).

## Status

Plugin API **1.3**, built and covered by `test/e2e-plugins.mjs` (86 checks) and `test/e2e-vault.mjs` (22), both part of `run-all`:
- discovery (symlinked folders included) and manifest validation (`electron/plugins.cjs`);
- the shared plugin host process (`electron/plugin-host.cjs`), started on the first enable and killed when the last plugin is turned off;
- the bridge (`invoke`, events, badge, toast) and the `specterm-plugin://` scheme, which serves only the files the manifest names;
- sidebar views (`PluginView`, with or without the frame's header), tab-bar buttons with badges, toasts under the button, declarative shortcuts;
- Settings > Plugins with the on/off switch, built-in and external plugins listed apart;
- adding an external plugin from its git URL in Settings > Plugins (`electron/plugin-install.cjs`), and removing one added that way;
- the boot answer in `plugins.json`, collected synchronously only when the `hasPlugins` flag is set;
- built-in plugins (`plugins/<id>/` in this repo): built by the app's `vite build`, unpacked from the asar in a package, on unless turned off, and read synchronously at boot so their buttons are in the first frame of every launch;
- `activation: "view"`, so a plugin that only answers its own panel costs no process until that panel is first opened;
- overlays (a view over the window, like a palette), and the renderer module, loaded in every window once its first terminal has rendered, for what must exist before any view is open: file-tree folder actions and banners, and commands a shortcut runs.

GitHub and the Vault are built-in plugins (`plugins/github/`, `plugins/vault/`). Measured on Linux, 11 launches each, median time to the window's first terminal render (`performance.mark("specterm:first-terminal-render")`): 170 ms with both on (the default), 180 ms with GitHub only, 179 ms with neither. The Vault's renderer module (0.7 KB, plus an 18 KB chunk it shares with its panel) runs after that mark, costing about 10–16 ms of main-thread time once the terminal is on screen.

Measured on Linux (API 1.0), 7 launches each, median time to the first terminal paint: 642 ms without plugins and 636 ms with one enabled (wall clock); 300 ms and 314 ms inside the page. The button was on the first frame in all 7 launches.

The first external plugin is the Sprint Platform inbox, in `nexfar/nf-sprint-planner` at `apps/specterm-inbox`.

Not built yet: the same install from a command line. Updates are built (see Updates), checked by `test/e2e-plugins.mjs`.

## Reference (API 1.3)

**Manifest** (`specterm-plugin.json`): `id` (the folder's name), `name`, `version`, `engines.specterm` (a caret range such as `"^1.1"`), and optionally `host`, `panel`, `style` (paths inside the plugin), `sidebarViews: [{ id, title, icon, ownHeader? }]`, `tabBarButton: { view, icon, title }`, `commands: [{ id, title, key, shift?, toggleView | toggleOverlay | invoke | run }]`, `activation: "startup" | "view"` (1.2; default `"startup"`), and from 1.3 `renderer` (a path), `overlays: [{ id }]` and `tabBarButton.order`. Icons are names from `src/lib/plugin-icons.ts`. The `specterm-plugin://` scheme serves the files the manifest names and whatever sits in their folders (a bundler's chunks), never the host module or the manifest.

**Host module** (CommonJS, `exports.activate(ctx)`, optional `exports.deactivate()`). `ctx` has `handle(method, fn)`, `emit(event, payload)`, `setBadge(count | "dot" | null)`, `toast({ title, tag?, body?, more?, payload? })` (1.1), `openExternal(url)`, `setInterval`, `setTimeout`, `clearTimer`, `onDispose(fn)` and `storagePath`. Everything registered through `ctx` is undone when the plugin is turned off.

**Panel module** (ES module, `export function mount(element, api)`, returning a dispose function). `api` has `invoke(method, ...args)`, `on(event, cb)`, `close()`, and from 1.1 `onReveal(cb)`, `renderMarkdown(source)`, `platform` and `openExternal(url)`, and from 1.2 `onActiveCwd(cb)`, `openFile(path, "tab" | "split")` and `storage` (`get`, `set`, `onChange`; a small JSON object per plugin, shared by its windows). The panel brings its own framework; the theme comes from the core's CSS variables. From 1.3: `onActiveFile(cb)`, `revealHeading(index)`, `noteStructure(source)` (the preview's own parser, so heading N is the preview's heading N) and `showView(viewId)`; an overlay is mounted with its id as `viewId`. A module stays loaded after its view closes, so module-level state survives a close and reopen.

**Renderer module** (1.3; ES module, `export function activate(api)`, returning a dispose function). `api` has `invoke`, `on`, `storage`, `showView`, `openFile`, `commands.register(name, fn)` (what a `run` shortcut calls), and `fileTree.addFolderAction({ id, title(path), run(path) })`, `fileTree.addFolderBanner({ id, match(path, names), run(path) })` and `fileTree.refresh()`. The tree asks for titles and banners synchronously when it draws; a plugin whose answers depend on its own state calls `refresh()` when that state changes. A plugin's panel and renderer modules built together share their chunks, so they share one copy of their state in the window.

## Order of work

1. **GitHub as a built-in plugin.** Done (`plugins/github/`). It needed API 1.2: built-in plugins, `activation: "view"`, `onActiveCwd`, `openFile` and `storage` (the watchlist moved there from the app's settings, carried over on first run).
2. **Inbox as an external plugin.** Done: #84 ported to `apps/specterm-inbox` in `nexfar/nf-sprint-planner`, which needed API 1.1 (toast, reveal, markdown, own header). Its e2e measures that nothing in the panel runs past its padding; that caught the conversation rows' summaries overflowing (Chromium's `align-items: flex-start` on `<button>`).
3. **Vault as a built-in plugin.** Done (`plugins/vault/`), with API 1.3: overlays for quick open, the renderer module for the folder menu item and the Obsidian banner, and `onActiveFile`, `revealHeading` and `noteStructure` for the outline. The vault list, an open Vault sidebar and rebound Vault shortcuts carry over on first run.
4. **Install from a URL.** Done in Settings > Plugins: the user pastes the repo's URL, `<url>#<tag>`, `<url>#<tag>:<folder>`, or a browser link to the folder (`…/tree/<tag>/<folder>`). Without a tag the newest release tag with the plugin's prefix is taken (`v<semver>` at the root, `<folder>-v<semver>` in a subfolder), and a repo with none installs its default branch. The clone is shallow, with symlinks checked out as plain files, made in a hidden `.install-*` folder next to the plugins and moved into place only once its manifest validates; its `.git` is dropped. `plugins.json` records `installed[id] = { source, ref, commit, installedAt }`, which is what the update check will read and what makes the plugin removable from Settings (a folder put there by hand is never deleted by the app). Adding a plugin turns it on: pasting the URL is the opt-in. Still to come: `specterm plugin add` on the command line.
5. **Updates.** Done: checks at launch, every 6 hours and from Settings; minor and patch releases install by themselves (switchable), with a dialog saying which; a new major waits for the user; a copy that fails to start is rolled back. See Updates.
