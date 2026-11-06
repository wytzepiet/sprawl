import { Box, Text } from "~ui";
import { signed } from "../state/gameObjects";
import { now } from "../state/town";
import { select } from "../state/selection";
import { PATIENCE_MS } from "../generated/rows";
import { GOODS } from "../blueprints";
import { why } from "./Card";
import { Pin } from "./Pins";
import { BAD } from "./kit";
import type { Building, Want } from "../generated";

/** How far through its patience a want is before the town is warned. */
const LATE = 0.75;

export interface Late {
  id: number;
  b: Building;
  want: Want;
}

/** Every want that late and nobody out for it, the oldest first: the
 *  families about to leave, the only way the town loses anyone. */
export function late(): Late[] {
  const t = now();
  const all: Late[] = [];
  for (const e of signed()) {
    const b = e.object.data as Building;
    for (const w of b.home?.wants ?? []) if (w.by === null && (t - w.since) / PATIENCE_MS > LATE) all.push({ id: e.id, b, want: w });
  }
  return all.sort((a, b) => a.want.since - b.want.since);
}

/** The feed's alarm: the oldest such want's pin, how many families are
 *  that close, and why it is not met. A tap opens the house. */
export function LeavingCard(props: { all: Late[] }) {
  const f = () => props.all[0];
  return (
    <Box dir="row" align="center" gap={10} pad={{ y: 8, x: 10 }} onTap={() => select(f().id)}>
      <Pin want={f().want} onTap={() => select(f().id)} />
      <Box grow={1} gap={2}>
        <Text size={15} weight={600} ink={BAD} lines={1}>
          {props.all.length > 1 ? `${props.all.length} families about to leave` : "A family is about to leave"}
        </Text>
        <Text size={13} soft lines={1}>{`${GOODS[f().want.good].label}: ${why(f().b, f().id, f().want.good)}`}</Text>
      </Box>
    </Box>
  );
}
