import { Show, onMount, createEffect, createMemo, onCleanup } from "solid-js";
import { captureSessionNow, useTabStore } from "./stores/tabs";
import { flushSession } from "./stores/history";
import {
  startSessionProviders,
  stopSessionProviders,
} from "./lib/session-providers";
import { getBackend, windowBoot } from "./backends";
import { initKeybindings, registerBindings } from "./stores/keybindings";
import { createKeymap } from "./stores/keymap";
import {
  initSettings,
  tabBarEdge,
  tabBarAutoHide,
  claudeAttentionMode,
} from "./stores/settings";
import {
  attentionCount,
  clearAllAttention,
  setFocusedPane,
} from "./stores/attention";
import { initTheme, importBase16Theme } from "./stores/theme";
import { initUpdater } from "./stores/updater";
import { initStoreSync } from "./lib/store-sync";
import { getTerminalInstance } from "./lib/terminal-registry";
import { writePty } from "./lib/pty";
import { shellQuoteCd } from "./lib/fspath";
import TabBar from "./components/TabBar";
import SplitContainer from "./components/SplitContainer";
import FileTree from "./components/FileTree";
import SettingsPanel from "./components/SettingsPanel";
import SidebarResizeHandle from "./components/SidebarResizeHandle";
import { draggingPaneId, dropTarget } from "./stores/pane-drag";
import { closeSearch, searchPaneId } from "./stores/terminal-search";
import type { UnlistenFn } from "./backends";

