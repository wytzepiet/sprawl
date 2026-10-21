/** @jsxImportSource ~ui */
import { createMemo, createRoot, createSignal, For, Index, Match, Show, Switch } from "solid-js";
import { useGame } from "../state/gameObjects";
import { sea } from "../state/sea";
import { change, market, quoteOf, stocks, total } from "../state/market";
import { home } from "../state/deals";
import { GOODS } from "../blueprints";
import { Shelf } from "./Depot";
import { Line, Press, Tabs } from "./kit";
import { open, setOpen, sheetWidth, show } from "./sheet";
import { Holdings, Orders } from "./Stock";
import { PageHead, push } from "./pages";
import type { Good, Quote, When } from "../generated";

/**
 * The market tab (docs/plan-market.md §The first version): every good,
 * what the town holds of it, its price and how it moved; a tap opens a
 * good's page: its week on a graph inside the world's band, what the
 * town pays and gets for a box at its harbour, its depots' room, Buy and
 * Sell so many boxes, and orders that wait for a price.
 *
 * Prices are a box's, the unit a deck and an order trade in.
 */

/** How frosted the glass under a chart is: its red and green read over any town. */
export const FROSTED = 1;
const UP = "#2E9D6A";
const DOWN = "#D9483B";
/** The most boxes a ferry's deck takes: the most bought or sold at once. */
const DECK = 15;

/** A box's worth, to the coin from a hundred and to the tenth below. */
export const money = (v: number) => (v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1));
export const box = (g: Good, unit: number) => unit * GOODS[g].box;
export const named = (g: Good) => GOODS[g].label[0].toUpperCase() + GOODS[g].label.slice(1);
/** A move's colour: up, down, or too small to call. */
export const tint = (c: number) => (Math.abs(c) < 0.005 ? "ink/0.5" : c > 0 ? UP : DOWN);
export const percent = (c: number) => `${c > 0 ? "+" : c < 0 ? "−" : ""}${Math.abs(c * 100).toFixed(Math.abs(c) < 0.1 ? 1 : 0)}%`;

/** Every good held, with what is on its way in. */
export const held = createRoot(() =>
  createMemo(() => {
    const sum = new Map<Good, { level: number; cap: number; incoming: number }>();
    for (const [g, s] of Object.entries(stocks()) as [Good, { level: number; cap: number }][])
      sum.set(g, { ...s, incoming: sea.shipments.filter((x) => x.good === g && !x.outbound).reduce((a, x) => a + x.units, 0) });
    return sum;
  }),
);

/**
 * A price over time, drawn in boxes: a column from each hour's price to
 * the next, a line where they meet, and the ground under it faint; lines
 * across it where asked. `lo` and `hi` are the bottom and the top.
 */
function Chart(props: { history: number[]; lo: number; hi: number; w: number; h: number; color: string; marks?: { at: number; color: string; dashed?: boolean; label?: string }[] }) {
  const y = (v: number) => props.h * (1 - (v - props.lo) / Math.max(1e-9, props.hi - props.lo));
  const step = () => props.w / Math.max(1, props.history.length - 1);
  const t = () => Math.max(1.5, props.h / 60);
  return (
    <box w={props.w} h={props.h} clip>
      <Index each={props.marks ?? []}>
        {(m) => (
          <>
            <Show when={m().dashed} fallback={<box at={{ left: 0, top: y(m().at) - 0.5 }} w={props.w} h={1} fill={m().color} />}>
              <Index each={Array.from({ length: Math.ceil(props.w / 9) })}>{(_, i) => <box at={{ left: i * 9, top: y(m().at) - 0.75 }} w={5} h={1.5} fill={m().color} />}</Index>
            </Show>
            <Show when={m().label}>
              <box at={{ right: 2, top: Math.min(props.h - 14, Math.max(0, y(m().at) - 15)) }}>
                <text size={10.5} weight={600} ink={m().color}>{m().label}</text>
              </box>
            </Show>
          </>
        )}
      </Index>
      <Index each={props.history}>
        {(v, i) => {
          const next = () => props.history[Math.min(i + 1, props.history.length - 1)];
          const top = () => Math.min(y(v()), y(next()));
          return (
            <>
              <box at={{ left: i * step(), top: y(v()) }} w={Math.max(1, step())} h={props.h - y(v())} fill={`${props.color}1c`} />
              <Show when={i < props.history.length - 1 || props.history.length === 1}>
                <box at={{ left: i * step() - t() / 2, top: top() - t() / 2 }} w={Math.max(step(), 0) + t()} h={Math.abs(y(v()) - y(next())) + t()} round={t() / 2} fill={props.color} />
              </Show>
            </>
          );
        }}
      </Index>
    </box>
  );
}

