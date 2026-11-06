import { Box, Ink, Text, Icon } from "~ui";
import { Show } from "solid-js";
import { follow } from "../engine/spring";
import { town } from "../state/town";
import { bezel, CORNER, DROP, GDP, view, wide, ROUND } from "./kit";

/** The ring toward the next pick, in its own 56-unit box, cut finely. */
const R = 24;
const CUTS = 48;
function arc(share: number) {
  const a = 2 * Math.PI * Math.min(share, 0.999);
  const [x, y] = [28 + R * Math.sin(a), 28 - R * Math.cos(a)];
  return `M28 ${28 - R}A${R} ${R} 0 ${a > Math.PI ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}`;
}
const RING = `M28 ${28 - R}A${R} ${R} 0 1 1 28 ${28 + R}A${R} ${R} 0 1 1 28 ${28 - R}`;
/** Someone, and a road. */
const PERSON = "M12 2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zM3 22c0-5 4-8.5 9-8.5s9 3.5 9 8.5z";
const ROAD = "M3 2h2.5v20H3zM18.5 2H21v20h-2.5zM10.75 2h2.5v4.5h-2.5zM10.75 9.75h2.5v4.5h-2.5zM10.75 17.5h2.5V22h-2.5z";
/** The town's standing, by its people (`town::STATUSES`). */
const STANDING = ["Hamlet", "Village", "Town", "City"];

/**
 * The town's dials, grown out of the bezel's top right corner: its
 * people, a ring closing on the next pick as more move in; and the road
 * it has left to lay.
 */
export default function Meter() {
  const [fill] = follow(() => Math.min(1, Math.max(0, town().toward / Math.max(1, town().step))), { rest: 0.001 });
  const cut = () => Math.round(fill() * CUTS) / CUTS;
  return (
    <Ink layer="bezel" at={{ right: -DROP, top: -DROP }} w={wide() ? undefined : view().w / 2 + DROP + 30} h={DROP + bezel() + CORNER} round={ROUND} pad={{ right: DROP + bezel() + 14, left: 10, top: DROP + bezel() }} dir="row" align="center" justify="end" gap={8}>
      <Show when={wide()}>
        <Text size={13} weight={600} soft>{STANDING[town().status] ?? ""}</Text>
      </Show>
      <Box w={28} h={28} align="center" justify="center">
        <Icon at={{ left: 0, top: 0 }} d={RING} view={56} size={28} stroke={4.5} ink="ink/0.16" />
        <Show when={cut() > 0}>
          <Icon at={{ left: 0, top: 0 }} d={arc(cut())} view={56} size={28} stroke={4.5} ink={GDP} />
        </Show>
        <Icon d={PERSON} size={12} ink="ink/0.8" />
      </Box>
      <Text num size={17}>{town().people}</Text>
      <Box w={6} />
      <Icon d={ROAD} size={14} ink="ink/0.6" />
      <Box dir="row" align="baseline" gap={4}>
        <Text num size={17}>{town().roads}</Text>
        <Text size={13} soft>road</Text>
      </Box>
    </Ink>
  );
}
