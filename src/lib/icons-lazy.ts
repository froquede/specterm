// Icons reachable only from a lazily-mounted panel (Settings, GitHub).
//
// Kept apart from lib/icons purely so they ride in the settings chunk (App
// imports SettingsPanel lazily) instead of the boot bundle. Nothing about a
// launch that never opens settings should pay for the pictures on its category
// headers. Same set, same conventions — see lib/icons for why Lucide, why
// per-icon imports, and why it is a dev dependency.

export { default as IconAppearance } from "lucide-solid/icons/palette";
export { default as IconLayout } from "lucide-solid/icons/layout-panel-left";
export { default as IconTerminal } from "lucide-solid/icons/square-terminal";
export { default as IconKeyboard } from "lucide-solid/icons/keyboard";
export { default as IconSessions } from "lucide-solid/icons/history";
export { default as IconUpdates } from "lucide-solid/icons/download";
export { default as IconPlugins } from "lucide-solid/icons/plug";
export { default as IconArrowRight } from "lucide-solid/icons/arrow-right";
