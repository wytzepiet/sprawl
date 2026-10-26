/** @jsxImportSource ~ui */
import { createEffect, createSignal, For, Show } from "solid-js";
import { useGame } from "../state/gameObjects";
import { neighbours } from "../state/neighbours";
import { news, until, type News } from "../state/sea";
import { setFollowing } from "../state/selection";
import { deals, setSpread, spread, stepsOf, type Deal, type Piece } from "../state/deals";
import { quoteOf, total } from "../state/market";
import { GOODS } from "../blueprints";
import { track } from "./Shipments";
import { Appear, COIN, coins, Crest, EYE, FERRY, GOOD, GoodDot, Line, Pop, Press, SEA, StepBar, view, wide } from "./kit";
import { Stack } from "./stack";
import type { Mayor } from "../generated";
import type { JSX } from "~ui/jsx-runtime";

/** Where the feed starts, and the room it leaves below it: on a wide
 *  screen the dock; on a phone the dial's row over it, and the dock and
 *  the sheet's head under it. */
const TOP = () => (wide() ? 24 : 76);
const BELOW = () => (wide() ? 112 : 180);

/** A card of the feed: a line of news, or a deal. */
type Note =
  | { key: string; kind: "news"; news: News }
  | { key: string; kind: "deal"; deal: Deal };

/**
 * The feed: everything that happens to
 * the town as a phone's notifications, top right, or across the top of a
 * phone. News drops in on top and goes by itself; a deal stays while its packages are on their way. Folded,
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
    <box at={wide() ? { right: 24, top: TOP() } : { left: 12, right: 12, top: TOP() }} w={wide() ? 340 : undefined} gap={8}>
      <Stack each={notes()} key={(n) => n.key} open={spread()} room={room()} keep={focus()} glass="note" round={20}>
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
        <box align="center">
          <glass layer="note-fold" round={16} w={56} h={32} align="center" justify="center" onTap={() => (setSpread(false), setFocus(null))}>
            <Line d="M6 15l6-6 6 6" size={17} width={2.6} />
          </glass>
        </box>
      </Show>
    </box>
  );
}

/** A square of colour with a glyph on it: what a card is about. */
const Tile = (props: { color: string; d: string; children?: JSX.Element }) => (
  <box w={36} h={36} round={11} fill={props.color} align="center" justify="center">
    <icon d={props.d} size={20} ink="white" />
    {props.children}
  </box>
);

/** A line of news: the ferry in, the ferry gone, coins spent; a tap goes there. */
function NewsCard(props: { news: News }) {
  return (
    <box dir="row" align="center" gap={10} pad={{ y: 10, x: 12 }} onTap={() => setFollowing(props.news.at)}>
      <Tile color={props.news.coins ? COIN : SEA} d={props.news.coins ? COINS : FERRY} />
      <box grow={1} gap={2}>
        <text size={14.5} weight={600} lines={1}>{props.news.text}</text>
        <text size={12.5} soft lines={1}>{props.news.sub}</text>
      </box>
    </box>
  );
}

const COINS = "M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 9.5c0 1.7 3.6 3 8 3s8-1.3 8-3V12c0 1.7-3.6 3-8 3s-8-1.3-8-3zM4 15.5c0 1.7 3.6 3 8 3s8-1.3 8-3V18c0 1.7-3.6 3-8 3s-8-1.3-8-3z";
const GLOBE = "M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18";

/** A partner's crest, or the world's globe. */
export function Who(props: { partner: Mayor | null; size: number; ink?: string }) {
  const n = () => props.partner && neighbours().find((n) => n.mayor === props.partner);
  return (
    <box w={props.size} h={props.size}>
      <Show when={n()} fallback={<box w={props.size} h={props.size} round={props.size / 2} fill="ink/0.1" align="center" justify="center"><Line d={GLOBE} size={props.size * 0.6} ink={props.ink} /></box>}>
        {(n) => <Crest n={n()} size={props.size} />}
      </Show>
    </box>
  );
}

/** Who a deal is with, in words: a mayor's name, or the world. */
export const nameOf = (partner: Mayor | null) => (partner && neighbours().find((n) => n.mayor === partner)?.name) ?? "the world";

function Card(props: { deal: Deal; open: boolean; onTap: () => void }) {
  const { send } = useGame();
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
  /** A package more, from the market or for it, at what it pays or costs one now. */
  const more = () => {
    const q = d().partner === null && d().key !== "gift" ? quoteOf(d().good) : undefined;
    return q && total(q, 1, d().out);
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
    <box>
      <box pad={{ x: 12, top: 10, bottom: 12 }} gap={8} onTap={props.onTap}>
        <box dir="row" align="center" gap={10}>
          <Tile color={GOODS[d().good].color} d={GOODS[d().good].glyph}>
            <box at={{ right: -6, bottom: -6 }}>
              <Who partner={d().partner} size={20} ink="white" />
            </box>
          </Tile>
          <box grow={1} gap={2}>
            <box dir="row" align="center" gap={6}>
              <text size={14.5} weight={600} lines={1}>{title()}</text>
              <Show when={count() > 1}><text size={14.5} weight={600} soft>×{count()}</text></Show>
            </box>
            <text size={12.5} soft lines={1}>{status()}</text>
          </box>
          <Show when={d().done} fallback={<Show when={when()}>{(t) => <text serif size={17}>{until(t())}</text>}</Show>}>
            <Pop><text serif size={18} ink={money()}>{coins(d().coins)}</text></Pop>
          </Show>
        </box>
        <StepBar steps={stepsOf(d().out)} at={d().done ? Infinity : lead()?.step ?? -1} color={color()} />
      </box>
      <Show when={props.open && !d().done}>
        <Appear pad={{ x: 12, bottom: 12 }} gap={8}>
          <box>
            <For each={rows()}>
              {(b) => (
                <box dir="row" align="center" gap={8} pad={4} round={12} onTap={b.seen ? () => track(b.package) : undefined}>
                  <GoodDot good={d().good} size={20} />
                  <text size={13} lines={1} grow={1}>{b.n > 1 ? `${b.n} ${b.words}` : b.words}</text>
                  <Show when={b.eta}>{(t) => <text serif size={13}>{until(t())}</text>}</Show>
                  <Show when={b.seen}><Line d={EYE} size={14} width={2.4} ink="ink/0.72" /></Show>
                </box>
              )}
            </For>
          </box>
          <box dir="row" align="center" gap={6}>
            <Show when={d().pieces.length}>
              <text serif size={17} ink={money()}>{coins(d().coins)}</text>
            </Show>
            <box grow={1} />
            <Show when={more()}>
              {(c) => (
                <Press dir="row" align="center" gap={4} h={36} pad={{ x: 12 }} round={18} stroke={[2, "ink/0.15"]} onTap={() => send({ type: "Trade", data: { good: d().good, packages: 1, out: d().out } })}>
                  <text size={14} weight={600} soft>+ 1</text>
                  <text serif size={14} soft>{coins((d().out ? 1 : -1) * c())}</text>
                </Press>
              )}
            </Show>
          </box>
        </Appear>
      </Show>
    </box>
  );
}
