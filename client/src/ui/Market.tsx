/** @jsxImportSource ~ui */
import { createMemo, createRoot, createSignal, For, Index, Match, Show, Switch } from "solid-js";
import { useGame } from "../state/gameObjects";
import { sea } from "../state/sea";
import { change, market, quoteOf, stocks, total } from "../state/market";
import { home } from "../state/deals";
import { GOODS } from "../blueprints";
import { LOAD } from "../generated/rows";
import { BAD, Fade, GOOD, Line, Press, Tabs } from "./kit";
import { open, setOpen, show } from "./sheet";
import { Holdings, Orders } from "./Stock";
import { PageHead, push } from "./pages";
import type { Good, Quote, When } from "../generated";

/**
 * The market tab (docs/plan-market.md §The first version): every good,
 * what the town holds of it, its price and how it moved; a tap opens a
 * good's page: its week on a graph inside the world's band, what the
 * town pays and gets for a package at its harbour, its depots' room, Buy
 * and Sell so many packages, and orders that wait for a price.
 *
 * Prices are a package's, the unit a deck and an order trade in.
 */

const UP = GOOD;
/** An order's colour, on the graph and in the list. */
const ORDER = "#BF5AF2";
/** The most packages a ferry's deck takes: the most bought or sold at once. */
const DECK = 60;

/** A package's worth, to the coin from a hundred and to the tenth below. */
export const money = (v: number) => (v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1));
export const each = (g: Good, unit: number) => unit * GOODS[g].per;
export const named = (g: Good) => GOODS[g].label[0].toUpperCase() + GOODS[g].label.slice(1);
/** A move's colour: up, down, or too small to call. */
export const tint = (c: number) => (Math.abs(c) < 0.005 ? "ink/0.5" : c > 0 ? UP : BAD);
export const percent = (c: number) => `${c > 0 ? "+" : c < 0 ? "−" : ""}${Math.abs(c * 100).toFixed(Math.abs(c) < 0.1 ? 1 : 0)}%`;

/** Every good held, with what is on its way in. */
export const held = createRoot(() =>
  createMemo(() => {
    const sum = new Map<Good, { level: number; cap: number; incoming: number }>();
    for (const [g, s] of Object.entries(stocks()) as [Good, { level: number; cap: number }][])
      sum.set(g, { ...s, incoming: sea.shipments.filter((x) => x.good === g && !x.outbound).reduce((a, x) => a + GOODS[x.good].per, 0) });
    return sum;
  }),
);

/**
 * A price over time as bars, rising from the bottom in the good's colour,
 * the last white: the price now. As many as fit, a bar twice as wide as
 * its gap, each the mean of its hours, and a short history at the right,
 * the room before it still to fill. Lines across it where asked. `lo`
 * and `hi` are the bottom and the top.
 */
function Bars(props: { history: number[]; lo: number; hi: number; w: number; h: number; color: string; gap: number; marks?: { at: number; color: string; dashed?: boolean; label?: string }[] }) {
  const y = (v: number) => props.h * (1 - (v - props.lo) / Math.max(1e-9, props.hi - props.lo));
  const slots = () => Math.max(1, Math.floor((props.w + props.gap) / (3 * props.gap)));
  const bars = () => {
    const all = props.history;
    const n = Math.min(all.length, slots());
    return Array.from({ length: n }, (_, i) => {
      const some = all.slice(Math.floor((i * all.length) / n), Math.max(Math.floor((i * all.length) / n) + 1, Math.floor(((i + 1) * all.length) / n)));
      return some.reduce((a, v) => a + v, 0) / some.length;
    });
  };
  const bw = () => (props.w + props.gap) / slots() - props.gap;
  const first = () => slots() - bars().length;
  return (
    <box w={props.w} h={props.h} clip>
      <Index each={bars()}>
        {(v, i) => <box at={{ left: (first() + i) * (bw() + props.gap), top: y(v()) }} w={bw()} h={props.h - y(v())} round={Math.min(bw() / 2, 4)} fill={i === bars().length - 1 ? "white" : props.color} />}
      </Index>
      <Index each={props.marks ?? []}>
        {(m) => (
          <>
            <Show when={m().dashed} fallback={<box at={{ left: 0, top: y(m().at) - 0.5 }} w={props.w} h={1} fill={m().color} />}>
              <Index each={Array.from({ length: Math.ceil(props.w / 9) })}>{(_, i) => <box at={{ left: i * 9, top: y(m().at) - 0.75 }} w={5} h={1.5} fill={m().color} />}</Index>
            </Show>
            <Show when={m().label}>
              <box at={{ left: 2, top: Math.min(props.h - 14, Math.max(0, y(m().at) - 15)) }}>
                <text size={10.5} weight={600} ink={m().color}>{m().label}</text>
              </box>
            </Show>
          </>
        )}
      </Index>
    </box>
  );
}

