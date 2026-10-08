// The editing chords of a plain text field on macOS — ⌘V, ⌘C, ⌘X, ⌘A, ⌘Z and
// ⌘⇧Z in an <input> or <textarea>.
//
// The app ships no Edit menu on purpose (see buildAppMenu in electron/main.cjs):
// its accelerators would claim ⌘C/⌘V before the terminal sees them. On macOS,
// though, a text field's native cut/copy/paste, select-all and undo come from
// exactly that menu, so in the plugin URL box, the sidebar filter, a find bar or
// any settings field those keys did nothing at all. The terminal (the clipboard
// rows in stores/keymap.ts) and the markdown editor (lib/markdown-editor.ts)
// already route their own; this does the same for every other text field,
// through the same host clipboard bridge.
//
// Windows and Linux are left alone: Blink handles Ctrl+C/V/X/A/Z in a text
// field itself there, and doing it here as well would paste twice.

import { chordMatchesEvent, type Chord } from "./chord";
import { os } from "./platform";
import { clipboardReadText, clipboardWriteText } from "./pty";

type TextField = HTMLInputElement | HTMLTextAreaElement;
type Edit = "paste" | "copy" | "cut" | "selectAll" | "undo" | "redo";

const EDITS: readonly (readonly [Chord, Edit])[] = [
  [{ key: "v", meta: true }, "paste"],
  [{ key: "c", meta: true }, "copy"],
  [{ key: "x", meta: true }, "cut"],
  [{ key: "a", meta: true }, "selectAll"],
  [{ key: "z", meta: true }, "undo"],
  [{ key: "z", meta: true, shift: true }, "redo"],
];

// The <input> types that hold editable text. A checkbox or a slider is an
// <input> too, but has nothing to select or paste into.
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email", "password", "number"]);

function asTextField(target: EventTarget | null): TextField | null {
  if (target instanceof HTMLTextAreaElement) return target;
  if (target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type)) return target;
  return null;
}

function selectedText(field: TextField): string {
  const { selectionStart: start, selectionEnd: end } = field;
  // email and number fields expose no selection range; the document's does.
  if (start === null || end === null) return window.getSelection()?.toString() ?? "";
  return field.value.slice(start, end);
}

async function pasteInto(field: TextField) {
  let text = await clipboardReadText();
  // The read is async: if focus moved meanwhile, the text is not for this field.
  if (!text || document.activeElement !== field) return;
  // A single-line field has no line breaks; Blink's own paste drops them too.
  if (field instanceof HTMLInputElement) text = text.replace(/[\r\n]+/g, "");
  // insertText rather than assigning .value: it replaces the selection, keeps
  // the field's undo history, and fires the input event its component listens
  // to — the same things a native paste does.
  document.execCommand("insertText", false, text);
}

/**
 * Run the editing chord `e` in the text field it was pressed in. Returns true
 * when the key was one, so the caller can preventDefault it: a stand-in for
 * the menu (Playwright sends one on macOS) must not do it a second time.
 */
export function editTextField(e: KeyboardEvent): boolean {
  if (os !== "mac" || e.isComposing) return false;
  const field = asTextField(e.target);
  if (!field) return false;
  const edit = EDITS.find(([chord]) => chordMatchesEvent(chord, e))?.[1];
  if (!edit) return false;

  // A password never leaves its field, as in any other Mac app.
  const secret = field instanceof HTMLInputElement && field.type === "password";
  const writable = !field.readOnly && !field.disabled;
  switch (edit) {
    case "paste":
      if (writable) void pasteInto(field);
      break;
    case "copy": {
      const text = secret ? "" : selectedText(field);
      if (text) void clipboardWriteText(text);
      break;
    }
    case "cut": {
      const text = secret ? "" : selectedText(field);
      if (!text || !writable) break;
      void clipboardWriteText(text);
      document.execCommand("delete");
      break;
    }
    case "selectAll":
      field.select();
      break;
    case "undo":
    case "redo":
      if (writable) document.execCommand(edit);
      break;
  }
  return true;
}