/** The day's line, small, for the list: on one scale for every good, a
 *  half either side of the world's price, so a steady good looks steady. */
function Spark(props: { q: Quote }) {
  const day = () => props.q.history.slice(-25);
  const mid = () => (props.q.floor + props.q.ceiling) / 2;
  return <Chart history={day().length ? day() : [props.q.price]} lo={mid() * 0.6} hi={mid() * 1.4} w={64} h={26} color={tint(change(props.q)) === "ink/0.5" ? "#8A8F8C" : tint(change(props.q))} />;
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
    <Match when={view() === "market"}><List /></Match>
    <Match when={view() === "stock"}><Holdings /></Match>
    <Match when={view() === "orders"}><Orders /></Match>
  </Switch>
);

/** A good's page, as the page stack shows it. */
export const goodPage = (g: Good) => ({ key: `good:${g}`, view: () => <Page good={g} />, frost: FROSTED });
/** The market, and a good's page over it: a mission's step. */
export const toMarket = (g: Good | null) => (setView("market"), show("market", true), g && push(goodPage(g)));

/** Every good: what the town holds, the day's line, the price and its move. */
function List() {
  return (
    <box pad={{ x: 12, bottom: 12 }} gap={6}>
      <For each={market.goods}>
        {(q) => (
          <Press dir="row" align="center" gap={10} pad={{ x: 10, y: 8 }} round={16} fill="ink/0.05" onTap={() => push(goodPage(q.good))}>
            <Tile good={q.good} />
            <box grow={1} gap={1}>
              <text size={14.5} weight={600}>{named(q.good)}</text>
              <text size={12} soft>{held().has(q.good) ? `${Math.floor(held().get(q.good)!.level)} held` : "none held"}</text>
            </box>
            <Spark q={q} />
            <box w={64} align="end">
              <text serif size={16}>{money(box(q.good, q.price))}</text>
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
      <box w={6} h={26} round={3} fill="#7A5BC0" />
      <text size={13.5} grow={1}>
        {props.o.out ? "Sell" : "Buy"} {props.o.boxes}{props.named ? ` ${GOODS[props.o.good].label}` : ""} when it {props.o.out ? "rises to" : "falls to"} <text serif>{money(box(props.o.good, props.o.price))}</text>
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
  const [boxes, setBoxes] = createSignal(1);
  const shown = () => (week() ? q().history : q().history.slice(-25));
  const orders = () => market.orders.filter((o) => o.good === props.good);
  const trade = (out: boolean) => send({ type: "Trade", data: { good: props.good, boxes: boxes(), out } });
  const cost = () => total(q(), boxes(), false);
  const harbour = () => home() !== null;

  // The "when" order being written: buying or selling, at what price a
  // unit, set a twentieth of the band at a tap, from just past today's.
  const tick = () => (q().ceiling - q().floor) / 20;
  const [out, setOut] = createSignal(false);
  const [at, setAt] = createSignal<number | null>(null);
  const price = () => at() ?? q().price + (out() ? tick() : -tick());
  const nudge = (by: number) => setAt(Math.max(q().floor, Math.min(q().ceiling, price() + by * tick())));
  const place = () => (send({ type: "Order", data: { good: props.good, out: out(), boxes: boxes(), price: price() } }), setAt(null));

  const range = () => {
    const pad = (q().ceiling - q().floor) * 0.08;
    return [q().floor - pad, q().ceiling + pad];
  };
  const stock = () => held().get(props.good);
  return (
    <box pad={{ bottom: 14 }} gap={10}>
      <PageHead>
        <Tile good={props.good} />
        <text size={17} weight={700} grow={1}>{named(props.good)}</text>
        <box align="end">
          <text serif size={22}>{money(box(props.good, q().price))}</text>
          <text size={11.5} weight={600} ink={tint(change(q()))}>{percent(change(q()))} today</text>
        </box>
      </PageHead>
      <box pad={{ x: 12 }} gap={10}>
      <box pad={{ x: 10, top: 10, bottom: 8 }} round={18} fill="ink/0.05" gap={8} onSize={(x) => setW(x - 20)}>
        <Show when={w() > 0}>
          <Chart
            history={shown().length ? shown() : [q().price]}
            lo={range()[0]}
            hi={range()[1]}
            w={w()}
            h={150}
            color={GOODS[props.good].color}
            marks={[
              { at: q().ceiling, color: "ink/0.3", label: `world sells ${money(box(props.good, q().ceiling))}` },
              { at: q().floor, color: "ink/0.3", label: `world buys ${money(box(props.good, q().floor))}` },
              ...orders().map((o) => ({ at: o.price, color: "#7A5BC0", dashed: true, label: `${o.out ? "sell" : "buy"} ${o.boxes} at ${money(box(o.good, o.price))}` })),
            ]}
          />
        </Show>
        <box dir="row" gap={6}>
          <For each={[false, true]}>
            {(wk) => (
              <Press h={24} pad={{ x: 10 }} round={12} justify="center" fill={week() === wk ? "ink/0.85" : "ink/0.07"} onTap={() => setWeek(wk)}>
                <text size={12} weight={600} ink={week() === wk ? "glass" : "ink/0.6"}>{wk ? "Week" : "Day"}</text>
              </Press>
            )}
          </For>
        </box>
      </box>

      <Show when={stock()}>{(s) => <box pad={{ x: 4 }}><Shelf good={props.good} level={s().level} cap={s().cap} incoming={s().incoming} /></box>}</Show>

      <box dir="row" align="center" gap={8}>
        <Stepper value={`${boxes()}`} less={() => setBoxes(Math.max(1, boxes() - 1))} more={() => setBoxes(Math.min(DECK, boxes() + 1))} />
        <text size={13} soft grow={1}>{boxes() === 1 ? "box" : "boxes"} of {boxes() * GOODS[props.good].box}</text>
      </box>
      <box dir="row" gap={8}>
        <Press grow={1} dir="row" align="center" justify="center" gap={8} h={44} round={16} fill={UP} opacity={harbour() && growth().treasury >= cost() ? 1 : 0.4} onTap={() => harbour() && growth().treasury >= cost() && trade(false)}>
          <text size={15} weight={700} ink="white">Buy</text>
          <text serif size={15} ink="white">{money(cost())}</text>
        </Press>
        <Press grow={1} dir="row" align="center" justify="center" gap={8} h={44} round={16} stroke={[1.5, "ink/0.18"]} opacity={harbour() ? 1 : 0.4} onTap={() => harbour() && trade(true)}>
          <text size={15} weight={700}>Sell</text>
          <text serif size={15}>{money(total(q(), boxes(), true))}</text>
        </Press>
      </box>

      <box gap={6}>
        <For each={orders()}>{(o) => <Order o={o} />}</For>
        {/* An order, as a sentence: each part a tap to change. */}
        <box dir="row" align="center" gap={6} wrap>
          <Press h={30} pad={{ x: 12 }} round={15} justify="center" fill="ink/0.07" onTap={() => (setOut(!out()), setAt(null))}>
            <text size={13.5} weight={600}>{out() ? "Sell" : "Buy"} {boxes()}</text>
          </Press>
          <text size={13.5} soft>when it {out() ? "rises to" : "falls to"}</text>
          <Stepper value={money(box(props.good, price()))} less={() => nudge(-1)} more={() => nudge(1)} />
          <box grow={1} />
          <Press h={30} pad={{ x: 14 }} round={15} justify="center" fill="#7A5BC0" opacity={harbour() ? 1 : 0.4} onTap={() => harbour() && place()}>
            <text size={13.5} weight={600} ink="white">Place</text>
          </Press>
        </box>
      </box>
      </box>
    </box>
  );
}
