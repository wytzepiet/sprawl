import { Box, Icon, Text } from "~ui";
import { For, Show, createMemo } from "solid-js";
import { signed } from "../state/gameObjects";
import { now } from "../state/town";
import { select } from "../state/selection";
import { PATIENCE_MS } from "../generated/rows";
import { GOODS, middle } from "../blueprints";
import { BAD, onMap, Press } from "./kit";
import type { Building, Want } from "../generated";

/**
 * What every family wants, over its roof, as Mini Motorways shows a house
 * wanting a car: a pin of the good, its ring filling red as the family
 * waits; full, it leaves. A car out for it is a dot in the good's colour
 * instead: on its way. A tap opens the house's card.
 */
export default function Pins() {
  const wanting = createMemo(() => signed().filter((e) => (e.object.data as Building).home?.wants.length));
  return <For each={wanting()}>{(e) => <Over id={e.id} building={() => e.object.data as Building} />}</For>;
}

/** Pins over one building, at most; the rest a count. */
const MOST = 4;

function Over(props: { id: number; building: () => Building }) {
  const at = onMap(() => [...middle(props.building()), 0.9]);
  const wants = () => props.building().home?.wants ?? [];
  const waiting = createMemo(() => wants().filter((w) => w.by === null).sort((a, b) => a.since - b.since));
  const going = createMemo(() => wants().filter((w) => w.by !== null));
  return (
    <Show when={at()}>
      {(p) => (
        <Box at={{ left: 0, top: 0 }} x={p().sx} y={p().sy}>
          <Box at={{ left: 0, bottom: 0 }} x={-200} w={400} align="center" gap={3}>
            <Show when={waiting().length > 0}>
              <Box dir="row" gap={3} align="center">
                <For each={waiting().slice(0, MOST)}>{(w) => <Pin want={w} onTap={() => select(props.id)} />}</For>
                <Show when={waiting().length > MOST}>
                  <Text size={11} weight={700} ink="white">+{waiting().length - MOST}</Text>
                </Show>
              </Box>
            </Show>
            <Show when={going().length > 0}>
              <Box dir="row" gap={4} align="center">
                <For each={going()}>{(w) => <Box w={8} h={8} round={4} fill={GOODS[w.good].color} stroke={[1.5, "white"]} />}</For>
              </Box>
            </Show>
          </Box>
        </Box>
      )}
    </Show>
  );
}

/** A want: its good's disc and glyph, ringed white, the ring filling red
 *  over the family's patience. */
function Pin(props: { want: Want; onTap: () => void }) {
  const { color, glyph } = GOODS[props.want.good];
  const full = () => Math.min(1, Math.max(0, (now() - props.want.since) / PATIENCE_MS));
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
