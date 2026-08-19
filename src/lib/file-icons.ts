// Per-type glyphs for the file tree.
//
// The tree drew three icons: a folder, file-text for .md, and a blank sheet for
// everything else. That is enough to tell a directory from a file and nothing
// more — a .png, a .zip and a .rs all arrive as the same sheet, so the only way
// to read a listing is to read every name in it. Lucide ships whole file-* and
// folder-* families on the same grid and stroke as the rest of the chrome, so a
// row can carry its type without introducing a second visual language.
//
// Conventions follow lib/icons: per-icon imports, never the package root. This
// set rides in the boot bundle because App imports FileTree eagerly and the
// sidebar can be open on the first frame; each icon is a ~250-byte module, so
// the whole table below is a few kilobytes.
//
// The mapping is deliberately coarse. A distinct glyph per language is what
// icon *themes* are for; the goal here is a listing that skims — code, config,
// image, archive — not a badge that names the compiler. Anything unmapped
// falls back to the plain sheet, which is what every file looked like before.

import IconFile from "lucide-solid/icons/file";
import IconFileArchive from "lucide-solid/icons/file-archive";
import IconFileBadge from "lucide-solid/icons/file-badge";
import IconFileBox from "lucide-solid/icons/file-box";
import IconFileCode from "lucide-solid/icons/file-code";
import IconFileCog from "lucide-solid/icons/file-cog";
import IconFileDiff from "lucide-solid/icons/file-diff";
import IconFileImage from "lucide-solid/icons/file-image";
import IconFileJson from "lucide-solid/icons/file-json";
import IconFileKey from "lucide-solid/icons/file-key";
import IconFileLock from "lucide-solid/icons/file-lock";
import IconFileMusic from "lucide-solid/icons/file-music";
import IconFileSpreadsheet from "lucide-solid/icons/file-spreadsheet";
import IconFileTerminal from "lucide-solid/icons/file-terminal";
import IconFileText from "lucide-solid/icons/file-text";
import IconFileType from "lucide-solid/icons/file-type";
import IconFileVideo from "lucide-solid/icons/file-video";
import IconFolder from "lucide-solid/icons/folder";
import IconFolderArchive from "lucide-solid/icons/folder-archive";
import IconFolderCheck from "lucide-solid/icons/folder-check";
import IconFolderCode from "lucide-solid/icons/folder-code";
import IconFolderCog from "lucide-solid/icons/folder-cog";
import IconFolderDot from "lucide-solid/icons/folder-dot";
import IconFolderGit from "lucide-solid/icons/folder-git-2";

// Every entry in the tables below is one of these: a Lucide icon component,
// which takes the same `size` / `stroke-width` props the rest of the chrome
// passes. Derived from an import so the tables cannot drift from the package.
export type FileIcon = typeof IconFile;

// Extension -> glyph, keyed lowercase and without the dot. Grouped by what the
// glyph means rather than alphabetically, so adding a language lands next to
// its neighbours.
const BY_EXTENSION: Record<string, FileIcon> = {
  // Source, including markup and stylesheets — anything you would open to edit.
  ts: IconFileCode,
  tsx: IconFileCode,
  js: IconFileCode,
  jsx: IconFileCode,
  mjs: IconFileCode,
  cjs: IconFileCode,
  mts: IconFileCode,
  cts: IconFileCode,
  py: IconFileCode,
  rs: IconFileCode,
  go: IconFileCode,
  java: IconFileCode,
  kt: IconFileCode,
  kts: IconFileCode,
  c: IconFileCode,
  h: IconFileCode,
  cc: IconFileCode,
  cpp: IconFileCode,
  hpp: IconFileCode,
  cs: IconFileCode,
  rb: IconFileCode,
  php: IconFileCode,
  swift: IconFileCode,
  scala: IconFileCode,
  lua: IconFileCode,
  dart: IconFileCode,
  ex: IconFileCode,
  exs: IconFileCode,
  erl: IconFileCode,
  hs: IconFileCode,
  zig: IconFileCode,
  vue: IconFileCode,
  svelte: IconFileCode,
  sql: IconFileCode,
  html: IconFileCode,
  htm: IconFileCode,
  xml: IconFileCode,
  css: IconFileCode,
  scss: IconFileCode,
  sass: IconFileCode,
  less: IconFileCode,

  // Shells — code too, but the terminal glyph is the more useful distinction in
  // an app that is itself a terminal.
  sh: IconFileTerminal,
  bash: IconFileTerminal,
  zsh: IconFileTerminal,
  fish: IconFileTerminal,
  ps1: IconFileTerminal,
  bat: IconFileTerminal,
  cmd: IconFileTerminal,

  json: IconFileJson,
  jsonc: IconFileJson,
  json5: IconFileJson,

  // Configuration and environment.
  yaml: IconFileCog,
  yml: IconFileCog,
  toml: IconFileCog,
  ini: IconFileCog,
  cfg: IconFileCog,
  conf: IconFileCog,
  properties: IconFileCog,
  env: IconFileCog,

  // Prose. Markdown keeps the icon it already had.
  md: IconFileText,
  mdx: IconFileText,
  markdown: IconFileText,
  txt: IconFileText,
  text: IconFileText,
  rst: IconFileText,
  adoc: IconFileText,
  log: IconFileText,
  pdf: IconFileText,
  doc: IconFileText,
  docx: IconFileText,
  odt: IconFileText,
  rtf: IconFileText,
  epub: IconFileText,

  // Fonts get the typography glyph — the one place "type" means a typeface.
  ttf: IconFileType,
  otf: IconFileType,
  woff: IconFileType,
  woff2: IconFileType,
  eot: IconFileType,

  png: IconFileImage,
  jpg: IconFileImage,
  jpeg: IconFileImage,
  gif: IconFileImage,
  webp: IconFileImage,
  avif: IconFileImage,
  bmp: IconFileImage,
  ico: IconFileImage,
  tif: IconFileImage,
  tiff: IconFileImage,
  heic: IconFileImage,
  heif: IconFileImage,
  svg: IconFileImage,
  psd: IconFileImage,

  mp4: IconFileVideo,
  mkv: IconFileVideo,
  mov: IconFileVideo,
  webm: IconFileVideo,
  avi: IconFileVideo,
  m4v: IconFileVideo,
  wmv: IconFileVideo,
  flv: IconFileVideo,

  mp3: IconFileMusic,
  wav: IconFileMusic,
  flac: IconFileMusic,
  ogg: IconFileMusic,
  m4a: IconFileMusic,
  aac: IconFileMusic,
  opus: IconFileMusic,
  mid: IconFileMusic,

  zip: IconFileArchive,
  tar: IconFileArchive,
  gz: IconFileArchive,
  tgz: IconFileArchive,
  bz2: IconFileArchive,
  xz: IconFileArchive,
  zst: IconFileArchive,
  "7z": IconFileArchive,
  rar: IconFileArchive,
  jar: IconFileArchive,
  war: IconFileArchive,
  iso: IconFileArchive,

  csv: IconFileSpreadsheet,
  tsv: IconFileSpreadsheet,
  xls: IconFileSpreadsheet,
  xlsx: IconFileSpreadsheet,
  ods: IconFileSpreadsheet,

  // Compiled output and installable packages — files you move, not files you
  // open.
  exe: IconFileBox,
  msi: IconFileBox,
  dll: IconFileBox,
  so: IconFileBox,
  dylib: IconFileBox,
  wasm: IconFileBox,
  bin: IconFileBox,
  deb: IconFileBox,
  rpm: IconFileBox,
  dmg: IconFileBox,
  appimage: IconFileBox,
  apk: IconFileBox,
  pkg: IconFileBox,
  class: IconFileBox,
  pyc: IconFileBox,
  o: IconFileBox,

  // Keys and certificates, worth spotting at a glance before you cat one into a
  // shared terminal.
  pem: IconFileKey,
  key: IconFileKey,
  crt: IconFileKey,
  cer: IconFileKey,
  pfx: IconFileKey,
  p12: IconFileKey,
  gpg: IconFileKey,
  asc: IconFileKey,

  lock: IconFileLock,
  diff: IconFileDiff,
  patch: IconFileDiff,
};

