// The icons a plugin may put on the tab bar or a sidebar view, by name.
//
// A plugin names one of these in its manifest rather than shipping its own: the
// tab bar paints on the first frame, before any plugin code has loaded, and every
// glyph in the chrome has to come from the one Lucide set (see icons.ts for why).
// Eager for the same reason icons.ts is — each is a ~250-byte module. An unknown
// name falls back to the plug, so a manifest written for a newer Specterm still
// draws something.
import IconPlug from "lucide-solid/icons/plug";
import IconInbox from "lucide-solid/icons/inbox";
import IconBell from "lucide-solid/icons/bell";
import IconMessageSquare from "lucide-solid/icons/message-square";
import IconMail from "lucide-solid/icons/mail";
import IconListChecks from "lucide-solid/icons/list-checks";
import IconKanban from "lucide-solid/icons/kanban";
import IconCalendar from "lucide-solid/icons/calendar";
import IconActivity from "lucide-solid/icons/activity";
import IconBot from "lucide-solid/icons/bot";
import IconNotebookPen from "lucide-solid/icons/notebook-pen";
import IconGitPullRequest from "lucide-solid/icons/git-pull-request";
import IconGitBranch from "lucide-solid/icons/git-branch";
import IconLibraryBig from "lucide-solid/icons/library-big";
import IconCloud from "lucide-solid/icons/cloud";
import IconGauge from "lucide-solid/icons/gauge";

type IconComponent = typeof IconPlug;

const PLUGIN_ICONS: Record<string, IconComponent> = {
  plug: IconPlug,
  inbox: IconInbox,
  bell: IconBell,
  "message-square": IconMessageSquare,
  mail: IconMail,
  "list-checks": IconListChecks,
  kanban: IconKanban,
  calendar: IconCalendar,
  activity: IconActivity,
  bot: IconBot,
  "notebook-pen": IconNotebookPen,
  "git-pull-request": IconGitPullRequest,
  "git-branch": IconGitBranch,
  "library-big": IconLibraryBig,
  cloud: IconCloud,
  gauge: IconGauge,
};

export function pluginIcon(name: string): IconComponent {
  return PLUGIN_ICONS[name] ?? IconPlug;
}
