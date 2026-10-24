/** @jsxImportSource ~ui */
import { createSignal, For, Show } from "solid-js";
import { getEntity, recentLumps } from "../state/gameObjects";
import { GOODS, middle } from "../blueprints";
import { BAD, elapsed, GDP, GOOD, keys, onMap } from "./kit";
import type { Building, Lump } from "../generated";

/**
 * What lands on the map: coins as goods cross the border, a box landing
 * from the world or one going out on the ferry; GDP as value is added,
 * a meal served, a crop cut, a shift at a desk; and goods, a box unloaded
 * onto a depot's shelf, or stone off it for a road laid. Each lump floats
 * up over its building for a moment and fades — the event the meter sums,
 * seen where it happened. Green is coins arriving, red coins leaving,
 * violet GDP, the level's colour; goods pop up bigger, in their own
 * colour, with their glyph. docs/trade.md.
 */
export default function Lumps() {
  return <For each={recentLumps().filter(seen)}>{(lump) => <Rise lump={lump} />}</For>;
}

function Rise(props: { lump: Lump }) {
  const l = props.lump;
  const big = goods(l);
  const at = onMap(() => {
    const e = getEntity(l.building);
    return e?.position && e.object.kind === "Building" ? [...middle(e.object.data as Building), 0] : null;
  });
  const t = elapsed(big ? 3200 : 2400);
  const rise = () => (big ? keys(t(), [[0, 14], [0.1, -6], [0.8, -22], [1, -34]]) : keys(t(), [[0, 8], [0.1, 0], [0.7, -14], [1, -26]]));
  const fade = () => keys(t(), big ? [[0, 0], [0.1, 1], [0.8, 1], [1, 0]] : [[0, 0], [0.1, 1], [0.7, 1], [1, 0]]);
  // A box pops: up past its size and back, in its first fifth of a second.
  const pop = () => (big ? keys(t(), [[0, 0.3], [0.084, 1.18], [0.19, 1]]) : 1);
  const [size, setSize] = createSignal([0, 0]);
  const ink = big ? GOODS[l.good!].color : l.gdp > 0 ? GDP : l.coins < 0 ? BAD : GOOD;
  return (
    <Show when={at()}>
      {(p) => (
        <box
          at={{ left: 0, top: 0 }}
          x={p().sx - size()[0] / 2}
          y={p().sy - 48 - size()[1] / 2 + rise()}
          scale={pop()}
          opacity={fade()}
          dir="row"
          align="center"
          gap={4}
          pad={big ? { left: 6, right: 10, y: 4 } : { x: 6, y: 2 }}
          round={12}
          fill={ink}
          shadow
          onSize={(w, h) => setSize([w, h])}
        >
          <Show when={l.good}>{(g) => <icon d={GOODS[g()].glyph} size={big ? 18 : 11} ink="white" />}</Show>
          <text size={big ? 15 : 11} weight={700} ink="white">
            {`${l.coins < 0 || l.units < 0 ? "−" : "+"}${amount(Math.abs(l.units || l.gdp || l.coins))}`}
          </text>
          <Show when={big}>
            <text size={15} weight={600} ink="white/0.9">{GOODS[l.good!].label}</text>
          </Show>
        </box>
      )}
    </Show>
  );
}

/** Worth a lump: a tank topped up from a depot's shelf moves a coin's hundredths. */
const seen = (l: Lump) => l.units !== 0 || Math.abs(l.coins) >= 0.05 || l.gdp >= 0.05;

/** Goods unloaded at a depot, or taken off its shelf, not coins or GDP. */
const goods = (l: Lump) => l.units !== 0 && l.good !== null;

/** To a tenth under ten, whole over it. */
const amount = (v: number) => (v < 10 ? v.toFixed(1) : Math.round(v).toString());