// Whole filenames whose type no extension would reveal. Checked before the
// extension table, so package-lock.json reads as a lockfile rather than as JSON.
const BY_NAME: Record<string, FileIcon> = {
  dockerfile: IconFileBox,
  containerfile: IconFileBox,
  makefile: IconFileCog,
  justfile: IconFileCog,
  "cmakelists.txt": IconFileCog,
  ".gitignore": IconFileCog,
  ".gitattributes": IconFileCog,
  ".gitmodules": IconFileCog,
  ".npmignore": IconFileCog,
  ".dockerignore": IconFileCog,
  ".editorconfig": IconFileCog,
  ".npmrc": IconFileCog,
  ".nvmrc": IconFileCog,
  ".env": IconFileCog,
  "package-lock.json": IconFileLock,
  license: IconFileBadge,
  licence: IconFileBadge,
  "license.md": IconFileBadge,
  "license.txt": IconFileBadge,
  copying: IconFileBadge,
  notice: IconFileBadge,
};

// Directory names that mean the same thing in most repositories. Everything
// else falls through to the plain folder, except dot-directories, which get the
// dotted variant — they are the ones you scroll past, not into.
const BY_FOLDER_NAME: Record<string, FileIcon> = {
  ".git": IconFolderGit,

  src: IconFolderCode,
  lib: IconFolderCode,
  app: IconFolderCode,
  components: IconFolderCode,
  packages: IconFolderCode,

  test: IconFolderCheck,
  tests: IconFolderCheck,
  __tests__: IconFolderCheck,
  spec: IconFolderCheck,
  e2e: IconFolderCheck,

  // Vendored or generated: present in the listing, rarely the thing you came
  // for.
  node_modules: IconFolderArchive,
  vendor: IconFolderArchive,
  venv: IconFolderArchive,
  ".venv": IconFolderArchive,
  __pycache__: IconFolderArchive,
  dist: IconFolderArchive,
  build: IconFolderArchive,
  out: IconFolderArchive,
  target: IconFolderArchive,

  config: IconFolderCog,
  ".config": IconFolderCog,
  ".github": IconFolderCog,
  ".vscode": IconFolderCog,
  scripts: IconFolderCog,
  bin: IconFolderCog,
};

export function fileIcon(name: string): FileIcon {
  const lower = name.toLowerCase();
  const byName = BY_NAME[lower];
  if (byName) return byName;
  // A leading dot marks a hidden file, it does not introduce an extension:
  // ".gitignore" has none, while ".eslintrc.json" has "json". Hence lastIndexOf
  // and the `<= 0` guard rather than a split.
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return IconFile;
  return BY_EXTENSION[lower.slice(dot + 1)] ?? IconFile;
}

export function folderIcon(name: string): FileIcon {
  const lower = name.toLowerCase();
  const known = BY_FOLDER_NAME[lower];
  if (known) return known;
  return lower.startsWith(".") ? IconFolderDot : IconFolder;
}

// What the tree actually calls: one lookup per row, resolved once when the row
// is created rather than on every render.
export function entryIcon(entry: { name: string; isDirectory: boolean }): FileIcon {
  return entry.isDirectory ? folderIcon(entry.name) : fileIcon(entry.name);
}
