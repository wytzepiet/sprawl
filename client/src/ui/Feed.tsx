import { Box, Ink, Text, Icon } from "~ui";
import { createEffect, createSignal, For, Show } from "solid-js";
import { neighbours } from "../state/neighbours";
import { news, until, type News } from "../state/sea";
import { setFollowing } from "../state/selection";
import { deals, setSpread, spread, stepsOf, type Deal, type Piece } from "../state/deals";
import { boardOpen } from "./Board";
import { GOODS } from "../blueprints";
import { track } from "./Shipments";
import { Appear, bezel, COIN, coins, Crest, CORNER, EYE, FERRY, GOOD, GoodDot, Line, Pop, SEA, StepBar, view, wide, ROUND } from "./kit";
import { Stack } from "./stack";
import type { Mayor } from "../generated";
import type { JSX } from "solid-js";

/** Where the feed starts, and the room it leaves below it: on a wide
 *  screen the dock; on a phone the dial's row over it, and the dock and
 *  the sheet's head under it. */
const TOP = () => bezel() + CORNER + (wide() ? 14 : 12);
const BELOW = () => (wide() ? 112 : 180);

/** A card of the feed: a line of news, or a deal. */
type Note =
  | { key: string; kind: "news"; news: News }
  | { key: string; kind: "deal"; deal: Deal };

/**
 * The feed: everything that happens to
 * the town as a phone's notifications, top right, or across the top of a
 * phone, under the corners; out of the way while the books are open. News drops in on top and goes by itself; a deal stays while its packages are on their way. Folded,
 * the newest is in front and two more peek out under it, under its glass;
 * a tap spreads them out, a tap on one opens it.
 */
export default function Feed() {
  const room = () => view().h - TOP() - BELOW();
  const notes = (): Note[] => [
    ...[...news()].reverse().map((n) => ({ key: `news:${n.key}`, kind: "news" as const, news: n })),
    ...deals().map((d) => ({ key: `deal:${d.key}`, kind: "deal" as const, deal: d })),
  ];
  const [focus, setFocus] = createSignal<string | null>(null);
  /** Folded, a tap spreads the stack; spread, it opens the card tapped. */
  const tap = (key: string) => {
    if (!spread() && notes().length > 1) return setSpread(true);
    setFocus(focus() === key ? null : key);
  };
  createEffect(() => notes().length < 2 && setSpread(false));
  return (
    <Box at={wide() ? { right: bezel() + 14, top: TOP() } : { left: bezel() + 10, right: bezel() + 10, top: TOP() }} w={wide() ? 340 : undefined} gap={8} opacity={boardOpen() ? 0 : 1}>
      <Stack each={notes()} key={(n) => n.key} open={spread()} room={room()} keep={focus()} glass="note" round={ROUND}>
        {(n) => {
          const note = n();
          switch (note.kind) {
            case "news":
              return <NewsCard news={note.news} />;
            case "deal":
              return <Card deal={(n() as typeof note).deal} open={focus() === note.key} onTap={() => tap(note.key)} />;
          }
        }}
      </Stack>
      <Show when={spread()}>
        <Box align="center">
          <Ink layer="note-fold" round={16} w={56} h={32} align="center" justify="center" onTap={() => (setSpread(false), setFocus(null))}>
            <Line d="M6 15l6-6 6 6" size={17} width={2.6} />
          </Ink>
        </Box>
      </Show>
    </Box>
  );
}

/** A square of colour with a glyph on it: what a card is about. */
const Tile = (props: { color: string; d: string; children?: JSX.Element }) => (
  <Box w={36} h={36} round={14} fill={props.color} align="center" justify="center">
    <Icon d={props.d} size={20} ink="white" />
    {props.children}
  </Box>
);

/** A line of news: the ferry in, the ferry gone, coins spent; a tap goes there. */
function NewsCard(props: { news: News }) {
  return (
    <Box dir="row" align="center" gap={10} pad={{ y: 10, x: 12 }} onTap={() => setFollowing(props.news.at)}>
      <Tile color={props.news.coins ? COIN : SEA} d={props.news.coins ? COINS : FERRY} />
      <Box grow={1} gap={2}>
        <Text size={14.5} weight={600} lines={1}>{props.news.text}</Text>
        <Text size={12.5} soft lines={1}>{props.news.sub}</Text>
      </Box>
    </Box>
  );
}

