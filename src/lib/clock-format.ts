// Formatting for the tab-bar clock.
//
// A small token language rather than a locale preset, because the point of the
// clock is that it's yours: `HH:mm` for most people, `ddd DD/MM HH:mm` for
// someone who loses track of the date, `HH:mm:ss` for someone timing things.
//
// Tokens are matched in a single pass, longest first. That matters: replacing
// them one at a time would let an earlier substitution be re-matched by a later
// token (the `mm` in a month name, the `a` in "Sat"), which is the classic way
// these formatters produce nonsense a few times a year.
//
// Anything that isn't a token passes through as-is. Text that would otherwise be
// eaten can be escaped in square brackets: `[at] HH:mm` renders "at 14:30".

const TOKEN = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DD|D|HH|H|hh|h|mm|m|ss|s|A|a/g;

const pad = (n: number) => String(n).padStart(2, "0");

// Weekday and month names follow the OS locale rather than being hardcoded to
// English — the same clock reads "seg 28/07" or "Mon 28/07" depending on who's
// looking at it.
const named = (d: Date, opts: Intl.DateTimeFormatOptions) => {
  try {
    return d.toLocaleDateString(undefined, opts);
  } catch (_) {
    // A runtime without full ICU — fall back to something readable rather than
    // letting the whole clock throw.
    return "";
  }
};

/** True when a format needs sub-minute updates, i.e. it shows seconds. */
export function showsSeconds(format: string): boolean {
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(format)) !== null) {
    // A bracketed literal is text, not a token — `[seconds]` doesn't tick.
    if (m[1] !== undefined) continue;
    if (m[0] === "ss" || m[0] === "s") return true;
  }
  return false;
}

export function formatClock(format: string, now: Date): string {
  return format.replace(TOKEN, (match, literal?: string) => {
    if (literal !== undefined) return literal;

    const h24 = now.getHours();
    const h12 = h24 % 12 || 12;

    switch (match) {
      case "YYYY": return String(now.getFullYear());
      case "YY": return pad(now.getFullYear() % 100);
      case "MMMM": return named(now, { month: "long" });
      case "MMM": return named(now, { month: "short" });
      case "MM": return pad(now.getMonth() + 1);
      case "M": return String(now.getMonth() + 1);
      case "dddd": return named(now, { weekday: "long" });
      case "ddd": return named(now, { weekday: "short" });
      case "DD": return pad(now.getDate());
      case "D": return String(now.getDate());
      case "HH": return pad(h24);
      case "H": return String(h24);
      case "hh": return pad(h12);
      case "h": return String(h12);
      case "mm": return pad(now.getMinutes());
      case "m": return String(now.getMinutes());
      case "ss": return pad(now.getSeconds());
      case "s": return String(now.getSeconds());
      case "A": return h24 < 12 ? "AM" : "PM";
      case "a": return h24 < 12 ? "am" : "pm";
      default: return match;
    }
  });
}

/**
 * How long until the displayed value would change.
 *
 * The clock schedules itself against this instead of ticking on a fixed
 * interval, for two reasons. A minute-granularity clock wakes up once a minute
 * rather than sixty times to redraw the same string. And aligning to the
 * boundary means the minute flips *when it flips* — a plain 60s interval drifts
 * off the real minute by however late the first tick was, and then stays wrong.
 */
export function msUntilNextChange(format: string, now: Date): number {
  const ms = now.getMilliseconds();
  if (showsSeconds(format)) return 1000 - ms;
  return (60 - now.getSeconds()) * 1000 - ms;
}
