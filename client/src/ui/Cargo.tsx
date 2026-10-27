import { Box, Text } from "~ui";
import { createMemo, createSignal, For, Show } from "solid-js";
import { getEntity } from "../state/gameObjects";
import { sea } from "../state/sea";
import { positionOf } from "../state/selection";
import { track } from "./Shipments";
import { GoodDot, onMap } from "./kit";
import type { Good, Shipment } from "../generated";

/**
 * Packages on the map: over whatever carries them, the ferry, a lorry,
 * the harbour's quay, a chip of each good aboard and how many. A
 * tap follows the first. Drawn under every pane of glass, so a card over
 * one hides it.
 */
export default function Cargo() {
  const shown = (s: Shipment) => s.carrier !== null && !!s.good && s.leg !== "Booked";
  const carried = createMemo(() => [...new Set(sea.shipments.filter(shown).map((s) => s.carrier!))].sort((a, b) => a - b), undefined, { equals: (a, b) => a.join() === b.join() });
  const goodsOn = (carrier: number) => {
    const l: { good: Good; n: number; package: number }[] = [];
    for (const s of sea.shipments) {
      if (s.carrier !== carrier || !shown(s)) continue;
      const g = l.find((x) => x.good === s.good);
      if (g) g.n++;
      else l.push({ good: s.good!, n: 1, package: s.package });
    }
    return l;
  };
  return (
    <For each={carried()}>
      {(id) => {
        // Over a building's roof, or a vehicle's.
        const at = onMap(() => {
          const p = positionOf(id);
          const e = getEntity(id);
          return p && e ? [p[0], p[1], e.object.kind === "Building" ? 0.6 : 0.3] : null;
        });
        const [size, setSize] = createSignal([0, 0]);
        return (
          <Show when={at()}>
            {(p) => (
              <Box
                at={{ left: 0, top: 0 }}
                x={p().sx - size()[0] / 2}
                y={p().sy - size()[1] * 1.3}
                dir="row"
                align="center"
                gap={2}
                pad={2}
                round={10}
                fill="glass"
                onSize={(w, h) => setSize([w, h])}
                onTap={() => goodsOn(id)[0] && track(goodsOn(id)[0].package)}
              >
                <For each={goodsOn(id)}>
                  {(g) => (
                    <Box dir="row" align="center">
                      <GoodDot good={g.good} size={16} />
                      <Show when={g.n > 1}>
                        <Box pad={{ x: 2 }}><Text size={10} weight={700}>{g.n}</Text></Box>
                      </Show>
                    </Box>
                  )}
                </For>
              </Box>
            )}
          </Show>
        );
      }}
    </For>
  );
}
