// The app's icon set, in one place.
//
// Every glyph in the chrome used to be a literal character — ◧ ▯ ⊞ ⊡ ⠿ ★ ↻ ▸ —
// or a hand-copied SVG path. Both have the same problem: they are drawn by
// whatever font happened to have that codepoint, at whatever weight and optical
// size that font chose, so no two of them matched and several rendered as tofu
// on systems whose monospace font lacks the block. This module replaces them
// with [Lucide](https://lucide.dev) — one grid, one stroke weight, one join
// style — so the chrome reads as a set.
//
// Imports are per-icon (`lucide-solid/icons/<name>`), never from the package
// root. The root is a barrel over ~1,600 icons: importing from it makes Vite
// pre-bundle the lot in dev and leans on tree-shaking to undo it in the build.
// A per-icon path pulls in exactly one ~250-byte module plus the shared <Icon>
// renderer, and nothing else exists to shake out.
//
// lucide-solid is a *dev* dependency on purpose. Vite inlines what we import
// into the renderer bundle, so nothing needs it at runtime — and since
// electron-builder packs `node_modules/**` into the app, listing it as a
// runtime dependency would ship 77 MB of unused icon sources in every build.
//
// Two tiers, and the split is about the first frame rather than about size:
//
//   this module — the chrome that paints immediately: the tab bar, the window
//                 controls, the pane title-bars. A dynamic import here would
//                 mean a visible frame with holes where the icons go.
//   icons-lazy  — everything reachable only from a panel that is itself lazily
//                 mounted (settings). It rides in that panel's chunk, so it
//                 costs a launch that never opens settings nothing at all.

export { default as IconSidebarOpen } from "lucide-solid/icons/panel-left-open";
export { default as IconSidebarClose } from "lucide-solid/icons/panel-left-close";
export { default as IconPlus } from "lucide-solid/icons/plus";
export { default as IconFullscreen } from "lucide-solid/icons/maximize";
export { default as IconFullscreenExit } from "lucide-solid/icons/minimize";
export { default as IconSettings } from "lucide-solid/icons/settings";
export { default as IconX } from "lucide-solid/icons/x";
export { default as IconMinus } from "lucide-solid/icons/minus";
export { default as IconSquare } from "lucide-solid/icons/square";
export { default as IconRestore } from "lucide-solid/icons/copy";
export { default as IconGrip } from "lucide-solid/icons/grip-vertical";
export { default as IconSplitToggle } from "lucide-solid/icons/move-horizontal";
export { default as IconChevronUp } from "lucide-solid/icons/chevron-up";
export { default as IconChevronDown } from "lucide-solid/icons/chevron-down";
export { default as IconChevronRight } from "lucide-solid/icons/chevron-right";
export { default as IconArrowLeft } from "lucide-solid/icons/arrow-left";
export { default as IconLevelUp } from "lucide-solid/icons/corner-left-up";
export { default as IconStar } from "lucide-solid/icons/star";
export { default as IconRefresh } from "lucide-solid/icons/refresh-cw";
export { default as IconFile } from "lucide-solid/icons/file";
export { default as IconMarkdown } from "lucide-solid/icons/file-text";
export { default as IconFolder } from "lucide-solid/icons/folder";
export { default as IconDrive } from "lucide-solid/icons/hard-drive";
export { default as IconReveal } from "lucide-solid/icons/external-link";
export { default as IconCdHere } from "lucide-solid/icons/square-terminal";
export { default as IconSave } from "lucide-solid/icons/save";
export { default as IconEdit } from "lucide-solid/icons/pencil";
export { default as IconPreview } from "lucide-solid/icons/eye";

// Default geometry for chrome icons. Lucide draws on a 24px grid at
// stroke-width 2; at the 14–16px these render at, 2 is heavy enough to fill in
// the counters of the denser glyphs, so the whole set steps down to 1.75.
export const ICON_SIZE = 15;
export const ICON_STROKE = 1.75;
