/** @jsxImportSource ~ui */
import { createMemo, createSignal, For, Show } from "solid-js";
import { signed, getEntity } from "../state/gameObjects";
import { now } from "../state/town";
import { GOODS, middle } from "../blueprints";
import { PATIENCE_MS } from "../generated/rows";
import { BAD, onMap } from "./kit";
import type { Building } from "../generated";

/** The bubble's size, and the ring of patience round it. */
const SIZE = 30;
const R = 13;

/** An arc from the top, clockwise, round a share of the way. */
function arc(share: number) {
  const a = 2 * Math.PI * Math.min(Math.max(share, 0.001), 0.999);
  const c = SIZE / 2;
  const [x, y] = [c + R * Math.sin(a), c - R * Math.cos(a)];
  return `M${c} ${c - R}A${R} ${R} 0 ${a > Math.PI ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}`;
}

/**
 * What each family wants, over its roof: the good, ringed by the patience
 * they have left for it, the ring running down and turning red; at the
 * end of it they leave. A family with a car out fetching it shows it
 * fainter.
 */
export default function Wants() {
  const homes = createMemo(
    () => signed().filter((e) => (e.object.data as Building).home?.wants.length).map((e) => e.id),
    undefined,
    { equals: (a, b) => a.join() === b.join() },
  );
  return <For each={homes()}>{(id) => <Bubble id={id} />}</For>;
}

function Bubble(props: { id: number }) {
  const home = () => {
    now();
    const e = getEntity(props.id);
    return e?.object.kind === "Building" ? (e.object.data as Building) : null;
  };
  const want = () => home()?.home?.wants[0] ?? null;
  const at = onMap(() => {
    const b = home();
    if (!b) return null;
    const [x, y] = middle(b);
    return [x, y, 1.1];
  });
  const left = () => {
    const w = want();
    return w ? 1 - (now() - w.since) / PATIENCE_MS : 1;
  };
  const [size] = createSignal(SIZE);
  return (
    <Show when={at() && want()}>
      {(w) => (
        <box at={{ left: 0, top: 0 }} x={at()!.sx - size() / 2} y={at()!.sy - size()} w={SIZE} h={SIZE} round={SIZE / 2} fill="glass/0.92" shadow align="center" justify="center" opacity={w().by === null ? 1 : 0.7}>
          <icon at={{ left: 0, top: 0 }} d={arc(left())} view={SIZE} size={SIZE} stroke={2.6} ink={left() < 0.5 ? BAD : GOODS[w().good].color} />
          <icon d={GOODS[w().good].glyph} size={15} ink={GOODS[w().good].color} />
        </box>
      )}
    </Show>
  );
}
