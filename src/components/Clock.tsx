import { createEffect, createSignal, onCleanup } from "solid-js";
import { clockFormat } from "../stores/settings";
import { formatClock, msUntilNextChange } from "../lib/clock-format";

// The tab-bar clock.
//
// Mounted only while the setting is on (see TabBar), so a user who doesn't want
// it has no timer, no signal and no component — the feature costs nothing when
// off, which is the only honest way to add a thing that would otherwise tick
// forever in a terminal.
//
// While it is on, it wakes exactly when the displayed text would change: once a
// minute for `HH:mm`, once a second only if the format actually shows seconds.
// And it stops entirely while the window is hidden — nobody is reading a clock
// they can't see — resyncing the moment it comes back, so it's never stale on
// screen.
export default function Clock() {
  const [text, setText] = createSignal("");

  // Keyed on the format: editing it in Settings tears this down and starts a
  // fresh schedule, so the bar updates on the keystroke rather than whenever the
  // old (possibly minute-long) timer happened to come round.
  createEffect(() => {
    const format = clockFormat();
    let timer: number | null = null;

    const stop = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const tick = () => {
      const now = new Date();
      setText(formatClock(format, now));
      timer = window.setTimeout(tick, msUntilNextChange(format, now));
    };

    const onVisibility = () => {
      stop();
      // Hidden: no reason to keep waking. Visible: redraw now, since the value
      // moved on while we were asleep, then resume the schedule.
      if (!document.hidden) tick();
    };

    tick();
    document.addEventListener("visibilitychange", onVisibility);

    onCleanup(() => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    });
  });

  // `tabular-nums` (in the stylesheet) keeps the digits from shifting width as
  // they change, which would otherwise jiggle the whole bar every minute.
  return (
    <div class="tab-clock" title="Clock — change the format in Settings">
      {text()}
    </div>
  );
}
