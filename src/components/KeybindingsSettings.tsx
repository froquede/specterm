// The keyboard shortcuts surface, inside the settings sidebar.
//
// Every row the keymap registered, grouped and searchable, each showing the
// chord it currently answers to. Clicking a chord records the next keystroke
// and rebinds the row to it; Backspace switches the row off; Esc backs out.
//
// Two things it deliberately does rather than prevent:
//
//  - It shows collisions instead of refusing them. Moving a chord from one
//    action to another means passing through a state where both hold it, and a
//    panel that rejects the first half of that move is a panel you cannot use.
//    Both rows say so, and the one that would never fire says which action is
//    taking its keystroke.
//  - It refuses chords the terminal owns. A bare key, or Ctrl+<key> on its own,
//    is a control code every program in a pane expects to receive — Ctrl+C is
//    SIGINT, Ctrl+D is EOF. Binding one doesn't shadow a feature, it takes the
//    key away from the shell, and the shell is the whole point of the app.
import {
  For,
  Show,
  createMemo,
  createSignal,
  onCleanup,
  type JSX,
} from "solid-js";
import {
  keymapSpecs,
  activeChord,
  defaultChord,
  setKeybindingCapture,
  type BindingSpec,
} from "../stores/keybindings";
import {
  overrides,
  overrideCount,
  setOverride,
  clearOverride,
  resetAllOverrides,
} from "../stores/keybinding-overrides";
import {
  chordFromEvent,
  chordSignature,
  chordStealsFromTerminal,
  chordsEqual,
  formatChord,
  type Chord,
} from "../lib/chord";
import { isMac } from "../lib/platform";

// Which heading each id prefix files under, and the order the headings appear
// in. Keyed off the prefix rather than a field on the spec so the keymap stays
// a table of behaviour and this stays a decision about the panel.
const GROUPS: { title: string; prefixes: string[] }[] = [
  { title: "Window & app", prefixes: ["window", "app", "settings", "sidebar"] },
  { title: "Tabs", prefixes: ["tab"] },
  { title: "Panes", prefixes: ["split", "pane"] },
  { title: "Terminal", prefixes: ["terminal", "font"] },
  { title: "Clipboard", prefixes: ["clipboard"] },
];
const OTHER = "Other";

function groupTitle(id: string): string {
  const prefix = id.split(".")[0];
  return GROUPS.find((g) => g.prefixes.includes(prefix))?.title ?? OTHER;
}

interface Row {
  spec: BindingSpec;
  chord: Chord | null;
  overridden: boolean;
  // Actions that answer to the same chord. The dispatcher walks the keymap in
  // registration order and stops at the first match, so everything after the
  // first entry here is a shortcut that cannot fire.
  conflictsWith: string[];
  shadowed: boolean;
}

