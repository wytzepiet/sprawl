/** @jsxImportSource ~ui */
import { createMemo, createSignal, For, Show } from "solid-js";
import { getEntity } from "../state/gameObjects";
import { sea } from "../state/sea";
import { positionOf } from "../state/selection";
import { track } from "./Shipments";
import { GoodDot, onMap } from "./kit";
import type { Good, Shipment } from "../generated";

/**
 * Boxes on the map: over whatever carries them, the ferry, the tug, a
 * lorry, the harbour's park, a chip of each good aboard and how many. A
 * tap follows the first. Drawn under every pane of glass, so a card over
 * one hides it.
 */
export default function Cargo() {
  const shown = (s: Shipment) => s.carrier !== null && !!s.good && s.units > 0 && s.leg !== "Booked";
  const carried = createMemo(() => [...new Set(sea.shipments.filter(shown).map((s) => s.carrier!))].sort((a, b) => a - b), undefined, { equals: (a, b) => a.join() === b.join() });
  const goodsOn = (carrier: number) => {
    const l: { good: Good; boxes: number; trailer: number }[] = [];
    for (const s of sea.shipments) {
      if (s.carrier !== carrier || !shown(s)) continue;
      const g = l.find((x) => x.good === s.good);
      if (g) g.boxes++;
      else l.push({ good: s.good!, boxes: 1, trailer: s.trailer });
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
              <box
                at={{ left: 0, top: 0 }}
                x={p().sx - size()[0] / 2}
                y={p().sy - size()[1] * 1.3}
                dir="row"
                align="center"
                gap={2}
                pad={2}
                round={10}
                fill="glass/0.85"
                shadow
                onSize={(w, h) => setSize([w, h])}
                onTap={() => goodsOn(id)[0] && track(goodsOn(id)[0].trailer)}
              >
                <For each={goodsOn(id)}>
                  {(g) => (
                    <box dir="row" align="center">
                      <GoodDot good={g.good} size={16} />
                      <Show when={g.boxes > 1}>
                        <box pad={{ x: 2 }}><text size={10} weight={700}>{g.boxes}</text></box>
                      </Show>
                    </box>
                  )}
                </For>
              </box>
            )}
          </Show>
        );
      }}
    </For>
  );
}
