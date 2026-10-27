import { Box, Text } from "~ui";
import { For, Show, createEffect, createSignal, on } from "solid-js";
import { BLUEPRINTS, GOODS } from "../blueprints";
import { Header, Pane } from "./Card";
import { BAD, bezel, CORNER, poll, view, wide } from "./kit";
import type { JSX } from "solid-js";
import type { BuildingKind, Good } from "../generated";

/** One day of the town's books: GDP, per kind of building it was added
 *  at, and coins across the border, per good. */
interface TownPage {
  gdp: Partial<Record<BuildingKind, number>>;
  sold: Partial<Record<Good, number>>;
  bought: Partial<Record<Good, number>>;
}

interface Town {
  gdp: number;
  treasury: number;
  today: TownPage;
  season: TownPage[];
}

const [open, setOpen] = createSignal(false);
export { open as boardOpen, setOpen as setBoardOpen };

const COL = 48;

const sum = (m: object) => (Object.values(m) as number[]).reduce((a, b) => a + b, 0);
const mean = (pages: TownPage[], f: (p: TownPage) => number) => (pages.length ? pages.reduce((a, p) => a + f(p), 0) / pages.length : 0);
const num = (v: number) => `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}`;

/**
 * The town's books, under the purse: the two dials read back by building
 * and by good. The GDP added today, per kind of building, adds up to the
 * level's step; the coins that crossed the border, per good, in and out,
 * add up to the treasury's. Beside each line, the same a day over the
 * season. docs/trade.md.
 */
export default function Board() {
  const [town, setTown] = createSignal<Town | null>(null);

  createEffect(on(open, (o) => {
    setTown(null);
    if (!o) return;
    poll("/town", 1000, setTown);
  }));

  /** Every line on any page, in the order the first page names them. */
  const keys = <K extends string>(t: Town, of: (p: TownPage) => Partial<Record<K, number>>) => [...new Set([t.today, ...t.season].flatMap((p) => Object.keys(of(p))))] as K[];

  return (
    <Show when={open() && town()}>
      {(t) => (
        <Pane layer="bezel" at={wide() ? { right: bezel(), top: bezel() + CORNER - 6 } : { left: bezel(), right: bezel(), top: bezel() + CORNER - 6 }} w={wide() ? 288 : undefined} room={view().h - (wide() ? 240 : 260)}>
          <Header title="The town" sub={`${t().season.length} ${t().season.length === 1 ? "day" : "days"} of books`} onClose={() => setOpen(false)} />
          <Part title="GDP" today={sum(t().today.gdp)} season={mean(t().season, (p) => sum(p.gdp))}>
            <For each={keys(t(), (p) => p.gdp)}>{(kind) => <Line label={BLUEPRINTS[kind].label} today={t().today.gdp[kind] ?? 0} season={mean(t().season, (p) => p.gdp[kind] ?? 0)} />}</For>
          </Part>
          <Part title="Coins in at the border" today={sum(t().today.sold)} season={mean(t().season, (p) => sum(p.sold))}>
            <For each={keys<Good>(t(), (p) => p.sold)}>{(good) => <Line label={GOODS[good].label} today={t().today.sold[good] ?? 0} season={mean(t().season, (p) => p.sold[good] ?? 0)} />}</For>
          </Part>
          <Part title="Coins out at the border" today={-sum(t().today.bought)} season={-mean(t().season, (p) => sum(p.bought))}>
            <For each={keys<Good>(t(), (p) => p.bought)}>{(good) => <Line label={GOODS[good].label} today={-(t().today.bought[good] ?? 0)} season={-mean(t().season, (p) => p.bought[good] ?? 0)} />}</For>
          </Part>
          <Part title="Treasury" today={sum(t().today.sold) - sum(t().today.bought)} season={mean(t().season, (p) => sum(p.sold) - sum(p.bought))}>
            <Line label="Holds" today={t().treasury} />
          </Part>
        </Pane>
      )}
    </Show>
  );
}

/** A heading with its total: today's, and a day's over the season. */
function Part(props: { title: string; today: number; season: number; children: JSX.Element }) {
  return (
    <Box pad={{ x: 16, y: 8 }}>
      <Box at={{ left: 16, top: 0, right: 16 }} h={1} fill="ink/0.08" />
      <Box dir="row" align="center" gap={0} minH={20}>
        <Text grow={1} size={12} weight={600} soft>{props.title}</Text>
        <Text w={COL} size={11} soft align="end">today</Text>
        <Text w={COL} size={11} soft align="end">a day</Text>
      </Box>
      <Line label="" today={props.today} season={props.season} bold />
      {props.children}
    </Box>
  );
}

function Line(props: { label: string; today: number; season?: number; bold?: boolean }) {
  return (
    <Box dir="row" align="center" minH={20}>
      <Text grow={1} size={13} soft lines={1}>{props.label}</Text>
      <Text w={COL} serif size={13} align="end" weight={props.bold ? 600 : undefined} ink={props.today < 0 ? BAD : undefined}>{num(props.today)}</Text>
      <Text w={COL} serif size={13} align="end" soft>{props.season === undefined ? "" : num(props.season)}</Text>
    </Box>
  );
}
