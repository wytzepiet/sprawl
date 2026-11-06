import { Box, Ink, Text, Icon } from "~ui";
import { createSignal, For, Show } from "solid-js";
import { useGame } from "../state/gameObjects";
import { dayLengthMs, simNow, simSpeed } from "../network/clock";
import { useDayNight } from "../engine/DayNightCycle";
import { town } from "../state/town";
import { bezel, CORNER, DROP, Line, Press, view, wide, ROUND } from "./kit";

/** The developer's tools, beside the speeds: the hours to run on to and
 *  a reset, in development and on a branch's preview, never in a
 *  production build. */
const TOOLS = import.meta.env.MODE !== "production";
/** The speeds, in sim steps per tick: paused, as it comes, and fast. */
const SPEEDS = [0, 1, 3];
/** The hours the clock runs on to, picked from under it. */
const HOURS = [0, 3, 6, 9, 12, 15, 18, 21];
const PAUSE = "M7 5h3.5v14H7zM13.5 5H17v14h-3.5z";
const PLAY = "M7 4.5v15l12.5-7.5z";
const FAST = "M3 5v14l9-7zM12 5v14l9-7z";
const RESET = "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5";
const GLYPH = [PAUSE, PLAY, FAST];

const clock = (t: number) => {
  const minutes = Math.floor(t * 24 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
};

/** The day and the time, grown out of the bezel's top left corner, and
 *  the speeds beside them: the game paused, as it comes, or fast. On a
 *  wide screen with the tools, the time tapped gives the hours to run
 *  on to, and a reset. */
export default function Clock() {
  const { send } = useGame();
  const { timeOfDay } = useDayNight();
  const [picking, setPicking] = createSignal(false);
  const runTo = (hour: number) => {
    setPicking(false);
    send({ type: "RunTo", data: simNow() + ((hour / 24 - timeOfDay() + 1) % 1) * dayLengthMs() });
  };
  const time = () => (
    <Box dir="row" align="center" gap={6}>
      <Text size={12} weight={600} soft>Day {Math.max(1, town().day)}</Text>
      <Text serif size={19} w={52}>{clock(timeOfDay())}</Text>
    </Box>
  );
  return (
    <Ink layer="bezel" at={{ left: -DROP, top: -DROP }} w={wide() ? undefined : view().w / 2 + DROP + 30} h={DROP + bezel() + CORNER} round={ROUND} pad={{ left: DROP + bezel() + 12, right: 12, top: DROP + bezel() }} dir="row" align="center" gap={3}>
      <Press onTap={() => TOOLS && wide() && setPicking(!picking())}>{time()}</Press>
      <Box w={4} />
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
          {(speed, i) => (
            <Press w={28} h={28} round={14} align="center" justify="center" fill={simSpeed() === speed ? "ink" : undefined} onTap={() => send({ type: "SetSpeed", data: speed })}>
              <Icon d={GLYPH[i()]} size={13} ink={simSpeed() === speed ? "glass" : "ink/0.6"} />
            </Press>
          )}
        </For>
        <Show when={TOOLS && wide()}>
          <Box w={1} h={16} fill="ink/0.15" />
          <Press w={26} h={26} round={13} align="center" justify="center" onTap={() => send({ type: "ResetWorld" })}>
            <Line d={RESET} size={14} width={1.5} ink="ink/0.6" />
          </Press>
        </Show>
      </Show>
    </Ink>
  );
}