export default function KeybindingsSettings(): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [recordingId, setRecordingId] = createSignal<string | null>(null);
  const [recordError, setRecordError] = createSignal<string | null>(null);

  // Every registered row, resolved and cross-checked for collisions. One memo
  // so the conflict pass runs once per change rather than once per row.
  const rows = createMemo<Row[]>(() => {
    const specs = keymapSpecs();
    const ov = overrides();

    const bySignature = new Map<string, BindingSpec[]>();
    const resolved = specs.map((spec) => {
      const chord = activeChord(spec);
      if (chord) {
        const sig = chordSignature(chord);
        const list = bySignature.get(sig);
        if (list) list.push(spec);
        else bySignature.set(sig, [spec]);
      }
      return { spec, chord };
    });

    return resolved.map(({ spec, chord }) => {
      const sharing = chord ? (bySignature.get(chordSignature(chord)) ?? []) : [];
      const others = sharing.filter((s) => s.id !== spec.id);
      return {
        spec,
        chord,
        overridden: spec.id in ov,
        conflictsWith: others.map((s) => s.label ?? s.id),
        // Only the first registered row of a colliding set actually runs.
        shadowed: others.length > 0 && sharing[0]?.id !== spec.id,
      };
    });
  });

  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase();
    if (!q) return rows();
    return rows().filter((r) => {
      const chord = r.chord ? formatChord(r.chord).toLowerCase() : "off";
      return (
        (r.spec.label ?? r.spec.id).toLowerCase().includes(q) ||
        r.spec.id.toLowerCase().includes(q) ||
        chord.includes(q)
      );
    });
  });

  // Grouped for display, empty groups dropped so a filter never leaves a
  // heading standing over nothing.
  const grouped = createMemo(() => {
    const order = [...GROUPS.map((g) => g.title), OTHER];
    const buckets = new Map<string, Row[]>();
    for (const row of filtered()) {
      const title = groupTitle(row.spec.id);
      const bucket = buckets.get(title);
      if (bucket) bucket.push(row);
      else buckets.set(title, [row]);
    }
    return order
      .filter((title) => buckets.has(title))
      .map((title) => ({ title, rows: buckets.get(title)! }));
  });

  // --- recording -----------------------------------------------------------
  // The dispatcher is told to stand down for the duration (see
  // setKeybindingCapture), so the keystroke arrives here whole even when it is
  // currently bound to something. Listening on window in the capture phase for
  // the same reason the panel's own Esc handler does: the terminal may still
  // hold focus, and xterm stops some keys from propagating.
  let stopRecording: (() => void) | null = null;

  function cancelRecording() {
    stopRecording?.();
  }

  function beginRecording(id: string) {
    if (recordingId() === id) {
      cancelRecording();
      return;
    }
    cancelRecording();
    setRecordError(null);
    setRecordingId(id);
    setKeybindingCapture(true);

    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        stopRecording?.();
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        setOverride(id, null);
        stopRecording?.();
        return;
      }

      const chord = chordFromEvent(e);
      // Still only modifiers down — wait for the key they belong to.
      if (!chord) return;

      if (chordStealsFromTerminal(chord)) {
        setRecordError(
          `${formatChord(chord)} belongs to the shell. ${
            isMac
              ? "Use ⌘ or ⌥ instead"
              : "Add Shift, or use Alt instead"
          }, so the terminal keeps its control codes.`
        );
        return;
      }

      const spec = keymapSpecs().find((s) => s.id === id);
      if (spec && chordsEqual(chord, defaultChord(spec))) {
        // Recording a row's own default is how you undo an override without
        // hunting for the Reset link.
        clearOverride(id);
      } else {
        setOverride(id, chord);
      }
      stopRecording?.();
    };

    window.addEventListener("keydown", onKeyDown, true);
    stopRecording = () => {
      window.removeEventListener("keydown", onKeyDown, true);
      setKeybindingCapture(false);
      setRecordingId(null);
      stopRecording = null;
    };
  }

  // The panel unmounts every time the sidebar closes; a recorder left armed
  // would swallow the keyboard with no way left on screen to release it.
  onCleanup(() => cancelRecording());

  return (
    <div class="settings-section keybindings">
      <div class="settings-row">
        <span class="settings-label">Shortcuts</span>
        <Show when={overrideCount() > 0}>
          <button
            class="settings-reset"
            onClick={() => {
              cancelRecording();
              setRecordError(null);
              resetAllOverrides();
            }}
          >
            Reset all
          </button>
        </Show>
      </div>

      <input
        class="settings-search"
        type="text"
        placeholder="Filter shortcuts…"
        value={query()}
        onInput={(e) => setQuery(e.currentTarget.value)}
      />

      <Show when={recordError()}>
        <div class="settings-error">{recordError()}</div>
      </Show>

      <div class="keybinding-list">
        <For each={grouped()}>
          {(group) => (
            <>
              <div class="keybinding-group">{group.title}</div>
              <For each={group.rows}>
                {(row) => (
                  <div
                    class="keybinding-entry"
                    classList={{ shadowed: row.shadowed, off: !row.chord }}
                  >
                    {/* The name ellipsizes rather than wrapping: the chord is
                        the control, and a sidebar this narrow would otherwise
                        push half of them onto a line of their own. The full
                        label is in the tooltip. */}
                    <div class="keybinding-row">
                      <span
                        class="keybinding-name"
                        title={`${row.spec.label ?? row.spec.id} (${row.spec.id})`}
                      >
                        {row.spec.label ?? row.spec.id}
                      </span>
                      <Show when={row.overridden}>
                        <button
                          class="keybinding-revert"
                          title="Back to the default"
                          aria-label={`Reset ${row.spec.label ?? row.spec.id} to its default`}
                          onClick={() => {
                            cancelRecording();
                            clearOverride(row.spec.id);
                          }}
                        >
                          ↺
                        </button>
                      </Show>
                      <button
                        class="keybinding-chord"
                        classList={{
                          recording: recordingId() === row.spec.id,
                          custom: row.overridden,
                        }}
                        aria-label={`${row.spec.label ?? row.spec.id}: ${
                          row.chord ? formatChord(row.chord) : "off"
                        }. Activate to record a new shortcut.`}
                        onClick={() => beginRecording(row.spec.id)}
                        onBlur={() => {
                          if (recordingId() === row.spec.id) cancelRecording();
                        }}
                      >
                        {recordingId() === row.spec.id
                          ? "Press keys…"
                          : row.chord
                            ? formatChord(row.chord)
                            : "Off"}
                      </button>
                    </div>
                    <Show when={row.conflictsWith.length > 0}>
                      <div class="keybinding-conflict">
                        {row.shadowed ? "Taken by" : "Shared with"}{" "}
                        {row.conflictsWith.join(", ")}
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </>
          )}
        </For>
        <Show when={grouped().length === 0}>
          <div class="settings-hint">No shortcut matches “{query()}”.</div>
        </Show>
      </div>

      <p class="settings-hint">
        Click a shortcut and press the keys you want. <strong>Backspace</strong>{" "}
        switches it off and hands the keys back to the terminal;{" "}
        <strong>Esc</strong> leaves it alone. Pressing a row's original chord
        clears the override.
      </p>
      <p class="settings-hint">
        Bare keys and lone <code>Ctrl+&lt;key&gt;</code> chords are refused on
        purpose — those are control codes the shell and everything running in it
        expect to receive. Function keys are fine; they carry none.
      </p>
    </div>
  );
}
