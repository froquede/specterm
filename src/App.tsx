import {
  Show,
  Suspense,
  lazy,
  onMount,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import {
  captureSessionNow,
  captureSessionOnExit,
  useTabStore,
} from "./stores/tabs";
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
  desktopNotifications,
} from "./stores/settings";
import {
  attentionCount,
  clearAllAttention,
  setFocusedPane,
  waitingPanes,
  paneAttention,
  paneAttentionMessage,
} from "./stores/attention";
import { initTheme, importBase16Theme } from "./stores/theme";
import { initUpdater } from "./stores/updater";
import { initStoreSync } from "./lib/store-sync";
import { getTerminalInstance } from "./lib/terminal-registry";
import { writePty } from "./lib/pty";
import { shellQuoteCd, shellQuotePath } from "./lib/fspath";
import { classifyDrop } from "./lib/file-drop";
import { collectLeaves } from "./lib/split-tree";
import { initWindowChrome } from "./stores/window-chrome";
import TabBar from "./components/TabBar";
import TitleStrip from "./components/TitleStrip";
import SplitContainer from "./components/SplitContainer";
import FileTree from "./components/FileTree";
import SidebarResizeHandle from "./components/SidebarResizeHandle";

// The settings panel is the one part of the chrome that is never on screen at
// launch, and it is also the widest: a thousand lines of controls, the font
// prober, the updater UI, the Claude-hooks installer and its own half of the
// icon set. Split into a chunk of its own it costs a launch that never opens it
// nothing at all — not a byte fetched, not a line parsed — and the first shell
// gets the boot budget instead. It was already mounted lazily; this makes it
// *load* lazily too, which is the half that was actually costing anything.
const SettingsPanel = lazy(() => import("./components/SettingsPanel"));
import type { PaneId } from "./types";
import { draggingPaneId, dropTarget } from "./stores/pane-drag";
import { dragOver, setDragOver } from "./stores/tear-off";
import { closeSearch, searchPaneId } from "./stores/terminal-search";
import type { UnlistenFn } from "./backends";

