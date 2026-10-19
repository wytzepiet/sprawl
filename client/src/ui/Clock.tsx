/** @jsxImportSource ~ui */
import { For, Show } from "solid-js";
import { useGame } from "../state/gameObjects";
import { simSpeed } from "../network/clock";
import { useDayNight } from "../engine/DayNightCycle";
import { Line, Press, wide } from "./kit";

/** Dev speeds, in sim steps per tick. 0 pauses the world for everyone. */
const SPEEDS = [0, 1, 5, 20];
const PAUSE = "M7 5h3.5v14H7zM13.5 5H17v14h-3.5z";
const CARS_OFF = "M14 2a2 2 0 0 1 2 2v4h-2V4h-4v2H8V4a2 2 0 0 1 2-2zM5 10h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2zM5 22a2 2 0 1 0 4 0a2 2 0 1 0-4 0M15 22a2 2 0 1 0 4 0a2 2 0 1 0-4 0M2 2L22 22";
const RESET = "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5";

const clock = (t: number) => {
  const minutes = Math.floor(t * 24 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
};

/** The time of day, bottom left; on a wide screen in development, the
 *  world's speed and the developer's two resets beside it. */
export default function Clock() {
  const { send } = useGame();
  // Already advanced every frame by the day/night cycle.
  const { timeOfDay } = useDayNight();
  return (
    <glass layer="clock" at={wide() ? { left: 24, bottom: 28 } : { left: 12, bottom: 12 }} h={48} round={24} pad={{ x: 16 }} dir="row" align="center" gap={4}>
      <text serif size={26} w={68}>{clock(timeOfDay())}</text>
      <Show when={import.meta.env.DEV && wide()}>
        <box w={6} />
        <For each={SPEEDS}>
          {(speed) => (
            <Press w={34} h={34} round={17} align="center" justify="center" fill={simSpeed() === speed ? "ink" : undefined} onTap={() => send({ type: "SetSpeed", data: speed })}>
              {speed === 0 ? <icon d={PAUSE} size={13} ink={simSpeed() === 0 ? "glass" : "ink/0.6"} /> : <text size={12} weight={600} ink={simSpeed() === speed ? "glass" : "ink/0.6"}>{speed}×</text>}
            </Press>
          )}
        </For>
        <box w={1} h={16} fill="ink/0.15" />
        <Press w={28} h={28} round={14} align="center" justify="center" onTap={() => send({ type: "DespawnAllCars" })}>
          <Line d={CARS_OFF} size={14} width={1.5} ink="ink/0.6" />
        </Press>
        <Press w={28} h={28} round={14} align="center" justify="center" onTap={() => send({ type: "ResetWorld" })}>
          <Line d={RESET} size={14} width={1.5} ink="ink/0.6" />
        </Press>
      </Show>
    </glass>
  );
}
