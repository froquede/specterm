// What happens when files from the OS are dropped on the window.
//
// The routing is by kind, not by one blanket rule, because the useful answer is
// different for each: a markdown file wants the preview pane, an image wants to
// end up in whatever is reading the prompt (Claude, an ffmpeg line you are half
// way through typing), a folder wants a `cd`, and an archive wants neither — its
// path at the prompt is the only thing anyone could do with it.
//
// Classification is extension-first: it's synchronous, which the drop handler
// needs (a DataTransfer dies with its event), and predictable, which matters
// more than being clever about a file whose extension lies. The MIME type the
// OS attaches is used only as a second opinion for images, where it is reliable
// and the extension list can't be exhaustive.

import { languageHint } from "./textview";

export type DropKind =
  /** A directory: `cd` into it in the pane that received the drop. */
  | "directory"
  /** An image: its path goes into the prompt, unexecuted. */
  | "image"
  /** Markdown: opens the rendered preview in a new pane. */
  | "markdown"
  /** Might be a base16 scheme — the caller parses it to find out. */
  | "theme"
  /** Text or code: opens the read-only viewer in a new pane. */
  | "text"
  /** Anything else (binaries, archives, PDFs): path into the prompt. */
  | "path";

const MARKDOWN_RE = /\.(md|markdown|mdx)$/i;
const THEME_RE = /\.(ya?ml|json|txt)$/i;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|avif|heic|heif|ico|tiff?)$/i;
// SVG is deliberately absent: it is markup, opens fine in the text viewer, and
// is far more often dropped to be read than to be handed to a model.

// Text-ish extensions that carry no highlight.js hint (languageHint covers the
// ~50 code extensions; these are the plain-prose and data ones it doesn't).
const TEXT_RE =
  /\.(txt|log|csv|tsv|text|rst|adoc|asciidoc|lock|properties|editorconfig|gitattributes|gitmodules|npmrc|nvmrc)$/i;

export interface DroppedFile {
  /** Absolute path, or null when the host couldn't resolve one. */
  path: string | null;
  /** The OS-reported MIME type — often empty for code files, so only a hint. */
  mime: string;
  isDirectory: boolean;
}

export function classifyDrop(file: DroppedFile): DropKind {
  if (file.isDirectory) return "directory";
  const path = file.path ?? "";
  if (file.mime.startsWith("image/") || IMAGE_RE.test(path)) return "image";
  if (MARKDOWN_RE.test(path)) return "markdown";
  if (THEME_RE.test(path)) return "theme";
  if (
    file.mime.startsWith("text/") ||
    TEXT_RE.test(path) ||
    languageHint(path) !== null
  ) {
    return "text";
  }
  return "path";
}