export default function App() {
  const store = useTabStore();

  // The file tree and the settings panel share one slot in .app-body, so the
  // store models it as a single `sidebarView` — there's no state in which both
  // are open, and no invariant for callers to maintain.
  const settingsOpen = () => store.state.sidebarView === "settings";

  function toggleSettings() {
    store.toggleSidebarView("settings");
    if (!settingsOpen()) focusActivePane();
  }

  // Keep keyboard focus on the active pane's terminal. The active pane is the
  // one drawn at full opacity (others are dimmed), so typing must always land
  // there — even after splits, drag-reorders or tab switches remount panes.
  function focusActiveTerminal() {
    const tab = store.activeTab;
    if (!tab) return;
    // Don't steal focus from a real text field (e.g. the sidebar search opened
    // by ⌘B); only xterm's hidden textarea should yield to the terminal.
    const ae = document.activeElement;
    if (
      ae instanceof HTMLElement &&
      (ae.tagName === "INPUT" ||
        (ae.tagName === "TEXTAREA" &&
          !ae.classList.contains("xterm-helper-textarea")))
    ) {
      return;
    }
    getTerminalInstance(tab.activePaneId)?.term.focus();
  }

  // The window came back to the front: put the cursor back in the active pane
  // and re-assert it as the focused one, which clears whatever flag it picked
  // up while you were away.
  function onWindowFocus() {
    focusActiveTerminal();
    setFocusedPane(store.activeTab?.activePaneId ?? null);
  }

  // Deterministically move keyboard focus into a pane after an *explicit* action
  // (a drag-drop). Unlike focusActiveTerminal this ignores the input guard —
  // dropping a pane is an unambiguous intent to focus it — and it verifies the
  // focus actually landed. `term.focus()` silently no-ops when the terminal
  // element was just moved in the DOM and hasn't been laid out yet, which would
  // leave typing focus on the previously focused pane while the active-pane
  // highlight (state-driven) already moved — the exact drag-drop focus glitch.
  // So: focus, check synchronously, and retry on the next frame until the helper
  // textarea holds focus, capped so a non-terminal pane (markdown) or a torn-down
  // pane doesn't retry forever.
  function focusPaneReliably(paneId: string, attempts = 3) {
    const inst = getTerminalInstance(paneId);
    if (!inst || inst.disposed) return; // no terminal to focus (e.g. markdown)
    inst.term.focus();
    // focus() is synchronous: activeElement reflects success on this same tick.
    if (document.activeElement === inst.term.textarea) return;
    if (attempts <= 1) return; // give up quietly instead of looping forever
    requestAnimationFrame(() => focusPaneReliably(paneId, attempts - 1));
  }

  // The whole AppState lives in one signal, so *any* store write (opening the
  // sidebar, renaming a tab) notifies everything that reads it. Funnel the
  // active pane through a memo so the effects below only re-run when the pane
  // actually changes — otherwise toggling the sidebar yanks keyboard focus back
  // into the terminal, and the terminal then swallows the keys the panel needs.
  const activePaneId = createMemo(() => store.activeTab?.activePaneId);

  createEffect(() => {
    if (!activePaneId()) return;
    // Wait a frame so a just-remounted terminal is in the DOM before focusing.
    // Cancel a still-pending frame if the active pane changes again first, so
    // rapid tab/pane switches don't queue up stale focus calls.
    const raf = requestAnimationFrame(focusActiveTerminal);
    onCleanup(() => cancelAnimationFrame(raf));
  });

  // Tell the attention store where the user is. Arriving at a pane that was
  // flagged as waiting puts its flag out — you're looking at it, so the app has
  // nothing left to tell you — and stops a detector from re-flagging it while
  // you sit there.
  createEffect(() => {
    setFocusedPane(activePaneId() ?? null);
  });

  // Switching the feature off drops the flags that are already up — leaving
  // them would strand indicators that nothing is left to clear.
  createEffect(() => {
    if (claudeAttentionMode() === "off") clearAllAttention();
  });

  // Mirror the count onto whatever the OS gives us outside the window (a dock
  // badge, a flashing taskbar entry). Kept separate from the effect above so
  // clearing the flags doesn't re-enter the effect that reads their count.
  createEffect(() => {
    const count = attentionCount();
    getBackend()
      .then((backend) => backend.setAttentionBadge(count))
      .catch(() => {
        /* No badge on this platform/backend — the in-window dots still show. */
      });
  });

  // Close the find bar when focus leaves the pane it was opened on (pane
  // switch, tab switch), so it never lingers over a dimmed split.
  createEffect(() => {
    const active = activePaneId();
    const searching = searchPaneId();
    if (searching && searching !== active) closeSearch();
  });

  // Send `cd <path>` to the active pane's shell. Used by the file tree's
  // favorites (click or the "fav-N" search token).
  function cdActivePane(path: string) {
    const tab = store.activeTab;
    if (!tab) return;
    const inst = getTerminalInstance(tab.activePaneId);
    if (inst && inst.ptyId !== null) {
      // Quote/escape per the host shell — PowerShell (the Windows default) needs
      // Set-Location, not the POSIX `cd 'x'` form. See lib/fspath.
      //
      // Submit with a carriage return, not "\n": that's the byte a real Enter
      // key sends, and ConPTY/PowerShell on Windows does NOT execute the line on
      // a bare "\n" (it just sits at the prompt). CR works on POSIX shells too
      // (the pty line discipline maps CR→NL), so it's the correct cross-platform
      // submit.
      writePty(inst.ptyId, `${shellQuoteCd(path)}\r`);
      inst.term.focus();
    }
  }

  function handleOpenMarkdown(path: string, mode: "split" | "tab") {
    const mdPane = { kind: "markdown" as const, filePath: path };

    if (mode === "tab") {
      store.createMarkdownTab(path);
    } else {
      store.splitActivePane("h", mdPane);
    }
  }

  // Markdown gets the rendered preview; every other text file opens in the
  // read-only viewer. Extension-only routing keeps this cheap and predictable —
  // TextPane itself decides whether the bytes are actually viewable.
  const isMarkdownPath = (p: string) => /\.(md|markdown)$/i.test(p);

  function handleOpenFile(path: string, mode: "split" | "tab") {
    if (isMarkdownPath(path)) {
      handleOpenMarkdown(path, mode);
      return;
    }
    if (mode === "tab") {
      store.createTextTab(path);
    } else {
      store.splitActivePane("h", { kind: "text" as const, filePath: path });
    }
  }

  // Move a tab (or a single pane, which becomes a tab) out of this window,
  // because the drag was released outside it. The store snapshots it and hands
  // its PTYs over; the host decides where it lands — another Specterm window if
  // one is under the cursor, otherwise a new window there. Both steps refuse
  // quietly when the move would leave this window with nothing.
  async function tearOff(kind: "tab" | "pane", id: string) {
    const transfer =
      kind === "tab" ? await store.takeTab(id) : await store.takePane(id);
    if (!transfer) return;
    const backend = await getBackend();
    await backend.dropTransfer(transfer);
  }

  // Move keyboard focus back into the active tab's terminal (or, if that pane
  // isn't a terminal, just drop focus from wherever it is — e.g. the filter).
  function focusActivePane() {
    const paneId = store.activeTab?.activePaneId;
    const term = paneId ? getTerminalInstance(paneId) : undefined;
    if (term) {
      term.term.focus();
    } else if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }

  onMount(() => {
    // All shortcuts live in the keymap (src/stores/keymap.ts) — a single
    // declarative table, authored macOS-first and resolved per-OS (with
    // optional per-platform overrides). Handlers that need component scope
    // (the store, focusActivePane) are threaded in here.
    registerBindings(
      createKeymap({
        store,
        focusActivePane,
        toggleSettings,
      })
    );

    initKeybindings();

    // Apply persisted appearance settings (e.g. unfocused-pane opacity) to the
    // DOM before the first paint settles.
    initSettings();

    // Apply the persisted color theme (CSS variables + terminal palette).
    initTheme();

    // Start listening for settings/theme/favorites changes made in other
    // windows. Each store registered its own reload in the init calls above.
    void initStoreSync();

    // Fill the window. What goes in it depends on what kind of window this is,
    // and that answer is already here — the host stamped it into our launch
    // arguments, so there is no round trip in front of the first shell (see
    // WindowBoot in backends/types.ts). Only a window created to host a
    // torn-off tab has to go and fetch anything, and that one exists solely
    // because a drag just ended.
    const boot = windowBoot();
    if (boot.hasTab) {
      void getBackend()
        .then((backend) => backend.takeWindowInit())
        .then((init) => store.initWindow(init.tab, false))
        .catch((err) => {
          // Never leave a window empty because the handover failed: fall back
          // to the plain new-terminal boot.
          console.warn("[window] adopting the torn-off tab failed:", err);
          store.initWindow(null, false);
        });
    } else {
      store.initWindow(null, boot.ownsSession);
    }

    // A tab torn off another window and dropped onto this one.
    let unlistenAdopt: UnlistenFn | undefined;
    void getBackend()
      .then((backend) => backend.onAdoptTab((tab) => store.adoptTab(tab)))
      .then((un) => {
        unlistenAdopt = un;
      });
    onCleanup(() => unlistenAdopt?.());

    // Watch for resumable programs (Claude Code) running in the panes, so a
    // closed tab remembers not just where it was but what it was doing. Polls
    // slowly; see lib/session-providers.
    startSessionProviders();
    onCleanup(stopSessionProviders);

    // Check GitHub for a newer release once per app launch — the first window
    // owns that check, so opening more windows doesn't re-hit the feed. Any
    // later check is the manual button in Settings.
    if (boot.autoCheckUpdates) void initUpdater();

    // When the OS window regains focus, return the cursor to the active pane —
    // and, since the user is now looking at it, put out any attention flag it
    // was carrying. The effect above can't do this on its own: coming back to
    // the window doesn't change which pane is active, so nothing it watches
    // moves.
    window.addEventListener("focus", onWindowFocus);

    // Last chance to write down what was open. Store writes already keep the
    // snapshot current on a debounce, but the two things that matter most —
    // where each shell ended up, and what it was running — live on the terminal
    // registry and change without any store write. Re-capture, then force the
    // debounced write out before the window goes.
    const saveOnExit = () => {
      captureSessionNow();
      flushSession();
    };
    window.addEventListener("beforeunload", saveOnExit);
    // beforeunload isn't guaranteed on every platform's quit path; "hidden" is
    // the event that reliably precedes teardown. Both are idempotent.
    const onHidden = () => {
      if (document.visibilityState === "hidden") saveOnExit();
    };
    document.addEventListener("visibilitychange", onHidden);
    onCleanup(() => {
      window.removeEventListener("beforeunload", saveOnExit);
      document.removeEventListener("visibilitychange", onHidden);
    });

    // Open markdown files handed to us by the OS (Finder "Open With",
    // double-click, or a path arg) in a new tab. The main process queues files
    // that arrive before this listener attaches and replays them here.
    let unlistenOpenPath: (() => void) | undefined;
    getBackend().then((backend) =>
      backend
        .onOpenPath((filePath) => {
          if (filePath.toLowerCase().endsWith(".md")) {
            handleOpenMarkdown(filePath, "tab");
          }
        })
        .then((un) => {
          unlistenOpenPath = un;
        })
    );
    onCleanup(() => unlistenOpenPath?.());

    // Drag a base16 theme file (.yaml/.json) onto the window to import it. Only
    // OS file drops are intercepted — internal pane drags don't carry a "Files"
    // type, so they fall through to the pane drag-and-drop logic untouched. The
    // preventDefault on dragover is required, or the drop navigates the window
    // to the file instead of firing our handler.
    const isFileDrag = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onDragOver = (e: DragEvent) => {
      if (isFileDrag(e)) e.preventDefault();
    };
    const onDrop = async (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      if (!importBase16Theme(await file.text())) {
        console.warn(`[theme] "${file.name}" is not a valid base16 scheme`);
      }
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    onCleanup(() => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    });
  });

  return (
    // The chrome layout is expressed as data attributes and CSS variables; the
    // stylesheet reflows around them, so moving the tab bar to another corner or
    // collapsing it never re-renders a pane. Panes resize, their ResizeObserver
    // fires, and xterm refits itself.
    <div
      class="app"
      data-tab-edge={tabBarEdge()}
      data-tab-autohide={tabBarAutoHide() ? "true" : "false"}
    >
      <TabBar
        tabs={store.state.tabs}
        activeTabId={store.state.activeTabId}
        sidebarOpen={store.state.sidebarView === "files"}
        renamingTabId={store.state.renamingTabId}
        onSelect={(id) => store.setActiveTab(id)}
        onClose={(id) => store.closeTab(id)}
        onCreate={() => store.createTab()}
        onToggleSidebar={() => store.toggleSidebarView("files")}
        onOpenSettings={toggleSettings}
        onStartRename={(id) => store.startRenameTab(id)}
        onCommitRename={(id, title) => store.commitRenameTab(id, title)}
        onCancelRename={() => store.cancelRenameTab()}
        onReorder={(source, target, before) =>
          store.moveTab(source, target, before)
        }
        onTearOff={(id) => void tearOff("tab", id)}
        settingsOpen={settingsOpen()}
      />
      <div class="app-body">
        <FileTree
          open={store.state.sidebarView === "files"}
          onOpenFile={handleOpenFile}
          onCdPath={cdActivePane}
          onDismiss={focusActivePane}
        />
        {/* Mounted only while open. The panel probes the installed font list and
            builds the 325-scheme gallery on mount, so keeping it alive behind an
            internal <Show> paid that cost on every app boot. */}
        <Show when={settingsOpen()}>
          <SettingsPanel
            onClose={() => {
              store.closeSidebar();
              focusActivePane();
            }}
          />
        </Show>
        <Show when={store.state.sidebarView !== null}>
          <SidebarResizeHandle />
        </Show>
        <div class="app-content" data-split-root>
          <Show when={store.activeTab}>
            {(tab) => (
              <SplitContainer
                node={tab().root}
                activePaneId={tab().activePaneId}
                tabId={tab().id}
                onFocusPane={(id) => store.setActivePaneId(id)}
                onResizeSplit={(entries) => store.resizeSplits(entries)}
                onToggleDirection={(splitId) =>
                  store.toggleSplitDirection(splitId)
                }
                onDropPane={(sourceId, targetId, edge, atRoot) => {
                  store.movePane(sourceId, targetId, edge, atRoot);
                  // The state update already moved the active-pane highlight to
                  // sourceId; pull keyboard focus there too, deterministically,
                  // once the moved terminal has settled into its new DOM slot.
                  requestAnimationFrame(() => focusPaneReliably(sourceId));
                }}
                onDropPaneToTab={(sourceId, tabId) => {
                  store.movePaneToTab(sourceId, tabId);
                  // The moved pane is now the target tab's active pane; bring
                  // keyboard focus with it once it lands in the newly shown tab.
                  requestAnimationFrame(() => focusPaneReliably(sourceId));
                }}
                onTearOffPane={(sourceId) => void tearOff("pane", sourceId)}
                onTitle={(title) => store.updateTabTitle(tab().id, title)}
                onClosePane={(id) => store.closePane(id)}
                onOpenMarkdown={handleOpenMarkdown}
              />
            )}
          </Show>
          {/* Full-span preview when a drag lands on the outer layout edge:
              drops there become a whole column/row at the root. */}
          <Show
            when={
              draggingPaneId() !== null && dropTarget()?.root
                ? dropTarget()
                : null
            }
          >
            {(dt) => <div class={`drop-indicator drop-indicator-${dt().edge}`} />}
          </Show>
        </div>
      </div>
    </div>
  );
}
