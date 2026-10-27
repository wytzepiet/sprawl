import { Box, Ink, Text, Icon } from "~ui";
import { createSignal, For, Show } from "solid-js";
import { useGame } from "../state/gameObjects";
import { dayLengthMs, simNow, simSpeed } from "../network/clock";
import { useDayNight } from "../engine/DayNightCycle";
import { bezel, CORNER, DROP, Line, Press, view, wide, ROUND } from "./kit";

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

/** The time of day, grown out of the bezel's top left corner; on a phone
 *  half a band across the top, the purse the other half. On a wide screen
 *  with the tools, the world's speed and the developer's two resets
 *  beside it, and the time tapped, the hours to run on to: the world
 *  lives through the hours between at full speed, and goes on at 1×. */
export default function Clock() {
  const { send } = useGame();
  // Already advanced every frame by the day/night cycle.
  const { timeOfDay } = useDayNight();
  const [picking, setPicking] = createSignal(false);
  const runTo = (hour: number) => {
    setPicking(false);
    send({ type: "RunTo", data: simNow() + ((hour / 24 - timeOfDay() + 1) % 1) * dayLengthMs() });
  };
  const time = () => <Text serif size={19} w={52}>{clock(timeOfDay())}</Text>;
  return (
    <Ink layer="bezel" at={{ left: -DROP, top: -DROP }} w={wide() ? undefined : view().w / 2 + DROP + 30} h={DROP + bezel() + CORNER} round={ROUND} pad={{ left: DROP + bezel() + 12, right: 12, top: DROP + bezel() }} dir="row" align="center" gap={3}>
      <Show when={TOOLS && wide()} fallback={time()}>
        <Press onTap={() => setPicking(!picking())}>{time()}</Press>
        <Box w={6} />
        <Show when={!picking()} fallback={
          <For each={HOURS}>
            {(hour) => (
              <Press w={28} h={28} round={14} align="center" justify="center" onTap={() => runTo(hour)}>
                <Text size={11} weight={600} ink="ink/0.6">{String(hour).padStart(2, "0")}</Text>
              </Press>
            )}
          </For>
        }>
          <For each={SPEEDS}>
            {(speed) => (
              <Press w={28} h={28} round={14} align="center" justify="center" fill={simSpeed() === speed ? "ink" : undefined} onTap={() => send({ type: "SetSpeed", data: speed })}>
                {speed === 0 ? <Icon d={PAUSE} size={13} ink={simSpeed() === 0 ? "glass" : "ink/0.6"} /> : <Text size={11} weight={600} ink={simSpeed() === speed ? "glass" : "ink/0.6"}>{speed}×</Text>}
              </Press>
            )}
          </For>
          <Box w={1} h={16} fill="ink/0.15" />
          <Press w={26} h={26} round={13} align="center" justify="center" onTap={() => send({ type: "DespawnAllCars" })}>
            <Line d={CARS_OFF} size={14} width={1.5} ink="ink/0.6" />
          </Press>
          <Press w={26} h={26} round={13} align="center" justify="center" onTap={() => send({ type: "ResetWorld" })}>
            <Line d={RESET} size={14} width={1.5} ink="ink/0.6" />
          </Press>
        </Show>
      </Show>
    </Ink>
  );
}
