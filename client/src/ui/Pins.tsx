import { Box, Icon, Text } from "~ui";
import { For, Show, createMemo } from "solid-js";
import { signed } from "../state/gameObjects";
import { now } from "../state/sea";
import { select } from "../state/selection";
import { LATE_MS } from "../generated/rows";
import { GOODS, middle } from "../blueprints";
import { BAD, onMap, Press } from "./kit";
import type { Building, Wait, Wanted } from "../generated";

/**
 * Every trip a building waits on, over its roof (`model::Wait`), as Mini
 * Motorways shows a house wanting a car: an order on its way is a dot in
 * its good's colour; a trip late, the building unable to go on without
 * it, a pin, its ring filling red as it stays late. A seat nobody holds
 * is a pin of someone. A tap on a pin opens the building's card.
 */
export default function Pins() {
  const waiting = createMemo(() => signed().filter((e) => (e.object.data as Building).waits?.length));
  return <For each={waiting()}>{(e) => <Over id={e.id} building={() => e.object.data as Building} />}</For>;
}

/** Someone, for a seat nobody holds. */
const HANDS = { color: "#8E8E93", glyph: "M12 2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zM3 22c0-5 4-8.5 9-8.5s9 3.5 9 8.5z" };
const look = (w: Wanted) => (w === "Hands" ? HANDS : GOODS[w.Good]);
const key = (w: Wanted) => (w === "Hands" ? "Hands" : w.Good);
/** Pins over one building, at most; the rest a count. */
const MOST = 5;

function Over(props: { id: number; building: () => Building }) {
  const at = onMap(() => [...middle(props.building()), 0.9]);
  const late = createMemo(() => props.building().waits.filter((w) => w.late !== null).sort((a, b) => a.late! - b.late!));
  const dots = createMemo(() => {
    const by = new Map<string, { what: Wanted; n: number }>();
    for (const w of props.building().waits) if (w.late === null) by.set(key(w.what), { what: w.what, n: (by.get(key(w.what))?.n ?? 0) + 1 });
    return [...by.values()];
  });
  return (
    <Show when={at()}>
      {(p) => (
        <Box at={{ left: 0, top: 0 }} x={p().sx} y={p().sy}>
          <Box at={{ left: 0, bottom: 0 }} x={-200} w={400} align="center" gap={3}>
            <Show when={late().length > 0}>
              <Box dir="row" gap={3} align="center">
                <For each={late().slice(0, MOST)}>{(w) => <Pin wait={w} onTap={() => select(props.id)} />}</For>
                <Show when={late().length > MOST}>
                  <Text size={11} weight={700} ink="white">+{late().length - MOST}</Text>
                </Show>
              </Box>
            </Show>
            <Show when={dots().length > 0}>
              <Box dir="row" gap={4} align="center">
                <For each={dots()}>
                  {(d) => (
                    <Box dir="row" align="center" gap={1}>
                      <Box w={8} h={8} round={4} fill={look(d.what).color} stroke={[1.5, "white"]} />
                      <Show when={d.n > 1}>
                        <Text size={9} weight={700} ink="white">{d.n}</Text>
                      </Show>
                    </Box>
                  )}
                </For>
              </Box>
            </Show>
          </Box>
        </Box>
      )}
    </Show>
  );
}

/** A late trip: its good's disc and glyph, ringed white, the ring
 *  filling red as it waits, full when the building gives up (`LATE_MS`). */
function Pin(props: { wait: Wait; onTap: () => void }) {
  const { color, glyph } = look(props.wait.what);
  const full = () => Math.min(1, Math.max(0, (now() - props.wait.late!) / LATE_MS));
  const R = 12.5;
  const round = 2 * Math.PI * R;
  return (
    <Press w={30} h={30} align="center" justify="center" onTap={props.onTap}>
      <svg width="30" height="30" viewBox="-15 -15 30 30" style={{ position: "absolute", left: "0", top: "0" }}>
        <circle r={R} fill="white" />
        <circle r={R} fill="none" stroke={BAD} stroke-width="3" stroke-dasharray={`${full() * round} ${round}`} transform="rotate(-90)" />
        <circle r="10" fill={color} />
      </svg>
      <Icon d={glyph} size={12} ink="white" />
    </Press>
  );
}