const COINS = "M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 9.5c0 1.7 3.6 3 8 3s8-1.3 8-3V12c0 1.7-3.6 3-8 3s-8-1.3-8-3zM4 15.5c0 1.7 3.6 3 8 3s8-1.3 8-3V18c0 1.7-3.6 3-8 3s-8-1.3-8-3z";
const GLOBE = "M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18";

/** A partner's crest, or the world's globe. */
export function Who(props: { partner: Mayor | null; size: number; ink?: string }) {
  const n = () => props.partner && neighbours().find((n) => n.mayor === props.partner);
  return (
    <Box w={props.size} h={props.size}>
      <Show when={n()} fallback={<Box w={props.size} h={props.size} round={props.size / 2} fill="ink/0.1" align="center" justify="center"><Line d={GLOBE} size={props.size * 0.6} ink={props.ink} /></Box>}>
        {(n) => <Crest n={n()} size={props.size} />}
      </Show>
    </Box>
  );
}

/** Who a deal is with, in words: a mayor's name, or the world. */
export const nameOf = (partner: Mayor | null) => (partner && neighbours().find((n) => n.mayor === partner)?.name) ?? "the world";

function Card(props: { deal: Deal; open: boolean; onTap: () => void }) {
  const d = () => props.deal;
  const color = () => (d().done ? GOOD : GOODS[d().good].color);
  const lead = () => d().pieces[0];
  const count = () => d().pieces.length;
  /** Its packages by where they are: a row each, how many there. */
  const rows = () => {
    const l: (Piece & { n: number })[] = [];
    for (const p of d().pieces) {
      const r = l.find((r) => r.words === p.words);
      if (r) r.n++;
      else l.push({ ...p, n: 1 });
    }
    return l;
  };
  const title = () => (d().key === "gift" ? "The starter pack" : `${GOODS[d().good].label[0].toUpperCase()}${GOODS[d().good].label.slice(1)} ${d().out ? "for" : "from"} ${nameOf(d().partner)}`);
  /** Where it is, in words: its furthest package, or what it waits for. */
  const status = () => {
    if (d().done) return d().out ? "sold, and paid for" : "in the depot";
    const l = lead();
    return l?.words ?? "";
  };
  const when = () => (d().done ? null : lead()?.eta);
  const money = () => (d().coins >= 0 ? GOOD : "ink");
  return (
    <Box>
      <Box pad={{ x: 12, top: 10, bottom: 12 }} gap={8} onTap={props.onTap}>
        <Box dir="row" align="center" gap={10}>
          <Tile color={GOODS[d().good].color} d={GOODS[d().good].glyph}>
            <Box at={{ right: -6, bottom: -6 }}>
              <Who partner={d().partner} size={20} ink="white" />
            </Box>
          </Tile>
          <Box grow={1} gap={2}>
            <Box dir="row" align="center" gap={6}>
              <Text size={14.5} weight={600} lines={1}>{title()}</Text>
              <Show when={count() > 1}><Text size={14.5} weight={600} soft>×{count()}</Text></Show>
            </Box>
            <Text size={12.5} soft lines={1}>{status()}</Text>
          </Box>
          <Show when={d().done} fallback={<Show when={when()}>{(t) => <Text serif size={17}>{until(t())}</Text>}</Show>}>
            <Pop><Text serif size={18} ink={money()}>{coins(d().coins)}</Text></Pop>
          </Show>
        </Box>
        <StepBar steps={stepsOf(d().out)} at={d().done ? Infinity : lead()?.step ?? -1} color={color()} />
      </Box>
      <Show when={props.open && !d().done}>
        <Appear pad={{ x: 12, bottom: 12 }} gap={8}>
          <Box>
            <For each={rows()}>
              {(b) => (
                <Box dir="row" align="center" gap={8} pad={4} round={12} onTap={b.seen ? () => track(b.package) : undefined}>
                  <GoodDot good={d().good} size={20} />
                  <Text size={13} lines={1} grow={1}>{b.n > 1 ? `${b.n} ${b.words}` : b.words}</Text>
                  <Show when={b.eta}>{(t) => <Text serif size={13}>{until(t())}</Text>}</Show>
                  <Show when={b.seen}><Line d={EYE} size={14} width={2.4} ink="ink/0.72" /></Show>
                </Box>
              )}
            </For>
          </Box>
          <Box dir="row" align="center" gap={6}>
            <Show when={d().pieces.length}>
              <Text serif size={17} ink={money()}>{coins(d().coins)}</Text>
            </Show>
          </Box>
        </Appear>
      </Show>
    </Box>
  );
}
