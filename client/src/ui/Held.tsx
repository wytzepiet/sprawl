import { Box, Ink, Text, Icon } from "~ui";
import { createMemo, createSignal, For, Show } from "solid-js";
import { stocks } from "../state/market";
import { aim } from "./buildMode";
import { BLUEPRINTS, GOODS } from "../blueprints";
import { Bar, BAD, GOOD, onMap, ROUND } from "./kit";
import type { Good } from "../generated";

/** What the town has of a good on its standing depots' shelves; or,
 *  asked of none, whether a depot stands. */
const inTown = (good: Good | null) => (good ? (stocks()[good]?.level ?? 0) : Object.keys(stocks()).length);

/** The building in hand's tag, over the far edge of its plot: its name,
 *  what it takes against what the town has, and whether it may be let go
 *  here, or why not. */
export default function Held() {
  const lines = createMemo(() => {
    const p = aim();
    // The town's first depot stands at once, for nothing.
    if (!p || (p.kind === "Depot" && !inTown(null))) return [];
    return (Object.entries(BLUEPRINTS[p.kind].materials) as [Good, number][]).map(([good, n]) => ({ good, n, have: inTown(good) }));
  });
  const at = onMap(() => {
    const p = aim();
    if (!p) return null;
    const xs = p.tiles.map((t) => t.x),
      ys = p.tiles.map((t) => t.y);
    return [(Math.min(...xs) + Math.max(...xs) + 1) / 2, Math.max(...ys) + 1.2, 0.6];
  });
  const [size, setSize] = createSignal([0, 0]);
  return (
    <Show when={aim() && at()}>
      <Ink layer="toast" at={{ left: 0, top: 0 }} x={at()!.sx - size()[0] / 2} y={at()!.sy - size()[1]} round={ROUND} pad={{ x: 14, y: 8 }} gap={2} onSize={(w, h) => setSize([w, h])}>
        <Box dir="row" align="center" gap={10}>
          <Text size={13} weight={600}>{BLUEPRINTS[aim()!.kind].label}</Text>
          <For each={lines()}>
            {(l) => (
              <Box dir="row" align="center" gap={4}>
                <Icon d={GOODS[l.good].glyph} size={13} ink={l.have >= l.n ? "ink" : BAD} />
                <Text size={13} ink={l.have >= l.n ? undefined : BAD}>{l.n}</Text>
                <Text size={13} soft>/ {Math.floor(l.have)}</Text>
              </Box>
            )}
          </For>
          <Show when={!lines().length}>
            <Text serif size={13} soft>stands at once</Text>
          </Show>
        </Box>
        <Show when={!aim()!.why && aim()!.ground != null}>
          <Box dir="row" align="center" gap={6}>
            <Bar value={aim()!.ground!} color={GOODS[BLUEPRINTS[aim()!.kind].makes!].color} w={60} h={5} />
            <Text size={12} soft>{Math.round(aim()!.ground! * 100)}% of its best here</Text>
          </Box>
        </Show>
        <Text size={12} ink={aim()!.why ? BAD : GOOD}>{aim()!.why ?? (aim()!.kind === "Harbour" && !aim()!.door ? "The ferry berths here; a street comes with it" : "Let go to build")}</Text>
      </Ink>
    </Show>
  );
}
