import { Box, Ink, Text, Icon } from "~ui";
import { createEffect, createSignal, For, on, Show } from "solid-js";
import { useGame } from "../state/gameObjects";
import { follow } from "../engine/spring";
import { setBoardOpen } from "./Board";
import { BAD, bezel, CORNER, DROP, elapsed, GDP, GOOD, keys, view, wide, ROUND } from "./kit";

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
 * The city's two dials, grown out of the bezel's top right corner: the
 * level, a ring closing on the next, and the purse; on a phone half a
 * band across the top, the clock the other half.
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

  return (
    <>
      <Ink layer="bezel" at={{ right: -DROP, top: -DROP }} w={wide() ? undefined : view().w / 2 + DROP + 30} h={DROP + bezel() + CORNER} round={ROUND} pad={{ right: DROP + bezel() + 14, left: 10, top: DROP + bezel() }} dir="row" align="center" justify="end" gap={7} onTap={() => setBoardOpen((o) => !o)}>
        <Box w={28} h={28} align="center" justify="center">
          <Icon at={{ left: 0, top: 0 }} d={RING} view={56} size={28} stroke={4.5} ink="ink/0.16" />
          <Show when={cut() > 0}>
            <Icon at={{ left: 0, top: 0 }} d={arc(cut())} view={56} size={28} stroke={4.5} ink={GDP} />
          </Show>
          <Text serif size={13}>{growth().level}</Text>
        </Box>
        <Text serif size={20} ink={low() ? BAD : undefined}>{Math.floor(treasury()).toLocaleString()}</Text>
        <Text size={11.5} weight={600} soft>coins</Text>
      </Ink>
      <For each={drips()}>{(d) => <Drip n={d.n} />}</For>
    </>
  );
}

/** A lump into the purse, dripping out of the corner as a drop of
 *  green pinched off the black, its coins on it. */
function Drip(props: { n: number }) {
  const t = elapsed(DRIP_MS);
  const y = () => keys(t(), [[0, 0], [0.15, 0], [0.7, 44], [1, 60]]);
  const s = () => keys(t(), [[0, 0.3], [0.15, 1], [0.7, 0.85], [1, 0.3]]);
  const o = () => keys(t(), [[0, 0], [0.12, 1], [0.75, 1], [1, 0]]);
  const at = () => ({ right: bezel() + 70, top: bezel() + CORNER - 22 });
  return (
    <>
      <Ink layer="bezel" dye={GOOD} at={at()} w={40} h={26} round={13} y={y()} scale={s()} opacity={o()} />
      <Box at={at()} w={40} h={26} align="center" justify="center" y={y()} scale={s()} opacity={o()}>
        <Text size={11.5} weight={700} ink="white">+{props.n}</Text>
      </Box>
    </>
  );
}
