/** @jsxImportSource ~ui */
import { createMemo, createRoot, createSignal, For, Index, Match, Show, Switch } from "solid-js";
import { useGame } from "../state/gameObjects";
import { sea } from "../state/sea";
import { change, market, quoteOf, stocks, total } from "../state/market";
import { home } from "../state/deals";
import { GOODS } from "../blueprints";
import { LOAD } from "../generated/rows";
import { BAD, Fade, GoodDot, Line, Press, Tabs } from "./kit";
import { open, setOpen, show } from "./sheet";
import { Holdings } from "./Stock";
import { PageHead, push } from "./pages";
import type { Good, Quote } from "../generated";

/**
 * The market tab (docs/plan-market.md §The first version): every good,
 * what the town holds of it, its price and how it moved; a tap opens a
 * good's page: its week on a graph inside the world's band, what the
 * town pays and gets for a package at its harbour, its depots' room, Buy
 * and Sell so many packages, and the line the town's offices keep it at
 * (docs/core.md §Trade).
 *
 * Prices are a package's, the unit a deck trades in.
 */

/** How frosted the glass under a chart is: its red and green read over any town. */
export const FROSTED = 1;
const UP = "#2E9D6A";
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
 * A price over time, drawn in packages: a column from each hour's price to
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

/** What the market tab shows: every good's price, or what the town holds. */
const VIEWS = ["market", "stock"] as const;
const [view, setView] = createSignal<(typeof VIEWS)[number]>("market");
export { setView };

/** The market's head: its tab bar. */
export const MarketHead = () => <Tabs tabs={VIEWS} on={view()} lit={open()} pick={(v) => (setView(v), setOpen(true))} />;

export const MarketBody = () => (
  <Switch>
    <Match when={view() === "market"}><Fade><List /></Fade></Match>
    <Match when={view() === "stock"}><Fade><Holdings /></Fade></Match>
  </Switch>
);

/** A good's page, as the page stack shows it. */
export const goodPage = (g: Good) => ({ key: `good:${g}`, view: () => <Page good={g} />, frost: FROSTED });
/** The market, and a good's page over it. */
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
              <text serif size={16}>{money(each(q.good, q.price))}</text>
              <text size={11.5} weight={600} ink={tint(change(q))}>{percent(change(q))}</text>
            </box>
          </Press>
        )}
      </For>
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
  const kept = () => market.lines.find((l) => l.good === props.good)?.keep ?? null;
  const trade = (out: boolean) => send({ type: "Trade", data: { good: props.good, packages: n(), out } });
  const cost = () => total(q(), n(), false);
  const harbour = () => home() !== null;

  // The line, stepped a lorry's load at a time; set first at what is held.
  const per = () => GOODS[props.good].per * LOAD;
  const keep = (k: number | null) => send({ type: "Line", data: { good: props.good, keep: k === null ? null : Math.max(0, k) } });
  const start = () => Math.round((stock()?.level ?? 0) / per()) * per();

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
          <text serif size={22}>{money(each(props.good, q().price))}</text>
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
              { at: q().ceiling, color: "ink/0.3", label: `world sells ${money(each(props.good, q().ceiling))}` },
              { at: q().floor, color: "ink/0.3", label: `world buys ${money(each(props.good, q().floor))}` },
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

      <Show when={stock()}>{(s) => <box pad={{ x: 4 }}><Shelf good={props.good} level={s().level} cap={s().cap} incoming={s().incoming} keep={kept()} /></box>}</Show>

      <box dir="row" align="center" gap={8}>
        <Stepper value={`${n()}`} less={() => setN(n() > LOAD ? n() - LOAD : Math.max(1, n() - 1))} more={() => setN(Math.min(DECK, n() < LOAD ? n() + 1 : n() + LOAD))} />
        <text size={13} soft grow={1}>{GOODS[props.good].names[n() === 1 ? 0 : 1]}, {n() * GOODS[props.good].per}</text>
      </box>
      <box dir="row" gap={8}>
        <Press grow={1} dir="row" align="center" justify="center" gap={8} h={44} round={16} fill={UP} opacity={harbour() && growth().treasury >= cost() ? 1 : 0.4} onTap={() => harbour() && growth().treasury >= cost() && trade(false)}>
          <text size={15} weight={700} ink="white">Buy</text>
          <text serif size={15} ink="white">{money(cost())}</text>
        </Press>
        <Press grow={1} dir="row" align="center" justify="center" gap={8} h={44} round={16} stroke={[1.5, "ink/0.18"]} opacity={harbour() ? 1 : 0.4} onTap={() => harbour() && trade(true)}>
          <text size={15} weight={700}>Sell</text>
          <text serif size={15}>{money(total(q(), n(), true))}</text>
        </Press>
      </box>

      {/* The line: kept by the offices, there from the start, dimmed till one is staffed. */}
      <box gap={6} opacity={market.desks > 0 ? 1 : 0.5}>
        <box dir="row" align="center" gap={8}>
          <box w={6} h={26} round={3} fill={LINE} />
          <Show when={kept() !== null} fallback={<text size={13.5} grow={1}>No line: only what you buy and sell</text>}>
            <text size={13.5} grow={1}>Keep</text>
            <Stepper value={`${Math.round(kept()!)}`} less={() => keep(kept()! - per())} more={() => keep(kept()! + per())} />
          </Show>
          <Press h={30} pad={{ x: 12 }} round={15} justify="center" fill="ink/0.07" onTap={() => keep(kept() === null ? start() : null)}>
            <text size={13.5} weight={600}>{kept() === null ? "Set a line" : "Off"}</text>
          </Press>
        </box>
        <text size={12} soft>
          {market.desks <= 0
            ? "An office keeps this stocked: it buys up to the line and sells what is over it."
            : market.full
              ? `Trade desks full: your offices trade ${Math.round(market.desks)} packages a day; another trades more.`
              : `Bought up to the line and sold over it by your offices, ${Math.round(market.desks)} packages a day.`}
        </text>
      </box>
      </box>
    </box>
  );
}

/** A line's colour, on the shelf and beside its stepper. */
const LINE = "#7A5BC0";

/** A good's shelf: how full, what is on its way drawn faint beyond it,
 *  and the line it is kept at. */
function Shelf(props: { good: Good; level: number; cap: number; incoming: number; keep: number | null }) {
  const share = (v: number) => Math.max(0, Math.min(1, v / props.cap));
  const [w, setW] = createSignal(0);
  const color = () => GOODS[props.good].color;
  return (
    <box pad={{ y: 6 }} gap={8}>
      <box dir="row" align="center" gap={8}>
        <GoodDot good={props.good} size={20} />
        <text size={13.5} weight={600}>{named(props.good)}</text>
        <box dir="row" align="end" gap={2}>
          <text serif size={13.5}>{Math.floor(props.level)}</text>
          <text serif size={12} soft>/ {props.cap}</text>
        </box>
        <Show when={props.incoming > 0}>
          <text size={11} soft>+{Math.round(props.incoming)} coming</text>
        </Show>
      </box>
      <box h={14} round={7} fill="ink/0.09" onSize={(x) => setW(x)}>
        <box at={{ left: 0, top: 0 }} w={w() * share(props.level + props.incoming)} h={14} round={7} fill={`${color()}55`} />
        <box at={{ left: 0, top: 0 }} w={w() * share(props.level)} h={14} round={7} fill={color()} />
        <Show when={props.keep !== null}>
          <box at={{ left: Math.max(0, w() * share(props.keep!) - 1.5), top: -3 }} w={3} h={20} round={1.5} fill={LINE} />
        </Show>
      </box>
    </box>
  );
}
