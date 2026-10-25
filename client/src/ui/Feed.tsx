/** @jsxImportSource ~ui */
import { createEffect, createSignal, For, Index, Show } from "solid-js";
import { groundOf, useGame } from "../state/gameObjects";
import { mayorsLorry, standing } from "../state/haul";
import { missionKey, neighbours, shownMissions } from "../state/missions";
import { news, until, type News } from "../state/sea";
import { setFollowing } from "../state/selection";
import { deals, letterOf, setSpread, spread, stepsOf, type Deal, type Piece } from "../state/deals";
import { quoteOf, total } from "../state/market";
import { toMarket } from "./Market";
import { BLUEPRINTS, GOODS, packages } from "../blueprints";
import { eye } from "../engine/OrthoCamera";
import { CHUNK_SIZE, CHUNK_SKIRT, CHUNK_STRIDE, TYPE_BY_BYTE } from "../engine/objects/terrainGeometry";
import { hold } from "./buildMode";
import { track } from "./Shipments";
import { Appear, Btn, COIN, coins, Crest, EYE, FERRY, GDP, GOOD, GoodDot, Line, Pop, Press, SEA, StepBar, view, wide } from "./kit";
import { Stack } from "./stack";
import type { BuildingKind, Mission, Step, TerrainType, Mayor } from "../generated";
import type { JSX } from "~ui/jsx-runtime";

/** Where the feed starts, and the room it leaves below it: on a wide
 *  screen the dock; on a phone the dial's row over it, and the dock and
 *  the sheet's head under it. */
const TOP = () => (wide() ? 24 : 76);
const BELOW = () => (wide() ? 112 : 180);

/** A card of the feed: a line of news, a mission, or a deal. */
type Note =
  | { key: string; kind: "news"; news: News }
  | { key: string; kind: "mission"; m: Mission }
  | { key: string; kind: "deal"; deal: Deal };

/**
 * The feed: everything that happens to
 * the town as a phone's notifications, top right, or across the top of a
 * phone. News drops in on top and goes by itself; a mission is pinned
 * while it is open; a deal stays while its packages are on their way. Folded,
 * the newest is in front and two more peek out under it, under its glass;
 * a tap spreads them out, a tap on one opens it.
 */
