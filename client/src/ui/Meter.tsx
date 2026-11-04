/** @jsxImportSource ~ui */
import { createEffect, createSignal, For, on, Show } from "solid-js";
import { town } from "../state/town";
import { follow } from "../engine/spring";
import { BAD, elapsed, GDP, GOOD, keys, wide } from "./kit";

/** The level's ring, in its own 56-unit box, and how finely its arc is
 *  cut: each cut is a glyph of its own. */
const R = 24;
const CUTS = 48;
/** How long a lump takes to drip out of the purse. */
const DRIP_MS = 1600;

/** The ring's arc, from the top round to a share of the way. */
function arc(share: number) {
  const a = 2 * Math.PI * Math.min(share, 0.999);
  const [x, y] = [28 + R * Math.sin(a), 28 - R * Math.cos(a)];
  return `M28 ${28 - R}A${R} ${R} 0 ${a > Math.PI ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}`;
}
const RING = `M28 ${28 - R}A${R} ${R} 0 1 1 28 ${28 + R}A${R} ${R} 0 1 1 28 ${28 - R}`;

/**
 * The town's two dials, run together into one shape at the top: who
 * lives here, a ring closing on the next pick as they move in, and the
 * road the mayor has left to lay. Road laid drips out of it.
 */
export default function Meter() {
  const roads = () => town().roads;
  const [fill] = follow(() => (town().step > 0 ? Math.min(1, town().toward / town().step) : 0), { rest: 0.001 });
  const cut = () => Math.round(fill() * CUTS) / CUTS;

  const [drips, setDrips] = createSignal<{ id: number; n: number }[]>([]);
  let next = 0;
  createEffect(on(roads, (now, before) => {
    if (before === undefined || now <= before) return;
    const drip = { id: next++, n: now - before };
    setDrips((d) => [...d, drip]);
    setTimeout(() => setDrips((d) => d.filter((x) => x !== drip)), DRIP_MS);
  }));

  /** The purse's width: as wide as its roads. The ring sits at its left. */
  const [purse, setPurse] = createSignal(166);
  const day = () => (town().left ? `${town().people} people · ${town().left} left` : `${town().people} people · ${town().step - town().toward} more for the next pick`);

  return (
    <box w={purse() + 64} h={52}>
      {/* The glass, one shape, the drips running out of it. */}
      <glass layer="meter" at={{ right: 0, top: 0 }} w={purse() + 24} h={52} round={26} />
      <glass layer="meter" at={{ right: purse() + 2, top: -2 }} w={56} h={56} round={28} />
      <For each={drips()}>{() => <Drip />}</For>

      <box at={{ right: purse() + 2, top: -2 }} w={56} h={56} align="center" justify="center">
        <icon at={{ left: 0, top: 0 }} d={RING} view={56} size={56} stroke={3} ink="ink/0.12" />
        <Show when={cut() > 0}>
          <icon at={{ left: 0, top: 0 }} d={arc(cut())} view={56} size={56} stroke={3} ink={GDP} />
        </Show>
        <text serif size={21}>{town().people}</text>
      </box>
      <box at={{ right: 0, top: 0 }} minW={166} h={52} dir="row" align="center" justify="end" gap={6} pad={{ left: 12, right: 20 }} onSize={(w) => setPurse(w)}>
        <text serif size={28} ink={roads() < 5 ? BAD : undefined}>{roads().toLocaleString()}</text>
        <text size={12} weight={600} soft>{roads() === 1 ? "road" : "roads"}</text>
      </box>
      <For each={drips()}>{(d) => <Drip n={d.n} />}</For>
      {/* Who lives here and who left, under it. */}
      <Show when={wide()}>
        <text at={{ right: 20, top: 60 }} size={12.5} weight={600} soft ink={town().left ? BAD : undefined}>{day()}</text>
      </Show>
    </box>
  );
}

/** Road into the purse, dripping out under it: its glass, or, given
 *  how many, its coins on it. */
function Drip(props: { n?: number }) {
  const t = elapsed(DRIP_MS);
  const motion = {
    get y() { return keys(t(), [[0, 0], [0.12, 0], [0.7, 40], [1, 52]]); },
    get scale() { return keys(t(), [[0, 0.2], [0.12, 1], [0.7, 0.85], [1, 0.3]]); },
    get opacity() { return keys(t(), [[0, 0], [0.12, 1], [0.7, 1], [1, 0]]); },
  };
  return props.n === undefined ? (
    <glass layer="meter" dye={GOOD} at={{ right: 70, top: 12 }} w={38} h={28} round={14} {...motion} />
  ) : (
    <box at={{ right: 70, top: 12 }} w={38} h={28} align="center" justify="center" {...motion}>
      <text size={12} weight={700} ink="white">+{props.n}</text>
    </box>
  );
}
