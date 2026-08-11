import { For } from "solid-js";
import { useGame } from "../state/gameObjects";
import { simSpeed } from "../network/clock";
import { useDayNight } from "../engine/DayNightCycle";

/** Dev speeds, in sim steps per tick. 0 pauses the world for everyone. */
const SPEEDS = [0, 1, 5, 20];

function label(speed: number): string {
  return speed === 0 ? "❙❙" : `${speed}×`;
}

function clock(t: number): string {
  const hours = Math.floor(t * 24);
  const minutes = Math.floor((t * 24 - hours) * 60);
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

export default function TimeControls() {
  const { send } = useGame();
  // Already advanced every frame by the day/night cycle, so the readout comes
  // free rather than needing a second ticker.
  const { timeOfDay } = useDayNight();

  return (
    <div class="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1 px-2 py-1.5 rounded-xl bg-white/70 backdrop-blur-xl border border-black/[0.06] shadow-[0_2px_12px_rgba(0,0,0,0.06)]">
      <For each={SPEEDS}>
        {(speed) => (
          <button
            onClick={() => send({ type: "SetSpeed", data: speed })}
            class="text-xs font-semibold tracking-wide uppercase px-2 py-1 rounded-lg transition-colors cursor-pointer"
            classList={{
              "bg-stone-800 text-white": simSpeed() === speed,
              "text-stone-500 hover:text-stone-800 hover:bg-black/[0.04]": simSpeed() !== speed,
            }}
            title={speed === 0 ? "Pause" : `${speed}x speed`}
          >
            {label(speed)}
          </button>
        )}
      </For>
      <span class="text-xs font-mono text-stone-500 w-11 text-right pr-1">
        {clock(timeOfDay())}
      </span>
    </div>
  );
}
