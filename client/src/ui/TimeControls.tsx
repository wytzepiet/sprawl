import { For } from "solid-js";
import { useGame } from "../state/gameObjects";
import { simSpeed } from "../network/clock";
import { useDayNight } from "../engine/DayNightCycle";
import { CarOff, RotateCcw } from "./icons";

/** Dev speeds, in sim steps per tick. 0 pauses the world for everyone. */
const SPEEDS = [0, 1, 5, 20];

function label(speed: number): string {
  return speed === 0 ? "‖" : `${speed}×`;
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
    <div class="glass fixed top-6 left-6 z-50 flex h-12 items-center gap-1 rounded-full pl-5 pr-2 select-none">
      <span class="serif mr-2.5 text-[26px] font-light tabular-nums">{clock(timeOfDay())}</span>
      <For each={SPEEDS}>
        {(speed) => (
          <button
            onClick={() => send({ type: "SetSpeed", data: speed })}
            class="press h-[34px] w-[34px] rounded-full text-xs font-semibold cursor-pointer"
            classList={{ soft: simSpeed() !== speed }}
            style={simSpeed() === speed ? { background: "rgb(var(--ink))", color: "rgb(var(--glass))" } : {}}
            title={speed === 0 ? "Pause" : `${speed}x speed`}
          >
            {label(speed)}
          </button>
        )}
      </For>
      {/* The developer's hand, kept off the mayor's bar. */}
      <div class="mx-1 h-4 w-px" style={{ background: "rgb(var(--ink) / 0.15)" }} />
      <button onClick={() => send({ type: "DespawnAllCars" })} class="press soft p-1.5 rounded-full hover:!text-orange-500 cursor-pointer" title="Despawn all cars">
        <CarOff size={14} stroke-width={1.5} />
      </button>
      <button onClick={() => send({ type: "ResetWorld" })} class="press soft p-1.5 rounded-full hover:!text-red-500 cursor-pointer" title="Reset server">
        <RotateCcw size={14} stroke-width={1.5} />
      </button>
    </div>
  );
}
