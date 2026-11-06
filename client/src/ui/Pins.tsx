import { Box, Icon, Text } from "~ui";
import { For, Show, createMemo } from "solid-js";
import { reached, signed, signedOne } from "../state/gameObjects";

const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
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
 * instead: on its way. A building no road reaches asks for one. A tap
 * opens the card.
 */
export default function Pins() {
  // By id: a building the server sends again is a new entry, and pins
  // keyed by it were taken down and put up again, blinking, each time.
  const wanting = createMemo(() => signed().filter((e) => (e.object.data as Building).home?.wants.length).map((e) => e.id), [], { equals: same });
  const cut = createMemo(() => signed().filter((e) => !reached(e)).map((e) => e.id), [], { equals: same });
  // As it was last, for the moment between its going and its pin's.
  const building = (id: number) => {
    let last = signedOne(id)!.object.data as Building;
    return () => (last = (signedOne(id)?.object.data as Building | undefined) ?? last);
  };
  return (
    <>
      <For each={wanting()}>{(id) => <Over id={id} building={building(id)} />}</For>
      <For each={cut()}>{(id) => <NoRoad id={id} building={building(id)} />}</For>
    </>
  );
}

/** A street's glyph: its kerbs and the line down its middle. */
const STREET = "M3 2h2.5v20H3zM18.5 2H21v20h-2.5zM10.75 2h2.5v4.5h-2.5zM10.75 9.75h2.5v4.5h-2.5zM10.75 17.5h2.5V22h-2.5z";

/** Over a building no road reaches: a red pin of a street. */
function NoRoad(props: { id: number; building: () => Building }) {
  const at = onMap(() => [...middle(props.building()), 0.9]);
  return (
    <Show when={at()}>
      {(p) => (
        <Box at={{ left: 0, top: 0 }} x={p().sx - 15} y={p().sy - 34}>
          <Press w={30} h={30} round={15} fill={BAD} stroke={[2, "white"]} align="center" justify="center" onTap={() => select(props.id)}>
            <Icon d={STREET} size={15} ink="white" />
          </Press>
        </Box>
      )}
    </Show>
  );
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
 *  over the family's patience; the last quarter, the family all but
 *  gone, it pings, a red ring going out from it again and again. */
export function Pin(props: { want: Want; onTap: () => void }) {
  const { color, glyph } = GOODS[props.want.good];
  const full = () => Math.min(1, Math.max(0, (now() - props.want.since) / PATIENCE_MS));
  const R = 15;
  const round = 2 * Math.PI * R;
  return (
    <Press w={38} h={38} align="center" justify="center" onTap={props.onTap}>
      <Show when={full() > 0.75}>
        <div class="ping" style={{ "border-color": BAD }} />
      </Show>
      <svg width="38" height="38" viewBox="-19 -19 38 38" style={{ position: "absolute", left: "0", top: "0" }}>
        <circle r="18.5" fill="white" />
        <circle r={R} fill="none" stroke="#0000001f" stroke-width="5" />
        <circle r={R} fill="none" stroke={BAD} stroke-width="5" stroke-dasharray={`${full() * round} ${round}`} transform="rotate(-90)" />
        <circle r="11.5" fill={full() > 0.75 ? BAD : color} />
      </svg>
      <Icon d={glyph} size={14} ink="white" />
    </Press>
  );
}
