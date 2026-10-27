/** @jsxImportSource ~ui */
import { createMemo, createRoot, createSignal, For, Index, Show } from "solid-js";
import { useGame } from "../state/gameObjects";
import { sea, until, voyage } from "../state/sea";
import { change, dayAgo, market, quoteOf, stocks, total } from "../state/market";
import { home } from "../state/deals";
import { GOODS } from "../blueprints";
import { LOAD } from "../generated/rows";
import { BAD, GOOD, Line, Press, SEA } from "./kit";
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

/** A widget's ground on the black: the page is a stack of them. */
const TILE = "#1C1C1E";
/** The gap between widgets, and their corners. */
const GAP = 10;
const CORNER = 26;
/** The two squares' height: the page whole above the dock on a laptop. */
const BOX = 132;

/** A number to set with a tap either side. */
function Stepper(props: { value: string; less: () => void; more: () => void }) {
  const Side = (p: { d: string; onTap: () => void }) => (
    <Press w={42} h={42} round={21} align="center" justify="center" onTap={p.onTap}>
      <Line d={p.d} size={14} width={2.8} />
    </Press>
  );
  return (
    <box dir="row" align="center" h={54} pad={6} round={27} fill={TILE}>
      <Side d="M5 12h14" onTap={props.less} />
      <box minW={28} align="center"><text serif size={19}>{props.value}</text></box>
      <Side d="M5 12h14M12 5v14" onTap={props.more} />
    </box>
  );
}

/** A ring, `share` of it drawn round from the top, the rest faint: a
 *  countdown's face. */
function Ring(props: { share: number; size: number; color: string }) {
  const STEPS = 40;
  const r = () => props.size / 2 - 3;
  const at = (k: number) => [props.size / 2 + r() * Math.sin((k / STEPS) * Math.PI * 2), props.size / 2 - r() * Math.cos((k / STEPS) * Math.PI * 2)];
  const piece = (k: number, color: string) => {
    const [[ax, ay], [bx, by]] = [at(k), at(k + 1)];
    return <box at={{ left: 0, top: 0 }} w={props.size} h={props.size} round={3} seg={[ax, ay, bx, by]} fill={color} />;
  };
  return (
    <box w={props.size} h={props.size}>
      <box at={{ left: 0, top: 0 }} w={props.size} h={props.size} round={props.size / 2} stroke={[6, `${props.color}38`]} />
      <Index each={Array.from({ length: Math.round(props.share * STEPS) })}>{(_, k) => piece(k, props.color)}</Index>
    </box>
  );
}

/**
 * A good's page, as a stack of widgets, each one thing: its price and its
 * line; what the depots hold of it; where the price stands in the world's
 * band; when a box bought now lands; and Buy and Sell so many packages,
 * the buttons their prices.
 */
