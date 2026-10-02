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

Bundled plugins update with the app. For external plugins, the updater copies the app's own behaviour (`autoUpdater.autoDownload = false`; a check runs when the app starts, and the user decides when to install):

- **Checking.** The first check runs a minute after the first shell and then every 6 hours. It runs `git ls-remote --tags` once per plugin repo (several plugins in one repo share the call), filtered by the plugin's tag prefix, with `GIT_TERMINAL_PROMPT=0`. A check never opens a prompt, and none of this happens on the boot path.
- **Offering.** A newer tag whose manifest is compatible with this app (`engines.specterm`) shows up as a dot on the Settings button and as a row in Settings > Plugins with the version and the tag's message. A tag that needs a newer app says so and is not offered.
- **Each plugin has an update setting:** `notify` (the default), `auto` or `off`. `auto` installs minor and patch versions without asking. A new major version always asks, because it can change what the plugin does or what it can access.
- **Installing never touches the running copy until the new one is ready.** The tag is fetched and checked out into `<id>.next`, and its manifest is validated. Then the plugin is disabled (its disposal list is emptied and its host module is unloaded), the folders are swapped, and the plugin is enabled again. There is no app restart. If the new version fails to activate, the previous copy (kept as `<id>.prev` until then) comes back and the error shows in Settings.
- **Trust.** `auto` means trusting everyone who can push a tag to that repo, from then on. Settings says so next to the option, which is why it is not the default.

## Status

Plugin API **1.2**, built and covered by `test/e2e-plugins.mjs` (45 checks, part of `run-all`):
- discovery (symlinked folders included) and manifest validation (`electron/plugins.cjs`);
- the shared plugin host process (`electron/plugin-host.cjs`), started on the first enable and killed when the last plugin is turned off;
- the bridge (`invoke`, events, badge, toast) and the `specterm-plugin://` scheme, which serves only the files the manifest names;
- sidebar views (`PluginView`, with or without the frame's header), tab-bar buttons with badges, toasts under the button, declarative shortcuts;
- Settings > Plugins with the on/off switch;
- the boot answer in `plugins.json`, collected synchronously only when the `hasPlugins` flag is set;
- built-in plugins (`plugins/<id>/` in this repo): built by the app's `vite build`, unpacked from the asar in a package, on unless turned off, and read synchronously at boot so their buttons are in the first frame of every launch;
- `activation: "view"`, so a plugin that only answers its own panel costs no process until that panel is first opened.

GitHub is the first built-in plugin (`plugins/github/`). Measured on Linux, 9 launches each, median time to the first terminal paint with it on (the default) and off: 639 ms and 630 ms wall clock, 300 ms and 300 ms inside the page; its button was on the first frame in all 9.

Measured on Linux (API 1.0), 7 launches each, median time to the first terminal paint: 642 ms without plugins and 636 ms with one enabled (wall clock); 300 ms and 314 ms inside the page. The button was on the first frame in all 7 launches.

The first external plugin is the Sprint Platform inbox, in `nexfar/nf-sprint-planner` at `apps/specterm-inbox`.

Not built yet: the file-tree and palette points, updates and the install command.

## Reference (API 1.2)

**Manifest** (`specterm-plugin.json`): `id` (the folder's name), `name`, `version`, `engines.specterm` (a caret range such as `"^1.1"`), and optionally `host`, `panel`, `style` (paths inside the plugin), `sidebarViews: [{ id, title, icon, ownHeader? }]`, `tabBarButton: { view, icon, title }`, `commands: [{ id, title, key, shift?, toggleView | invoke }]`, `activation: "startup" | "view"` (1.2; default `"startup"`). Icons are names from `src/lib/plugin-icons.ts`.

**Host module** (CommonJS, `exports.activate(ctx)`, optional `exports.deactivate()`). `ctx` has `handle(method, fn)`, `emit(event, payload)`, `setBadge(count | "dot" | null)`, `toast({ title, tag?, body?, more?, payload? })` (1.1), `openExternal(url)`, `setInterval`, `setTimeout`, `clearTimer`, `onDispose(fn)` and `storagePath`. Everything registered through `ctx` is undone when the plugin is turned off.

**Panel module** (ES module, `export function mount(element, api)`, returning a dispose function). `api` has `invoke(method, ...args)`, `on(event, cb)`, `close()`, and from 1.1 `onReveal(cb)`, `renderMarkdown(source)`, `platform` and `openExternal(url)`, and from 1.2 `onActiveCwd(cb)`, `openFile(path, "tab" | "split")` and `storage` (`get`, `set`, `onChange`; a small JSON object per plugin, shared by its windows). The panel brings its own framework; the theme comes from the core's CSS variables. A module stays loaded after its view closes, so module-level state survives a close and reopen.

## Order of work

1. **GitHub as a built-in plugin.** Done (`plugins/github/`). It needed API 1.2: built-in plugins, `activation: "view"`, `onActiveCwd`, `openFile` and `storage` (the watchlist moved there from the app's settings, carried over on first run).
2. **Inbox as an external plugin.** Done: #84 ported to `apps/specterm-inbox` in `nexfar/nf-sprint-planner`, which needed API 1.1 (toast, reveal, markdown, own header). Its e2e measures that nothing in the panel runs past its padding; that caught the conversation rows' summaries overflowing (Chromium's `align-items: flex-start` on `<button>`).
3. **Vault as a bundled plugin.** This adds the file-tree, palette, active-file, markdown and reveal-heading points. It goes last because those points are the largest addition to the contract, and they should be shaped by a working base, not designed up front.
4. **Install command.** `specterm plugin add <git-url>[#tag] [--path <dir>]` clones the repo, checks out the tag and records the commit hash. `specterm plugin update <id>` lists the newer tags and moves only when the user confirms. Until this exists, installing is a manual clone plus checkout of a tag.