export default function App() {
  const store = useTabStore();

  // True while OS files are being dragged over the window — drives the hint
  // that says what a release will do.
  const [fileDragActive, setFileDragActive] = createSignal(false);

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

  // An OS notification for a pane that has *just* started waiting.
  //
  // Deliberately one per waiting episode, not one per signal: a pane that
  // notifies twice, or notifies and then rings the bell, is still the same
  // interruption. `notifiedPanes` is what makes that true — a pane is added
  // when it is announced and removed once it stops waiting, so the next time
  // it stops it can announce again.
  //
  // Panes that start waiting while the window is focused are marked as
  // announced without notifying: the dot is right there, and firing later
  // (when the user tabs away) would be a notification about something they
  // already saw.
  const notifiedPanes = new Set<PaneId>();
  createEffect(() => {
    const waiting = waitingPanes();
    const live = new Set(waiting);
    for (const id of notifiedPanes) {
      if (!live.has(id)) notifiedPanes.delete(id);
    }

    const fresh = waiting.filter((id) => !notifiedPanes.has(id));
    for (const id of fresh) notifiedPanes.add(id);

    if (fresh.length === 0 || !desktopNotifications()) return;
    if (typeof document !== "undefined" && document.hasFocus()) return;

    // Only ever one, however many panes came up at once — a burst of finished
    // agents should not be a burst of popups.
    const paneId = fresh[0];
    const extra = fresh.length - 1;
    const message = paneAttentionMessage(paneId);
    const kind = paneAttention(paneId);
    const title =
      kind === "permission" ? "Waiting for your answer" : "Specterm";
    const body = [
      message || "A pane is waiting for you",
      extra > 0 ? `and ${extra} more` : "",
    ]
      .filter(Boolean)
      .join(" — ");

    void getBackend()
      .then((backend) => backend.notifyWaiting({ title, body }))
      .catch(() => {
        /* No notification service here — the badge and the dot still say it. */
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

  // Put file paths into the active pane's prompt without running anything — the
  // drop half of "drag a screenshot at Claude". Deliberately unsubmitted: the
  // path is an argument to a line the user is still writing, and a stray CR
  // here would run whatever was already typed there.
  function attachToPrompt(paths: string[]) {
    const tab = store.activeTab;
    if (!tab) return;
    // Normally the pane the files landed on. When that pane has no prompt to
    // attach to (an image dropped on a markdown preview), fall back to any
    // terminal in the tab rather than dropping the paths on the floor.
    const inst =
      getTerminalInstance(tab.activePaneId) ??
      collectLeaves(tab.root)
        .map((leaf) => getTerminalInstance(leaf.id))
        .find((candidate) => candidate && candidate.ptyId !== null);
    if (!inst || inst.ptyId === null) return;
    // Padded both sides: the line may already hold half a typed command, and a
    // path glued to the word before it is neither a valid argument nor
    // something Claude will recognize as a file.
    writePty(inst.ptyId, ` ${paths.map(shellQuotePath).join(" ")} `);
    inst.term.focus();
  }

  function handleOpenMarkdown(path: string, mode: "split" | "tab") {
    const mdPane = { kind: "markdown" as const, filePath: path };

    if (mode === "tab") {
      store.createMarkdownTab(path);
    } else {
      store.splitActivePane("h", mdPane);
    }
  }

  // Markdown gets the rendered preview; an image opens in the image viewer;
  // every other text file opens in the read-only text viewer. Extension-only
  // routing keeps this cheap and predictable — TextPane itself decides whether
  // the bytes are actually viewable.
  const isMarkdownPath = (p: string) => /\.(md|markdown)$/i.test(p);
  const isImagePath = (p: string) =>
    /\.(png|jpe?g|gif|svg|webp|bmp|ico|avif)$/i.test(p);

  function handleOpenFile(path: string, mode: "split" | "tab") {
    if (isMarkdownPath(path)) {
      handleOpenMarkdown(path, mode);
      return;
    }
    if (isImagePath(path)) {
      if (mode === "tab") {
        store.createImageTab(path);
      } else {
        store.splitActivePane("h", { kind: "image" as const, filePath: path });
      }
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
  // one is under the cursor, otherwise a new window there.
  //
  // The host is asked *first*, because where the drop landed is what decides
  // whether this window may give away everything it has. Dropping its last tab
  // on empty desktop is refused (it would rebuild this window a few pixels over
  // and leave an empty one behind), but dropping it onto another window is a
  // merge — the gesture that puts a torn-off window back where it came from —
  // and that leaves this window with nothing left to show, so it closes.
  async function tearOff(kind: "tab" | "pane", id: string) {
    const backend = await getBackend();
    const { toWindow } = await backend.beginTransfer();
    const transfer =
      kind === "tab"
        ? await store.takeTab(id, { allowLast: toWindow })
        : await store.takePane(id, { allowLast: toWindow });
    if (!transfer) return;
    await backend.dropTransfer(transfer);
    if (store.state.tabs.length === 0) await backend.closeWindow();
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

    // Subscribe to this window's frame state (fullscreen, maximised, and
    // whether we draw the window controls ourselves). Whether the controls
    // exist at all was already answered synchronously from the boot flags, so
    // this only refines what is on screen — it never gates the first paint.
    void initWindowChrome();

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
    if (boot.restore) {
      // A window being reopened at launch. Its layout is already here — the preload
      // collected it synchronously — so the first tab is built in this same tick,
      // with nothing awaited in front of the first shell.
      store.initWindow(null, boot.restore);
    } else if (boot.hasTabs) {
      // Tabs handed over with their PTYs still running. This is the one case where a
      // round trip is affordable: they can carry megabytes of serialized screen, and
      // the window exists only because a drag just ended.
      void getBackend()
        .then((backend) => backend.takeWindowInit())
        .then((init) => store.initWindow(init.tabs))
        .catch((err) => {
          // Never leave a window empty because the handover failed: fall back
          // to the plain new-terminal boot.
          console.warn("[window] collecting this window's state failed:", err);
          store.initWindow(null);
        });
    } else if (boot.migrateLegacy) {
      // First launch after the upgrade that moved the session out of localStorage.
      store.initWindowFromLegacy();
    } else {
      store.initWindow(null);
    }

    // The host is closing this window and is holding the close open until we have
    // handed our shells over (see the detached-session block in
    // electron/main.cjs). Two things have to happen here, in this order:
    //
    //   1. Write the on-disk snapshot *first*, while the terminals still exist.
    //      Detaching disposes them, and a screen capture taken afterwards would
    //      be empty — and would overwrite a perfectly good one. The disk snapshot
    //      is what covers the case where this process later dies without ever
    //      being reattached (a crash, a reboot), so it has to be the last honest
    //      picture of the window.
    //   2. Hand the tabs over, and answer — always, even with nothing to park, or
    //      the window sits there until the host's timeout gives up on us.
    let unlistenDetach: UnlistenFn | undefined;
    void getBackend()
      .then((backend) =>
        backend.onDetachRequest(() => {
          // The snapshot goes out *first*, while the terminals still exist:
          // detaching disposes them, and a screen captured afterwards would be
          // empty — and would overwrite a good one. It is also the last one this
          // window writes (captureSessionOnExit freezes it), which is what has to
          // be true: from here the truth is the live shells the host is holding,
          // and if this process later dies without ever being reattached, that
          // snapshot is the picture the next launch restores.
          captureSessionOnExit();
          void store
            .detachWindow()
            .catch((err) => {
              console.warn("[window] detaching failed:", err);
              return [];
            })
            .then((tabs) => backend.parkSession(tabs))
            .catch(() => {
              /* Host is gone; nothing left that could close this window. */
            });
        })
      )
      .then((un) => {
        unlistenDetach = un;
      });
    onCleanup(() => unlistenDetach?.());

    // A tab torn off another window and dropped onto this one.
    let unlistenAdopt: UnlistenFn | undefined;
    void getBackend()
      .then((backend) => backend.onAdoptTab((tab) => store.adoptTab(tab)))
      .then((un) => {
        unlistenAdopt = un;
      });
    onCleanup(() => unlistenAdopt?.());

    // A drag from another window is hovering this one. It can't be felt from
    // here — the pointer events all belong to the window the drag started in —
    // so the host watches the cursor and tells us. All this window does with it
    // is say so; the drop itself still arrives as an adopt-tab above.
    let unlistenDragOver: UnlistenFn | undefined;
    void getBackend()
      .then((backend) => backend.onDragOver(setDragOver))
      .then((un) => {
        unlistenDragOver = un;
      });
    onCleanup(() => {
      unlistenDragOver?.();
      setDragOver(false);
    });

    // Watch for resumable programs (Claude Code) running in the panes, so a
    // closed tab remembers not just where it was but what it was doing. Polls
    // slowly; see lib/session-providers.
    startSessionProviders();
    onCleanup(stopSessionProviders);

    // Check GitHub for a newer release once per app launch — the first window
    // owns that check, so opening more windows doesn't re-hit the feed. Any
    // later check is the manual button in Settings. Every window still starts
    // listening: updater events are broadcast app-wide, and this window's own
    // Settings button needs an ear for the answer.
    void initUpdater(boot.autoCheckUpdates);

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
    // Unloading is real teardown, so this snapshot is the final one and the
    // session is frozen behind it (see captureSessionOnExit). Everything after it
    // is the window coming apart — the host kills the shells, the panes see their
    // processes exit and close themselves, and the last one closing spawns a
    // replacement — none of which is a session anyone asked to save.
    const saveOnExit = () => captureSessionOnExit();
    window.addEventListener("beforeunload", saveOnExit);

    // A checkpoint, not a teardown: "hidden" also fires on a minimize, so this
    // deliberately does *not* freeze. It exists because beforeunload isn't
    // guaranteed on every platform's quit path, and because a snapshot taken when
    // the window was last put away is worth having if the app is killed outright.
    const onHidden = () => {
      if (document.visibilityState === "hidden") captureSessionNow();
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

    // Files dragged in from the OS. Only OS file drops are intercepted —
    // internal pane drags don't carry a "Files" type, so they fall through to
    // the pane drag-and-drop logic untouched. The preventDefault on dragover is
    // required, or the drop navigates the window to the file instead of firing
    // our handler.
    const isFileDrag = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");

    // dragenter/dragleave fire once per element the cursor crosses, so a plain
    // boolean flickers off the moment the pointer moves between two panes.
    // Counting entries against leaves is what makes the hint stable.
    let dragDepth = 0;
    const onDragEnter = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      dragDepth++;
      setFileDragActive(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setFileDragActive(false);
    };
    const endFileDrag = () => {
      dragDepth = 0;
      setFileDragActive(false);
    };
    const onDragOver = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      // "copy" is what the OS shows as a plus cursor — nothing here moves or
      // consumes the original file.
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };

    const onDrop = async (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      endFileDrag();
      const dt = e.dataTransfer;
      if (!dt) return;

      // Everything the DataTransfer holds has to be read *before* the first
      // await: it is neutered as soon as this handler returns. The File objects
      // survive on their own, but the entries — our only synchronous "is this a
      // folder?" — do not, and neither does dt.files itself.
      const files = Array.from(dt.files);
      const isDir = Array.from(dt.items).map(
        (item) => item.webkitGetAsEntry()?.isDirectory ?? false
      );

      // A drop acts on the pane it landed on, not on whichever pane happened to
      // be active — the cursor was pointing at one of them, and that is the
      // answer the user gave.
      const paneEl = (e.target as Element | null)?.closest?.("[data-pane-id]");
      const droppedOn = paneEl?.getAttribute("data-pane-id");
      if (droppedOn) store.setActivePaneId(droppedOn);

      const backend = await getBackend();
      const dropped = files.map((file, i) => ({
        file,
        path: backend.filePathFor(file),
        mime: file.type,
        isDirectory: isDir[i] ?? false,
      }));

      // Paths bound for the prompt are batched: dropping three screenshots at
      // once should write one line, not race three writes into the pty.
      const toPrompt: string[] = [];
      // Two folders in one drop can't both be the working directory; the first
      // wins and the rest are ignored rather than firing a burst of cds.
      let changedDir = false;
      for (const item of dropped) {
        const path = item.path;
        if (!path) {
          console.warn(`[drop] no path for "${item.file.name}" on this host`);
          continue;
        }
        switch (classifyDrop({ path, mime: item.mime, isDirectory: item.isDirectory })) {
          case "directory":
            if (!changedDir) {
              cdActivePane(path);
              changedDir = true;
            }
            break;
          case "markdown":
            handleOpenMarkdown(path, "split");
            break;
          case "theme":
            // A .yaml/.json/.txt is a theme only if it parses as one; when it
            // doesn't it was just a text file, so it opens like any other.
            if (!importBase16Theme(await item.file.text())) {
              handleOpenFile(path, "split");
            }
            break;
          case "text":
            handleOpenFile(path, "split");
            break;
          case "image":
          case "path":
            toPrompt.push(path);
            break;
        }
      }
      if (toPrompt.length > 0) attachToPrompt(toPrompt);
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragend", endFileDrag);
    window.addEventListener("drop", onDrop);
    onCleanup(() => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragend", endFileDrag);
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
      {/* Only ever present when the tab bar has been moved off the top edge —
          see TitleStrip, which decides for itself and renders nothing
          otherwise. */}
      <TitleStrip />
      {/* A drag from another window is over this one. Drawn across the whole
          window because that is the granularity of the drop: wherever it is
          released in here, the tab lands as a tab. */}
      <Show when={dragOver()}>
        <div class="window-drop-overlay">
          <span class="window-drop-label">Drop here to move in</span>
        </div>
      </Show>
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
            internal <Show> paid that cost on every app boot. Nothing is rendered
            while its chunk is in flight: it comes off local disk in a frame or
            two, and a placeholder that flashes for one frame reads worse than
            the panel simply opening. */}
        <Show when={settingsOpen()}>
          <Suspense>
            <SettingsPanel
              onClose={() => {
                store.closeSidebar();
                focusActivePane();
              }}
            />
          </Suspense>
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
                onDropPaneToNewTab={(sourceId) => {
                  store.movePaneToNewTab(sourceId);
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
          {/* What a release will do with the files under the cursor. Purely a
              hint — pointer-events are off, so it can't eat the drop it's
              describing. */}
          <Show when={fileDragActive()}>
            <div class="file-drop-overlay">
              <div class="file-drop-card">
                <span class="file-drop-title">Drop to open</span>
                <span class="file-drop-hint">
                  Markdown and text open in a new pane · folders cd · images go
                  to the prompt, ready for Claude
                </span>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}
