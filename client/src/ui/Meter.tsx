/** @jsxImportSource ~ui */
import { createEffect, createSignal, For, on, Show } from "solid-js";
import { useGame } from "../state/gameObjects";
import { follow } from "../engine/spring";
import { setBoardOpen } from "./Board";
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
 * The city's two dials, run together into one shape at the top: the
 * level, a ring closing on the next, and the purse.
 *
 * The level is the town's GDP to date: the value it adds, landing as
 * each meal is served, each tank filled, each crop cut and each shift at
 * a desk worked. The purse is the town's coins, stepped at the border: a
 * box sold to the world as the ferry casts off, a box bought from it as
 * it lands; a tap opens the town's books. The coins are on the map first,
 * so what comes into the purse drips out of it as it lands: an event
 * you could have watched, never a rate.
 */
export default function Meter() {
  const { growth } = useGame();
  const treasury = () => growth().treasury;
  /** Days the treasury covers at today's imports; nothing crosses the door at zero. */
  const cover = () => (growth().imports > 0 ? treasury() / growth().imports : Infinity);
  const low = () => cover() < 3;
  const [fill] = follow(() => (growth().needed > 0 ? Math.min(1, Math.max(0, growth().toward / growth().needed)) : 0), { rest: 0.001 });
  const cut = () => Math.round(fill() * CUTS) / CUTS;

  const [drips, setDrips] = createSignal<{ id: number; n: number }[]>([]);
  let next = 0;
  createEffect(on(treasury, (now, before) => {
    if (before === undefined || now - before < 1) return;
    const drip = { id: next++, n: Math.floor(now - before) };
    setDrips((d) => [...d, drip]);
    setTimeout(() => setDrips((d) => d.filter((x) => x !== drip)), DRIP_MS);
  }));

  /** The purse's width: as wide as its coins. The ring sits at its left. */
  const [purse, setPurse] = createSignal(166);
  const day = () =>
    low() && Number.isFinite(cover())
      ? `${cover().toFixed(1)} days of imports · GDP today ${Math.floor(growth().gdp)}`
      : `${growth().income >= 0 ? "+" : "−"}${Math.abs(Math.floor(growth().income))} today · GDP today ${Math.floor(growth().gdp)}`;

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
        <text serif size={21}>{growth().level}</text>
      </box>
      <box at={{ right: 0, top: 0 }} minW={166} h={52} dir="row" align="center" justify="end" gap={6} pad={{ left: 12, right: 20 }} onSize={(w) => setPurse(w)} onTap={() => setBoardOpen((o) => !o)}>
        <text serif size={28} ink={low() ? BAD : undefined}>{Math.floor(treasury()).toLocaleString()}</text>
        <text size={12} weight={600} soft>coins</text>
      </box>
      <For each={drips()}>{(d) => <Drip n={d.n} />}</For>
      {/* What the day has done, under it. */}
      <Show when={wide()}>
        <text at={{ right: 20, top: 60 }} size={12.5} weight={600} soft>{day()}</text>
      </Show>
    </box>
  );
}

/** A lump into the purse, dripping out under it: its glass, or, given
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