/** The day, small, for the list: on one scale for every good, a half
 *  either side of the world's price, so a steady good looks steady. */
function Spark(props: { q: Quote }) {
  const day = () => props.q.history.slice(-25);
  const mid = () => (props.q.floor + props.q.ceiling) / 2;
  return <Bars history={day().length ? day() : [props.q.price]} lo={mid() * 0.6} hi={mid() * 1.4} w={60} h={26} gap={2} color={GOODS[props.q.good].color} />;
}

/** A good's tile: its glyph on a square of its colour. */
export const Tile = (props: { good: Good; size?: number }) => (
  <box w={props.size ?? 32} h={props.size ?? 32} round={(props.size ?? 32) * 0.3} fill={GOODS[props.good].color} align="center" justify="center">
    <icon d={GOODS[props.good].glyph} size={(props.size ?? 32) * 0.58} ink="white" />
  </box>
);

/** What the market tab shows: every good's price, what the town holds, or its orders. */
const VIEWS = ["market", "stock", "orders"] as const;
const [view, setView] = createSignal<(typeof VIEWS)[number]>("market");
export { setView };

/** The market's head: its tab bar. */
export const MarketHead = () => <Tabs tabs={VIEWS} on={view()} lit={open()} pick={(v) => (setView(v), setOpen(true))} />;

export const MarketBody = () => (
  <Switch>
    <Match when={view() === "market"}><Fade><List /></Fade></Match>
    <Match when={view() === "stock"}><Fade><Holdings /></Fade></Match>
    <Match when={view() === "orders"}><Fade><Orders /></Fade></Match>
  </Switch>
);

/** A good's page, as the page stack shows it. */
export const goodPage = (g: Good) => ({ key: `good:${g}`, view: () => <Page good={g} /> });
/** The market, and a good's page over it: a mission's step. */
export const toMarket = (g: Good | null) => (setView("market"), show("market", true), g && push(goodPage(g)));

/** Every good: what the town holds, the day's line, the price and its move. */
function List() {
  return (
    <box pad={{ x: 12, bottom: 12 }} gap={2}>
      <For each={market.goods}>
        {(q) => (
          <Press dir="row" align="center" gap={12} pad={{ x: 4, y: 8 }} round={16} onTap={() => push(goodPage(q.good))}>
            <Tile good={q.good} />
            <box grow={1} gap={1}>
              <text size={14.5} weight={600}>{named(q.good)}</text>
              <text size={12} soft>{held().has(q.good) ? `${Math.floor(held().get(q.good)!.level)} held` : "none held"}</text>
            </box>
            <Spark q={q} />
            <box w={64} align="end">
              <text serif size={18}>{money(each(q.good, q.price))}</text>
              <text size={11.5} weight={600} ink={tint(change(q))}>{percent(change(q))}</text>
            </box>
          </Press>
        )}
      </For>
    </box>
  );
}

/** An order waiting on a price, as a sentence, and the cross that takes
 *  it back; `named`, with its good's name, where goods are mixed. */