function Page(props: { good: Good }) {
  const { send, growth } = useGame();
  const q = () => quoteOf(props.good)!;
  const [w, setW] = createSignal(0);
  const [week, setWeek] = createSignal(true);
  const [n, setN] = createSignal(1);
  const shown = () => (week() ? q().history : q().history.slice(-25));
  const trade = (out: boolean) => send({ type: "Trade", data: { good: props.good, packages: n(), out } });
  const cost = () => total(q(), n(), false);
  const ferry = () => sea.sailings.find((s) => s.harbour === home());
  const accent = () => glow(props.good);
  const stock = () => held().get(props.good);
  // Where today's price stands between what the world buys and sells at.
  const share = () => Math.max(0, Math.min(1, (q().price - q().floor) / Math.max(1e-9, q().ceiling - q().floor)));
  const shelf = (v: number) => Math.max(0, Math.min(1, v / Math.max(1, stock()?.cap ?? 1)));
  const [shelfW, setShelfW] = createSignal(0);
  return (
    <box pad={{ x: 12, bottom: 14 }} gap={GAP}>
      <PageHead>
        <text size={17} weight={700} grow={1}>{named(props.good)}</text>
        <box dir="row" pad={3} round={16} fill={TILE}>
          <For each={[false, true]}>
            {(wk) => (
              <Press h={26} pad={{ x: 12 }} round={13} justify="center" fill={week() === wk ? "ink/0.2" : undefined} onTap={() => setWeek(wk)}>
                <text size={12.5} weight={600} ink={week() === wk ? "ink" : "ink/0.55"}>{wk ? "Week" : "Day"}</text>
              </Press>
            )}
          </For>
        </box>
      </PageHead>

      {/* The price: a big number and its line. */}
      <box pad={{ x: 18, top: 16, bottom: 12 }} round={CORNER} fill={TILE} gap={6}>
        <box dir="row" align="end" gap={8}>
          <text serif size={44} ink={accent()}>{money(each(props.good, q().price))}</text>
          <box grow={1} pad={{ bottom: 8 }}><text size={14} weight={700} ink={`${accent()}bb`}>coins</text></box>
          <box pad={{ bottom: 8 }}><text size={14} weight={700} ink={tint(change(q()))}>{percent(change(q()))}</text></box>
        </box>
        <box onSize={(x) => setW(x)}>
          <Show when={w() > 0}>
            <Chart history={shown().length > 1 ? shown() : [q().price, q().price]} lo={Math.min(...shown(), q().price) - 0.02} hi={Math.max(...shown(), q().price) + 0.02} w={w() - 6} h={96} thick={3} color={accent()} />
          </Show>
        </box>
        <box dir="row">
          <text size={11.5} weight={600} ink="ink/0.35" grow={1}>{week() ? "a week ago" : "a day ago"}</text>
          <text size={11.5} weight={600} ink="ink/0.35">now</text>
        </box>
      </box>

      {/* Two squares: the depots, and the world's band. */}
      <box dir="row" gap={GAP}>
        <box grow={1} h={BOX} pad={16} round={CORNER} fill={TILE} gap={4}>
          <text size={13} weight={600} ink="ink/0.5">In your depots</text>
          <text serif size={34}>{Math.floor(stock()?.level ?? 0).toLocaleString()}</text>
          <box grow={1} />
          <box h={14} round={7} fill="ink/0.12" onSize={(x) => setShelfW(x)}>
            <box at={{ left: 0, top: 0 }} w={shelfW() * shelf((stock()?.level ?? 0) + (stock()?.incoming ?? 0))} h={14} round={7} fill={`${accent()}59`} />
            <box at={{ left: 0, top: 0 }} w={shelfW() * shelf(stock()?.level ?? 0)} h={14} round={7} fill={accent()} />
          </box>
          <box dir="row">
            <text size={12} weight={600} ink="ink/0.45" grow={1}>{stock() ? `of ${stock()!.cap.toLocaleString()}` : "no depot yet"}</text>
            <Show when={(stock()?.incoming ?? 0) > 0}>
              <text size={12} weight={600} ink={accent()}>+{Math.round(stock()!.incoming)} coming</text>
            </Show>
          </box>
        </box>
        <box grow={1} h={BOX} pad={16} round={CORNER} fill={TILE} dir="row" gap={12}>
          <box grow={1} justify="between">
            <box>
              <text size={12} weight={600} ink="ink/0.45">World sells</text>
              <text serif size={20}>{money(each(props.good, q().ceiling))}</text>
            </box>
            <text size={13} weight={700} ink={accent()}>{share() > 0.66 ? "Dear" : share() < 0.33 ? "Cheap" : "Fair"}</text>
            <box>
              <text size={12} weight={600} ink="ink/0.45">World buys</text>
              <text serif size={20}>{money(each(props.good, q().floor))}</text>
            </box>
          </box>
          {/* The band upright, the price a dot on it. */}
          <box w={18} h={BOX - 32} round={9} fill="ink/0.12">
            <box at={{ left: 0, top: (BOX - 32) * (1 - share()) }} w={18} h={(BOX - 32) * share()} round={9} fill={`${accent()}66`} />
            <box at={{ left: -3, top: Math.min(BOX - 56, Math.max(0, (BOX - 32) * (1 - share()) - 12)) }} w={24} h={24} round={12} fill="white" />
          </box>
        </box>
      </box>

      {/* When a box bought now lands: the ferry it rides. */}
      <Show when={ferry()}>
        {(f) => (
          <box dir="row" align="center" gap={12} h={64} pad={{ left: 12, right: 22 }} round={32} fill={TILE}>
            <Ring share={voyage(f())} size={42} color={SEA} />
            <box grow={1}>
              <text size={14} weight={700} ink={SEA}>{f().berthed ? "Ferry at the ramp" : "Bought now, lands in"}</text>
              <text size={12} ink="ink/0.5">{f().packages} of {f().deck} on its deck</text>
            </box>
            <text serif size={32} ink={SEA}>{until(f().berthed ? f().departs : f().lands)}</text>
          </box>
        )}
      </Show>

      {/* The trade: how many, and what it comes to either way. */}
      <box dir="row" align="center" gap={8} pad={{ top: 4 }}>
        <Stepper value={`${n()}`} less={() => setN(n() > LOAD ? n() - LOAD : Math.max(1, n() - 1))} more={() => setN(Math.min(DECK, n() < LOAD ? n() + 1 : n() + LOAD))} />
        <Press grow={1} h={54} round={27} align="center" justify="center" fill={accent()} opacity={home() !== null && growth().treasury >= cost() ? 1 : 0.4} onTap={() => home() !== null && growth().treasury >= cost() && trade(false)}>
          <text size={12} weight={700} ink="#000000b0">Buy</text>
          <text serif size={19} ink="#000">{money(cost())}</text>
        </Press>
        <Press grow={1} h={54} round={27} align="center" justify="center" fill={TILE} opacity={home() !== null ? 1 : 0.4} onTap={() => home() !== null && trade(true)}>
          <text size={12} weight={700} ink="ink/0.6">Sell</text>
          <text serif size={19}>{money(total(q(), n(), true))}</text>
        </Press>
      </box>
    </box>
  );
}
