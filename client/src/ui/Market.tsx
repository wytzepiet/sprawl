/** @jsxImportSource ~ui */
import { createMemo, createRoot, createSignal, For, Index, Show } from "solid-js";
import { useGame } from "../state/gameObjects";
import { sea } from "../state/sea";
import { change, dayAgo, market, quoteOf, stocks, total } from "../state/market";
import { home } from "../state/deals";
import { GOODS } from "../blueprints";
import { LOAD } from "../generated/rows";
import { BAD, GOOD, Line, Press } from "./kit";
import { show } from "./sheet";
import { PageHead, push } from "./pages";
import type { Good, Quote } from "../generated";

/**
 * The market tab (docs/plan-market.md §The first version): what the town
 * holds is worth, then every good, what the town holds of it, its day
 * and its price; a tap opens a good's page: its week on a line, the
 * world's band, its depots' room, and Buy and Sell so many packages.
 *
 * Prices are a package's, the unit a deck trades in.
 */

/** The most packages a ferry's deck takes: the most bought or sold at once. */
const DECK = 60;

const money = (v: number) => (v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1));
const each = (g: Good, unit: number) => unit * GOODS[g].per;
const named = (g: Good) => GOODS[g].label[0].toUpperCase() + GOODS[g].label.slice(1);
/** A move's colour: up, down, or too small to call. */
const tint = (c: number) => (Math.abs(c) < 0.005 ? "ink/0.5" : c > 0 ? GOOD : BAD);
const percent = (c: number) => `${c > 0 ? "+" : c < 0 ? "−" : ""}${Math.abs(c * 100).toFixed(Math.abs(c) < 0.1 ? 1 : 0)}%`;

/**
 * A good's colour as it glows on the black: brighter and fuller than on
 * the map, where it is a box in the sun. The accent of its page and line.
 */
const glow = (g: Good) => {
  const [r, gr, b] = [1, 3, 5].map((i) => parseInt(GOODS[g].color.slice(i, i + 2), 16) / 255);
  const [hi, lo] = [Math.max(r, gr, b), Math.min(r, gr, b)];
  const d = hi - lo;
  const h = d === 0 ? 0 : hi === r ? ((gr - b) / d + 6) % 6 : hi === gr ? (b - r) / d + 2 : (r - gr) / d + 4;
  const l = Math.max((hi + lo) / 2, 0.62);
  const sat = Math.min(1, (d / (1 - Math.abs(hi + lo - 1) || 1)) * 1.3 + 0.1);
  const c = (1 - Math.abs(2 * l - 1)) * sat;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const [p, q, t] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h) % 6];
  const hex = (v: number) => Math.round((v + l - c / 2) * 255).toString(16).padStart(2, "0");
  return `#${hex(p)}${hex(q)}${hex(t)}`;
};

/** Every good held, with what is on its way in. */
const held = createRoot(() =>
  createMemo(() => {
    const sum = new Map<Good, { level: number; cap: number; incoming: number }>();
    for (const [g, s] of Object.entries(stocks()) as [Good, { level: number; cap: number }][])
      sum.set(g, { ...s, incoming: sea.shipments.filter((x) => x.good === g && !x.outbound).reduce((a, x) => a + GOODS[x.good].per, 0) });
    return sum;
  }),
);

/**
 * A price over time: a line from each hour's price to the next in the
 * good's colour, its ground under it fading down from it, and the price
 * now a white dot at its end. `lo` and `hi` are the bottom and the top.
 */
function Chart(props: { history: number[]; lo: number; hi: number; w: number; h: number; color: string; thick: number }) {
  const y = (v: number) => props.h * (1 - (v - props.lo) / Math.max(1e-9, props.hi - props.lo));
  const step = () => props.w / Math.max(1, props.history.length - 1);
  const t = () => props.thick / 2;
  const dot = () => props.thick * 2.6;
  const top = () => Math.min(...props.history.map(y));
  const last = () => props.history[props.history.length - 1];
  return (
    <box w={props.w} h={props.h}>
      <Index each={props.history.slice(1)}>
        {(v, i) => {
          const [a, b] = [() => y(props.history[i]), () => y(v())];
          // The ground in whole pixels, each piece meeting the next exactly.
          const [l, r] = [() => Math.round(i * step()), () => Math.round((i + 1) * step())];
          return (
            <>
              <box at={{ left: l(), top: top() }} w={r() - l()} h={props.h - top()} under={[0, a() - top(), r() - l(), b() - top()]} fill={`${props.color}55`} />
              <box at={{ left: i * step() - t(), top: Math.min(a(), b()) - t() }} w={step() + 2 * t()} h={Math.abs(a() - b()) + 2 * t()} round={t()} seg={[t(), a() - Math.min(a(), b()) + t(), step() + t(), b() - Math.min(a(), b()) + t()]} fill={props.color} />
            </>
          );
        }}
      </Index>
      <box at={{ left: props.w - dot() / 2, top: y(last()) - dot() / 2 }} w={dot()} h={dot()} round={dot() / 2} fill="white" />
    </box>
  );
}

/** The day, small, for the list: on one scale for every good, a half
 *  either side of the world's price, so a steady good looks steady. */
function Spark(props: { q: Quote }) {
  const day = () => props.q.history.slice(-25);
  const mid = () => (props.q.floor + props.q.ceiling) / 2;
  return (
    <box pad={{ right: 3 }}>
      <Chart history={day().length > 1 ? day() : [props.q.price, props.q.price]} lo={mid() * 0.6} hi={mid() * 1.4} w={58} h={26} thick={2} color={glow(props.q.good)} />
    </box>
  );
}