export default function Feed() {
  const room = () => view().h - TOP() - BELOW();
  const notes = (): Note[] => [
    ...[...news()].reverse().map((n) => ({ key: `news:${n.key}`, kind: "news" as const, news: n })),
    ...shownMissions().map((m) => ({ key: missionKey(m), kind: "mission" as const, m })),
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
            case "mission":
              return <MissionCard m={(n() as typeof note).m} open={focus() === note.key} onTap={() => tap(note.key)} />;
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
const LETTER = "M5 6h14a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-8a2 2 0 0 1 2 -2zM3 7l9 6 9-6";
const FLAG = "M5 3h2v18H5zM7 4h11l-2.5 4L18 12H7z";

/** A partner's crest, or the world's globe; an envelope on it for a letter's deal. */
export function Who(props: { partner: Mayor | null; size: number; letter?: boolean; ink?: string }) {
  const n = () => props.partner && neighbours().find((n) => n.mayor === props.partner);
  return (
    <box w={props.size} h={props.size}>
      <Show when={n()} fallback={<box w={props.size} h={props.size} round={props.size / 2} fill="ink/0.1" align="center" justify="center"><Line d={GLOBE} size={props.size * 0.6} ink={props.ink} /></box>}>
        {(n) => <Crest n={n()} size={props.size} />}
      </Show>
      <Show when={props.letter}>
        <box at={{ right: -6, bottom: -4 }} w={17} h={17} round={8.5} fill={COIN} align="center" justify="center">
          <Line d={LETTER} size={11} width={2.2} ink="white" />
        </box>
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
  const count = () => d().pieces.length + d().wanted;
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
  const letter = () => letterOf(d().good, d().partner);
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
    if (l) return l.words;
    return `wants ${packages(d().good, d().wanted)}`;
  };
  const when = () => (d().done ? null : lead()?.eta ?? (lead() ? null : d().due));
  const sendAll = () => {
    const l = letter();
    if (l) send({ type: "Send", data: { letter: l.letter, packages: l.packages } });
  };
  const money = () => (d().coins >= 0 ? GOOD : "ink");
  return (
    <box>
      <box pad={{ x: 12, top: 10, bottom: 12 }} gap={8} onTap={props.onTap}>
        <box dir="row" align="center" gap={10}>
          <Tile color={GOODS[d().good].color} d={GOODS[d().good].glyph}>
            <box at={{ right: -6, bottom: -6 }}>
              <Who partner={d().partner} size={20} letter={d().letter !== null} ink="white" />
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
            <Show when={letter()}>
              {(l) => (
                <Press dir="row" align="center" gap={6} h={36} pad={{ x: 14 }} round={18} fill={COIN} onTap={sendAll}>
                  <text size={14} weight={600} ink="white">Send {l().packages}</text>
                  <text serif size={14} ink="white">{coins(l().price * GOODS[d().good].per * l().packages)}</text>
                </Press>
              )}
            </Show>
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

/** What finishing a mission pays; landed, once it is finished. */
function Reward(props: { m: Mission }) {
  const coins = () => (props.m.reward.kind === "Coins" ? props.m.reward.data : props.m.reward.data.coins);
  const lapsed = () => props.m.finished !== null && props.m.steps.some((s) => !s.done);
  return (
    <Show when={props.m.finished !== null} fallback={<text size={12} weight={600} soft>+{coins()}</text>}>
      <Show when={!lapsed()} fallback={<text size={11} weight={600} soft>lapsed</text>}>
        <Appear pad={{ y: 2, x: 8 }} round={10} fill={GOOD}>
          <text size={11} weight={700} ink="white">+{coins()} coins{props.m.reward.kind === "Order" ? `, +${props.m.reward.data.standing} standing` : ""}</text>
        </Appear>
      </Show>
    </Show>
  );
}

/** A mission as a card (docs/missions.md): its title, the step at hand,
 *  a bar of its steps and what it pays; opened, the step spelled out, with
 *  the button that does it. */
function MissionCard(props: { m: Mission; open: boolean; onTap: () => void }) {
  const at = () => props.m.steps.findIndex((s) => !s.done);
  const step = () => props.m.steps[at()];
  const done = () => props.m.steps.filter((s) => s.done).length;
  const color = () => (props.m.finished !== null ? GOOD : GDP);
  return (
    <box>
      <box pad={{ x: 12, top: 10, bottom: 12 }} gap={8} onTap={props.onTap}>
        <box dir="row" align="center" gap={10}>
          <Tile color={color()} d={FLAG} />
          <box grow={1} gap={2}>
            <text size={14.5} weight={600} lines={1}>{props.m.title}</text>
            <text size={12.5} soft lines={1}>{step()?.title ?? "Done"}</text>
          </box>
          <Reward m={props.m} />
        </box>
        <StepBar steps={props.m.steps.length} at={done() - 1} color={color()} />
      </box>
      <Show when={props.open && step()}>
        {(s) => (
          <Appear pad={{ x: 12, bottom: 12 }} gap={8} align="start">
            <Index each={s().text.split("\n\n")}>{(p) => <text size={12.5} soft lead={1.375}>{p()}</text>}</Index>
            <Act step={s()} />
          </Appear>
        )}
      </Show>
    </box>
  );
}

/** Where a kind is built: the harbour on the coast, the quarry at the
 *  mountain's foot, the sawmill at the forest's edge. */
const GROUND: Partial<Record<BuildingKind, TerrainType>> = { Harbour: "Sea", Quarry: "Mountain", Sawmill: "Forest" };

/** The camera to the nearest ground of a type it has, stopping a few
 *  tiles short so its edge fills the view: the town opens inland. */
function toward(ground: TerrainType) {
  const sea = (x: number, y: number) => {
    const [cx, cy] = [Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE)];
    const tiles = groundOf(cx, cy);
    return !!tiles && TYPE_BY_BYTE[tiles[(y - cy * CHUNK_SIZE + CHUNK_SKIRT) * CHUNK_STRIDE + x - cx * CHUNK_SIZE + CHUNK_SKIRT]] === ground;
  };
  const [x0, y0] = [Math.round(eye.x), Math.round(eye.y)];
  for (let r = 1; r < 96; r++)
    for (let d = -r; d <= r; d++)
      for (const [x, y] of [[x0 + d, y0 - r], [x0 + d, y0 + r], [x0 - r, y0 + d], [x0 + r, y0 + d]])
        if (sea(x, y)) return eye.go(x0 + ((x - x0) * (r - 4)) / r, y0 + ((y - y0) * (r - 4)) / r);
}

/** What the step at hand offers to do: a tool to take, a load to bring,
 *  a new deal to make. */
function Act(props: { step: Step }) {
  const { send } = useGame();
  /** The sawmill's bundle to the quay, on your lorry. */
  const sell = () => {
    const [from, to] = [standing("Sawmill"), props.step.at];
    if (from !== null && to !== null) send({ type: "Haul", data: { from, good: "Timber", packages: 1, to } });
  };
  return (
    <>
      {() => {
        const goal = props.step.goal;
        switch (goal.kind) {
          case "Stands": {
            const kind = goal.data;
            return <Btn onTap={() => (GROUND[kind] && toward(GROUND[kind]!), hold(kind))}>Take the {BLUEPRINTS[kind].label.toLowerCase()}</Btn>;
          }
          case "Settled":
            return <Btn onTap={() => hold("House")}>Take a house</Btn>;
          case "Sold":
            return <Btn big onTap={sell} color={BLUEPRINTS.Harbour.color} disabled={!mayorsLorry() || standing("Sawmill") === null}>Bring a bundle to the quay</Btn>;
          case "Booked":
            return <Btn big onTap={() => toMarket("Fuel")} color={BLUEPRINTS.Harbour.color}>Open the market</Btn>;
        }
      }}
    </>
  );
}
