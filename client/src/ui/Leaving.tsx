import { Box, Ink, Text } from "~ui";
import { createMemo, Show } from "solid-js";
import { follow } from "../engine/spring";
import { signed } from "../state/gameObjects";
import { now } from "../state/town";
import { select } from "../state/selection";
import { PATIENCE_MS } from "../generated/rows";
import { GOODS } from "../blueprints";
import { why } from "./Card";
import { Pin } from "./Pins";
import { Appear, BAD, bezel, CORNER, DROP, view } from "./kit";
import type { Building } from "../generated";

/** How far through its patience a want is before the town is warned. */
const LATE = 0.75;
/** How tall the alarm stands under the corners. */
const TALL = 66;

/**
 * The town's alarm: a family about to leave, the only way the town
 * loses anyone. The black swells down out of the bezel's top, between
 * the corners, as a phone's island does: the want's pin, its ring all
 * but full, what it is and why it is not met. A tap opens the house and
 * takes the camera there. Gone when no want is that late.
 */
export default function Leaving() {
  const late = createMemo(() => {
    const t = now();
    const all: { id: number; b: Building; want: NonNullable<Building["home"]>["wants"][number] }[] = [];
    for (const e of signed()) {
      const b = e.object.data as Building;
      for (const w of b.home?.wants ?? []) if (w.by === null && (t - w.since) / PATIENCE_MS > LATE) all.push({ id: e.id, b, want: w });
    }
    return all.sort((a, b) => a.want.since - b.want.since);
  });
  const first = () => late()[0];
  const W = () => Math.min(380, view().w - 24);
  const [h] = follow(() => (first() ? CORNER + TALL : 0), { rest: 0.2 });
  const [w] = follow(() => (first() ? W() : 140), { rest: 0.2 });
  return (
    <Box at={{ left: 0, right: 0, top: -DROP }} align="center">
      <Ink layer="bezel" w={w()} h={DROP + bezel() + h()} round={33} pad={{ top: DROP + bezel() + CORNER, x: 14 }} clip onTap={() => first() && select(first()!.id)}>
        <Show when={first()} keyed>
          {(f) => (
            <Appear dir="row" align="center" gap={12} h={TALL}>
              <Pin want={f.want} onTap={() => select(f.id)} />
              <Box grow={1} gap={1}>
                <Text size={15} weight={600} ink={BAD} lines={1}>
                  {late().length > 1 ? `${late().length} families about to leave` : "A family is about to leave"}
                </Text>
                <Text size={13} soft lines={1}>{`${GOODS[f.want.good].label}: ${why(f.b, f.id, f.want.good)}`}</Text>
              </Box>
            </Appear>
          )}
        </Show>
      </Ink>
    </Box>
  );
}
