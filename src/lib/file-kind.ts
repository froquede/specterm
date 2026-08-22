// What clicking a file in the tree actually does.
//
// App routes an opened path three ways — markdown to the rendered preview, an
// image to the image viewer, everything else to the read-only text viewer — and
// the sidebar has to paint a row *before* any of that happens. This module is
// the one place that answers "what will this file become", so the two cannot
// drift: App imports the same predicates it used to define inline.
//
// Extension-only, deliberately. Deciding by content would mean a read per row on
// every listing, and the viewer sniffs the real bytes anyway — TextPane refuses
// what turns out to be binary. So the classification here is a *promise about
// the likely outcome*, not a guarantee, and it errs optimistic: an extension
// nobody listed is assumed to be text, which is what "open it and see" already
// did before any of this existed.

export type FileKind =
  // Rendered preview, and the only kind that can be edited.
  | "markdown"
  // Image viewer: zoom, pan, no text at all.
  | "image"
  // Read-only text viewer, with highlighting where the language is known.
  | "text"
  // Opens, and the viewer says it can't preview it. Source, config and prose
  // all land in "text"; this is the tier that exists so the tree can say so up
  // front rather than pretending every row leads somewhere.
  | "binary";

export const isMarkdownPath = (p: string) => /\.(md|markdown)$/i.test(p);
export const isImagePath = (p: string) =>
  /\.(png|jpe?g|gif|svg|webp|bmp|ico|avif)$/i.test(p);

// Containers, compiled output, and media the app has no viewer for. Kept
// explicit rather than derived from the icon table: an icon is about what a
// file *is*, this is about what happens when you click it, and the two only
// look alike until something like .pdf shows up — a document by its glyph,
// bytes the text viewer will refuse by its behaviour.
const BINARY = new Set([
  // archives
  "zip", "tar", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "jar", "war", "iso",
  // executables, libraries, compiled output
  "exe", "msi", "dll", "so", "dylib", "wasm", "bin", "o", "a", "class", "pyc",
  "deb", "rpm", "dmg", "appimage", "apk", "pkg",
  // media without a viewer
  "mp4", "mkv", "mov", "webm", "avi", "m4v", "wmv", "flv",
  "mp3", "wav", "flac", "ogg", "m4a", "aac", "opus", "wma", "mid",
  // fonts
  "ttf", "otf", "woff", "woff2", "eot",
  // documents that are archives or streams wearing a document's name
  "pdf", "doc", "docx", "odt", "xls", "xlsx", "ods", "ppt", "pptx", "epub",
  // images the image viewer doesn't take
  "psd", "tif", "tiff", "heic", "heif",
]);

export function fileKind(nameOrPath: string): FileKind {
  if (isMarkdownPath(nameOrPath)) return "markdown";
  if (isImagePath(nameOrPath)) return "image";
  const lower = nameOrPath.toLowerCase();
  const dot = lower.lastIndexOf(".");
  // Same rule as the icon table: a leading dot is the hidden-file marker, not
  // an extension. Extensionless files (Makefile, LICENSE, a shell script) are
  // text far more often than not.
  if (dot <= 0) return "text";
  return BINARY.has(lower.slice(dot + 1)) ? "binary" : "text";
}
