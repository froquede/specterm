import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import {
  IconBatteryCharging,
  IconBatteryFull,
  IconBatteryLow,
  IconBatteryMedium,
} from "../lib/icons";

// The Battery Status API isn't in the DOM typings (it's Chromium-only), so the
// slice of it this reads is declared here.
interface BatteryManager extends EventTarget {
  charging: boolean;
  chargingTime: number;
  dischargingTime: number;
  level: number;
}

type BatteryNavigator = Navigator & { getBattery?: () => Promise<BatteryManager> };

// Battery level beside the tab-bar clock.
//
// Mounted only while both the clock and this option are on (see Clock), so it
// follows the clock's rule: off means no listener at all. It doesn't poll —
// the browser fires `levelchange`/`chargingchange` when there is something new
// to show.
//
// It renders nothing where there's nothing honest to say: a runtime without the
// API (WebKit, i.e. the Tauri build), or a machine without a battery, which
// Chromium reports as "charging, 100%, full now, never empties". A laptop that
// is plugged in and full reads the same way and disappears too, which is fine —
// that's the one state nobody needs a reminder about.
export default function Battery() {
  const [level, setLevel] = createSignal<number | null>(null);
  const [charging, setCharging] = createSignal(false);

  onMount(() => {
    const getBattery = (navigator as BatteryNavigator).getBattery;
    if (!getBattery) return;

    let battery: BatteryManager | null = null;
    let disposed = false;

    const read = () => {
      if (!battery) return;
      const noBattery =
        battery.charging &&
        battery.level === 1 &&
        battery.chargingTime === 0 &&
        battery.dischargingTime === Infinity;
      setLevel(noBattery ? null : Math.round(battery.level * 100));
      setCharging(battery.charging);
    };

    getBattery
      .call(navigator)
      .then((b) => {
        if (disposed) return;
        battery = b;
        read();
        b.addEventListener("levelchange", read);
        b.addEventListener("chargingchange", read);
        b.addEventListener("chargingtimechange", read);
        b.addEventListener("dischargingtimechange", read);
      })
      .catch(() => {
        // Blocked or unsupported — leave it hidden rather than show a guess.
      });

    onCleanup(() => {
      disposed = true;
      if (!battery) return;
      battery.removeEventListener("levelchange", read);
      battery.removeEventListener("chargingchange", read);
      battery.removeEventListener("chargingtimechange", read);
      battery.removeEventListener("dischargingtimechange", read);
    });
  });

  // At 15% and falling the indicator takes the theme's danger colour: the whole
  // point of showing a battery in fullscreen is noticing before it runs out, and
  // a grey "12%" in the corner is easy to read past.
  const low = () => !charging() && (level() ?? 100) <= 15;

  // The glyph carries the level too, so it reads at a glance before the number
  // does. Thresholds match the bar count: one bar is "low", two "medium".
  const icon = () => {
    const l = level() ?? 0;
    if (charging()) return IconBatteryCharging;
    if (l <= 20) return IconBatteryLow;
    if (l <= 60) return IconBatteryMedium;
    return IconBatteryFull;
  };

  // 16px puts the battery body (8px of the 24-unit box) at the digits' cap
  // height at the bar's 12px text; smaller and it reads as a subscript.
  return (
    <Show when={level() !== null}>
      <span
        class="tab-battery"
        classList={{ low: low() }}
        title={charging() ? "Battery — charging" : "Battery"}
      >
        <Dynamic component={icon()} size={16} stroke-width={1.75} />
        {level()}%
      </span>
    </Show>
  );
}