export function Order(props: { o: When; named?: boolean }) {
  const { send } = useGame();
  return (
    <box dir="row" align="center" gap={10} pad={{ left: 10, right: 4, y: 4 }} round={14} fill="ink/0.05">
      <box w={6} h={26} round={3} fill={ORDER} />
      <text size={13.5} grow={1}>
        {props.o.out ? "Sell" : "Buy"} {props.o.packages}{props.named ? ` ${GOODS[props.o.good].label}` : ""} when it {props.o.out ? "rises to" : "falls to"} <text serif>{money(each(props.o.good, props.o.price))}</text>
      </text>
      <Press w={32} h={32} round={16} align="center" justify="center" onTap={() => send({ type: "Cancel", data: { order: props.o.id } })}>
        <Line d="M7 7l10 10M17 7L7 17" size={14} width={2.4} ink="ink/0.6" />
      </Press>
    </box>
  );
}

/** A number to set with a tap either side. */
function Stepper(props: { value: string; less: () => void; more: () => void }) {
  const Side = (p: { d: string; onTap: () => void }) => (
    <Press w={30} h={30} round={15} align="center" justify="center" onTap={p.onTap}>
      <Line d={p.d} size={14} width={2.6} />
    </Press>
  );
  return (
    <box dir="row" align="center" gap={2} pad={2} round={17} fill="ink/0.07">
      <Side d="M5 12h14" onTap={props.less} />
      <box minW={34} align="center"><text serif size={15}>{props.value}</text></box>
      <Side d="M5 12h14M12 5v14" onTap={props.more} />
    </box>
  );
}

