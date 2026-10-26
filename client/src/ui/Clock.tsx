/** @jsxImportSource ~ui */
import { createSignal, For, Show } from "solid-js";
import { useGame } from "../state/gameObjects";
import { dayLengthMs, simNow, simSpeed } from "../network/clock";
import { useDayNight } from "../engine/DayNightCycle";
import { Line, Press, wide } from "./kit";

/** The world's speed and resets, for whoever builds the game: in
 *  development and on a branch's preview (`vite build --mode preview`),
 *  never in a production build. */
const TOOLS = import.meta.env.MODE !== "production";
/** Dev speeds, in sim steps per tick. 0 pauses the world for everyone. */
const SPEEDS = [0, 1, 5, 20];
/** The hours the clock runs on to, picked from under it. */
const HOURS = [0, 3, 6, 9, 12, 15, 18, 21];
const PAUSE = "M7 5h3.5v14H7zM13.5 5H17v14h-3.5z";
const CARS_OFF = "M14 2a2 2 0 0 1 2 2v4h-2V4h-4v2H8V4a2 2 0 0 1 2-2zM5 10h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2zM5 22a2 2 0 1 0 4 0a2 2 0 1 0-4 0M15 22a2 2 0 1 0 4 0a2 2 0 1 0-4 0M2 2L22 22";
const RESET = "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5";

const clock = (t: number) => {
  const minutes = Math.floor(t * 24 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
};

/** The time of day; on a wide screen with the tools, the world's speed
 *  and the developer's two resets beside it, and the time tapped, the
 *  hours to run on to: the world lives through the hours between at full
 *  speed, and goes on at 1×. */
export default function Clock() {
  const { send } = useGame();
  // Already advanced every frame by the day/night cycle.
  const { timeOfDay } = useDayNight();
  const [picking, setPicking] = createSignal(false);
  const runTo = (hour: number) => {
    setPicking(false);
    send({ type: "RunTo", data: simNow() + ((hour / 24 - timeOfDay() + 1) % 1) * dayLengthMs() });
  };
  const time = () => <text serif size={26} w={68}>{clock(timeOfDay())}</text>;
  return (
    <glass layer="clock" h={48} round={24} pad={{ x: 16 }} dir="row" align="center" gap={4}>
      <Show when={TOOLS && wide()} fallback={time()}>
        <Press onTap={() => setPicking(!picking())}>{time()}</Press>
        <box w={6} />
        <Show when={!picking()} fallback={
          <For each={HOURS}>
            {(hour) => (
              <Press w={34} h={34} round={17} align="center" justify="center" onTap={() => runTo(hour)}>
                <text size={12} weight={600} ink="ink/0.6">{String(hour).padStart(2, "0")}</text>
              </Press>
            )}
          </For>
        }>
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
      </Show>
    </glass>
  );
}