/** A good's tile: its glyph on a square of its colour. */
const Tile = (props: { good: Good }) => (
  <box w={32} h={32} round={10} fill={GOODS[props.good].color} align="center" justify="center">
    <icon d={GOODS[props.good].glyph} size={18.5} ink="white" />
  </box>
);

/** A good's page, as the page stack shows it. */
const goodPage = (g: Good) => ({ key: `good:${g}`, view: () => <Page good={g} /> });
/** The market, and a good's page over it: a mission's step. */
export const toMarket = (g: Good | null) => (show("market", true), g && push(goodPage(g)));

/** The market's head: what the town holds is worth at today's prices,
 *  and how that moved since yesterday. */
export function MarketHead() {
  const worth = () => market.goods.reduce((a, q) => a + (held().get(q.good)?.level ?? 0) * q.price, 0);
  const was = () => market.goods.reduce((a, q) => a + (held().get(q.good)?.level ?? 0) * dayAgo(q), 0);
  const moved = () => (was() > 0 ? worth() / was() - 1 : 0);
  return (
    <box dir="row" align="end" gap={8} pad={{ x: 16, top: 16, bottom: 8 }}>
      <Show when={worth() >= 0.05} fallback={<text size={14} weight={600} soft>Goods are kept in a depot</text>}>
        <text serif size={30}>{money(worth())}</text>
        <box grow={1} pad={{ bottom: 5 }}>
          <text size={12.5} soft>held</text>
        </box>
        <box pad={{ bottom: 5 }}>
          <text size={12.5} weight={600} ink={tint(moved())}>{percent(moved())} today</text>
        </box>
      </Show>
    </box>
  );
}

/** Every good: what the town holds, the day's line, the price and its move. */
export function MarketBody() {
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

/** A number to set with a tap either side. */
function Stepper(props: { value: string; less: () => void; more: () => void }) {
  const Side = (p: { d: string; onTap: () => void }) => (
    <Press w={36} h={36} round={18} align="center" justify="center" onTap={p.onTap}>
      <Line d={p.d} size={14} width={2.6} />
    </Press>
  );
  return (
    <box dir="row" align="center" h={46} pad={5} round={23} fill="ink/0.14">
      <Side d="M5 12h14" onTap={props.less} />
      <box minW={30} align="center"><text serif size={16}>{props.value}</text></box>
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
  const trade = (out: boolean) => send({ type: "Trade", data: { good: props.good, packages: n(), out } });
  const cost = () => total(q(), n(), false);
  const harbour = () => home() !== null;
  const range = () => {
    const pad = (q().ceiling - q().floor) * 0.08;
    return [q().floor - pad, q().ceiling + pad];
  };
  const stock = () => held().get(props.good);
  const accent = () => glow(props.good);
  return (
    <box pad={{ bottom: 14 }} gap={10}>
      <PageHead>
        <Tile good={props.good} />
        <text size={17} weight={700} grow={1} ink={accent()}>{named(props.good)}</text>
      </PageHead>
      <box pad={{ x: 16 }} gap={12}>
        {/* The price now, big, how it moved, and the week or day behind it. */}
        <box dir="row" align="end" gap={8}>
          <text serif size={40} ink={accent()}>{money(each(props.good, q().price))}</text>
          <box grow={1} pad={{ bottom: 7 }}>
            <text size={13} weight={600} soft>{percent(change(q()))} today</text>
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
            <Chart history={shown().length > 1 ? shown() : [q().price, q().price]} lo={range()[0]} hi={range()[1]} w={w() - 6} h={140} thick={3} color={accent()} />
          </Show>
        </box>
        {/* The band the world keeps it in: the chart's bottom and top. */}
        <box dir="row">
          <text size={12} soft grow={1}>World buys at <text serif>{money(each(props.good, q().floor))}</text></text>
          <text size={12} soft>World sells at <text serif>{money(each(props.good, q().ceiling))}</text></text>
        </box>

        <Show when={stock()}>{(s) => <Shelf good={props.good} level={s().level} cap={s().cap} incoming={s().incoming} />}</Show>

        {/* So many packages, bought or sold at once. */}
        <box dir="row" align="center" gap={8}>
          <Stepper value={`${n()}`} less={() => setN(n() > LOAD ? n() - LOAD : Math.max(1, n() - 1))} more={() => setN(Math.min(DECK, n() < LOAD ? n() + 1 : n() + LOAD))} />
          <Press grow={1} dir="row" align="center" justify="center" gap={8} h={46} round={23} fill={`${accent()}3d`} opacity={harbour() && growth().treasury >= cost() ? 1 : 0.4} onTap={() => harbour() && growth().treasury >= cost() && trade(false)}>
            <text size={15} weight={700} ink={accent()}>Buy</text>
            <text serif size={16} ink={accent()}>{money(cost())}</text>
          </Press>
          <Press grow={1} dir="row" align="center" justify="center" gap={8} h={46} round={23} fill="ink/0.14" opacity={harbour() ? 1 : 0.4} onTap={() => harbour() && trade(true)}>
            <text size={15} weight={700}>Sell</text>
            <text serif size={16}>{money(total(q(), n(), true))}</text>
          </Press>
        </box>
      </box>
    </box>
  );
}

/** A good's shelf: how full, and what is on its way drawn faint beyond it. */
function Shelf(props: { good: Good; level: number; cap: number; incoming: number }) {
  const share = (v: number) => Math.max(0, Math.min(1, v / props.cap));
  const [w, setW] = createSignal(0);
  const color = () => glow(props.good);
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