/** A good's page. */
function Page(props: { good: Good }) {
  const { send, growth } = useGame();
  const q = () => quoteOf(props.good)!;
  const [w, setW] = createSignal(0);
  const [week, setWeek] = createSignal(true);
  const [n, setN] = createSignal(1);
  const shown = () => (week() ? q().history : q().history.slice(-25));
  const orders = () => market.orders.filter((o) => o.good === props.good);
  const trade = (out: boolean) => send({ type: "Trade", data: { good: props.good, packages: n(), out } });
  const cost = () => total(q(), n(), false);
  const harbour = () => home() !== null;

  // The "when" order being written: buying or selling, at what price a
  // unit, set a twentieth of the band at a tap, from just past today's.
  const tick = () => (q().ceiling - q().floor) / 20;
  const [out, setOut] = createSignal(false);
  const [at, setAt] = createSignal<number | null>(null);
  const price = () => at() ?? q().price + (out() ? tick() : -tick());
  const nudge = (by: number) => setAt(Math.max(q().floor, Math.min(q().ceiling, price() + by * tick())));
  const place = () => (send({ type: "Order", data: { good: props.good, out: out(), packages: n(), price: price() } }), setAt(null));

  const range = () => {
    const pad = (q().ceiling - q().floor) * 0.08;
    return [q().floor - pad, q().ceiling + pad];
  };
  const stock = () => held().get(props.good);
  return (
    <box pad={{ bottom: 14 }} gap={10}>
      <PageHead>
        <Tile good={props.good} />
        <text size={17} weight={700} grow={1} ink={GOODS[props.good].color}>{named(props.good)}</text>
      </PageHead>
      <box pad={{ x: 16 }} gap={12}>
      {/* The price now, big, how it moved, and the week or day behind it. */}
      <box dir="row" align="end" gap={8}>
        <text serif size={40}>{money(each(props.good, q().price))}</text>
        <box grow={1} pad={{ bottom: 7 }}>
          <text size={13} weight={600} ink={tint(change(q()))}>{percent(change(q()))} today</text>
        </box>
        <box dir="row" gap={12} pad={{ bottom: 7 }}>
          <For each={[false, true]}>
            {(wk) => (
              <box onTap={() => setWeek(wk)}>
                <text size={13} weight={600} ink={week() === wk ? "ink" : "ink/0.4"}>{wk ? "Week" : "Day"}</text>
              </box>
            )}
          </For>
        </box>
      </box>
      <box onSize={(x) => setW(x)}>
        <Show when={w() > 0}>
          <Bars
            history={shown().length ? shown() : [q().price]}
            lo={range()[0]}
            hi={range()[1]}
            w={w()}
            h={140}
            gap={3}
            color={GOODS[props.good].color}
            marks={[
              ...orders().map((o) => ({ at: o.price, color: ORDER, dashed: true, label: `${o.out ? "sell" : "buy"} ${o.packages} at ${money(each(o.good, o.price))}` })),
            ]}
          />
        </Show>
      </box>
      {/* The band the world keeps it in: the chart's bottom and top. */}
      <box dir="row">
        <text size={12} soft grow={1}>World buys at <text serif>{money(each(props.good, q().floor))}</text></text>
        <text size={12} soft>World sells at <text serif>{money(each(props.good, q().ceiling))}</text></text>
      </box>

      <Show when={stock()}>{(s) => <Shelf good={props.good} level={s().level} cap={s().cap} incoming={s().incoming} />}</Show>

      <box dir="row" align="center" gap={8}>
        <Stepper value={`${n()}`} less={() => setN(n() > LOAD ? n() - LOAD : Math.max(1, n() - 1))} more={() => setN(Math.min(DECK, n() < LOAD ? n() + 1 : n() + LOAD))} />
        <text size={13} soft grow={1}>{GOODS[props.good].names[n() === 1 ? 0 : 1]}, {n() * GOODS[props.good].per}</text>
      </box>
      <box dir="row" gap={8}>
        <Press grow={1} dir="row" align="center" justify="center" gap={8} h={46} round={23} fill={`${UP}38`} opacity={harbour() && growth().treasury >= cost() ? 1 : 0.4} onTap={() => harbour() && growth().treasury >= cost() && trade(false)}>
          <text size={15} weight={700} ink={UP}>Buy</text>
          <text serif size={16} ink={UP}>{money(cost())}</text>
        </Press>
        <Press grow={1} dir="row" align="center" justify="center" gap={8} h={46} round={23} fill="ink/0.14" opacity={harbour() ? 1 : 0.4} onTap={() => harbour() && trade(true)}>
          <text size={15} weight={700}>Sell</text>
          <text serif size={16}>{money(total(q(), n(), true))}</text>
        </Press>
      </box>

      <box gap={6}>
        <For each={orders()}>{(o) => <Order o={o} />}</For>
        {/* An order, as a sentence: each part a tap to change. */}
        <box dir="row" align="center" gap={6} wrap>
          <Press h={30} pad={{ x: 12 }} round={15} justify="center" fill="ink/0.07" onTap={() => (setOut(!out()), setAt(null))}>
            <text size={13.5} weight={600}>{out() ? "Sell" : "Buy"} {n()}</text>
          </Press>
          <text size={13.5} soft>when it {out() ? "rises to" : "falls to"}</text>
          <Stepper value={money(each(props.good, price()))} less={() => nudge(-1)} more={() => nudge(1)} />
          <box grow={1} />
          <Press h={30} pad={{ x: 14 }} round={15} justify="center" fill={`${ORDER}38`} opacity={harbour() ? 1 : 0.4} onTap={() => harbour() && place()}>
            <text size={13.5} weight={600} ink={ORDER}>Place</text>
          </Press>
        </box>
      </box>
      </box>
    </box>
  );
}

/** A good's shelf: how full, and what is on its way drawn faint beyond it. */
function Shelf(props: { good: Good; level: number; cap: number; incoming: number }) {
  const share = (v: number) => Math.max(0, Math.min(1, v / props.cap));
  const [w, setW] = createSignal(0);
  const color = () => GOODS[props.good].color;
  return (
    <box pad={{ y: 6 }} gap={8}>
      <box dir="row" align="center" gap={6}>
        <text serif size={20}>{Math.floor(props.level)}</text>
        <text size={12.5} soft grow={1}>of {props.cap} held</text>
        <Show when={props.incoming > 0}>
          <text size={12.5} weight={600} ink={color()}>+{Math.round(props.incoming)} coming</text>
        </Show>
      </box>
      <box h={14} round={7} fill="ink/0.14" onSize={(x) => setW(x)}>
        <box at={{ left: 0, top: 0 }} w={w() * share(props.level + props.incoming)} h={14} round={7} fill={`${color()}55`} />
        <box at={{ left: 0, top: 0 }} w={w() * share(props.level)} h={14} round={7} fill={color()} />
      </box>
    </box>
  );
}
