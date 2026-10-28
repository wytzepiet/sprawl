import { Box, Text, Icon } from "~ui";
import { createMemo, createRoot, createSignal, For, Show } from "solid-js";
import { now, sea } from "../state/sea";
import { change, flowOf, market, quoteOf, stocks } from "../state/market";
import { neighbours } from "../state/neighbours";
import { dayLengthMs } from "../network/clock";
import { GOODS } from "../blueprints";
import { BAD, GOOD, Press } from "./kit";
import { show } from "./sheet";
import { PageHead, push } from "./pages";
import type { Deal, Flow, Good } from "../generated";

/**
 * The market tab (docs/plan-market.md §The first version): what the town
 * holds is worth, then every good, what the town holds of it, its day
 * and its price; a tap opens a good's page: its week on a line, the
 * world's band, and its depots' room. The town trades by itself.
 *
 * Prices are a package's, the unit a deck trades in.
 */

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

/** A gradient's name, unique to its chart. */
let charts = 0;

/** A smooth line through points: each bend a curve whose handles run
 *  along the line from the point before to the point after, a sixth of
 *  the way (Catmull–Rom), so it passes through every hour's price. */
function smooth(pts: [number, number][]) {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [p0, p1, p2, p3] = [pts[i - 2] ?? pts[i - 1], pts[i - 1], pts[i], pts[i + 1] ?? pts[i]];
    d += `C${p1[0] + (p2[0] - p0[0]) / 6},${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6},${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]},${p2[1]}`;
  }
  return d;
}

/**
 * A price over time: a smooth line through each hour's price in the
 * good's colour, the ground under it fading down from it, and the price
 * now a white dot at its end. `lo` and `hi` are the bottom and the top.
 */
function Chart(props: { history: number[]; lo: number; hi: number; w: number; h: number; color: string; thick: number }) {
  const id = `chart${charts++}`;
  const pts = () => {
    const step = props.w / Math.max(1, props.history.length - 1);
    return props.history.map((v, i): [number, number] => [i * step, props.h * (1 - (v - props.lo) / Math.max(1e-9, props.hi - props.lo))]);
  };
  const line = () => smooth(pts());
  const end = () => pts()[pts().length - 1];
  return (
    <svg width={Math.max(0, props.w)} height={props.h} style={{ overflow: "visible", display: "block", "flex-shrink": 0 }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color={props.color} stop-opacity="0.45" />
          <stop offset="1" stop-color={props.color} stop-opacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line()}L${props.w},${props.h}L0,${props.h}Z`} fill={`url(#${id})`} />
      <path d={line()} fill="none" stroke={props.color} stroke-width={props.thick} stroke-linecap="round" stroke-linejoin="round" />
      <circle cx={end()[0]} cy={end()[1]} r={props.thick * 1.3} fill="white" />
    </svg>
  );
}

/** A good's tile: its glyph on a square of its colour. */
const Tile = (props: { good: Good }) => (
  <Box w={32} h={32} round={10} fill={GOODS[props.good].color} align="center" justify="center">
    <Icon d={GOODS[props.good].glyph} size={18.5} ink="white" />
  </Box>
);

/** A good's page, as the page stack shows it. */
const goodPage = (g: Good) => ({ key: `good:${g}`, view: () => <Page good={g} /> });
/** The goods tab, and a good's page over it. */
export const toMarket = (g: Good | null) => (show("market", true), g && push(goodPage(g)));

/** A widget's ground on the black: the page is a stack of them. */
const TILE = "#1C1C1E";
/** The gap between widgets, and their corners. */
const GAP = 10;
const CORNER = 26;

/** The last day across the border, every good's: coins in, coins out. */
const day = () => market.flows.reduce((a, f) => ({ earned: a.earned + f.earned, spent: a.spent + f.spent }), { earned: 0, spent: 0 });
const signed = (v: number) => `${v > 0.05 ? "+" : v < -0.05 ? "−" : ""}${money(Math.abs(v))}`;

/** The tab's head: what the town came out with across the border the
 *  last day: earned less spent. */
export function MarketHead() {
  const net = () => day().earned - day().spent;
  return (
    <Box dir="row" align="end" gap={8} pad={{ x: 16, top: 16, bottom: 8 }}>
      <Show when={day().earned + day().spent >= 0.05} fallback={<Text size={14} weight={600} soft>Nothing crossed the border today</Text>}>
        <Text serif size={30} ink={net() >= 0 ? GOOD : BAD}>{signed(net())}</Text>
        <Box grow={1} pad={{ bottom: 5 }}>
          <Text size={12.5} soft>a day, across the border</Text>
        </Box>
      </Show>
    </Box>
  );
}

/** Every good the town deals in, and its deals. */
export function MarketBody() {
  const goods = createMemo(() => market.goods.filter((q) => flowOf(q.good) || held().has(q.good)));
  return (
    <Box pad={{ x: 12, bottom: 12 }} gap={GAP}>
      <Box dir="row" gap={GAP}>
        <Box grow={1} pad={{ x: 16, y: 12 }} round={CORNER} fill={TILE} gap={2}>
          <Text size={12} weight={600} ink="ink/0.45">Sold the last day</Text>
          <Text serif size={26} ink={GOOD}>{money(day().earned)}</Text>
        </Box>
        <Box grow={1} pad={{ x: 16, y: 12 }} round={CORNER} fill={TILE} gap={2}>
          <Text size={12} weight={600} ink="ink/0.45">Bought the last day</Text>
          <Text serif size={26} ink={BAD}>{money(day().spent)}</Text>
        </Box>
      </Box>
      <Box gap={2}>
        <For each={goods()}>
          {(q) => (
            <Press dir="row" align="center" gap={12} pad={{ x: 4, y: 8 }} round={16} onTap={() => push(goodPage(q.good))}>
              <Tile good={q.good} />
              <Box grow={1} gap={1}>
                <Text size={14.5} weight={600}>{named(q.good)}</Text>
                <Text size={12} soft>{madeUsed(flowOf(q.good))}</Text>
              </Box>
              <Trade flow={flowOf(q.good)} />
            </Press>
          )}
        </For>
      </Box>
      <Deals deals={market.deals} />
    </Box>
  );
}

/** Made and used a day, as a line under a good's name. */
const madeUsed = (f: Flow | undefined) => {
  const [m, u] = [Math.round(f?.made ?? 0), Math.round(f?.used ?? 0)];
  return m || u ? `made ${m} · used ${u} a day` : `${Math.floor(held().get(f?.good as Good)?.level ?? 0)} held`;
};

/** What the border made up of a good the last day: bought, red; sold,
 *  green; neither, the town keeps itself. */
function Trade(props: { flow: Flow | undefined }) {
  const f = () => props.flow;
  const net = () => (f()?.earned ?? 0) - (f()?.spent ?? 0);
  return (
    <Box w={92} align="end">
      <Show when={f() && (f()!.imported || f()!.exported)} fallback={<Text size={12} weight={600} soft>its own</Text>}>
        <Text serif size={18} ink={net() >= 0 ? GOOD : BAD}>{signed(net())}</Text>
        <Text size={11.5} weight={600} ink="ink/0.5">
          {[f()!.imported ? `bought ${f()!.imported}` : "", f()!.exported ? `sold ${f()!.exported}` : ""].filter(Boolean).join(" · ")}
        </Text>
      </Show>
    </Box>
  );
}

/** How long ago a moment of the town's day was, in its hours. */
const ago = (at: number) => {
  const h = (now() - at) / (dayLengthMs() / 24);
  return h < 1 ? "this hour" : h < 24 ? `${Math.floor(h)}h ago` : `${Math.floor(h / 24)}d ago`;
};

/** The deals, newest first: who with, what, and the coins. */
function Deals(props: { deals: Deal[]; most?: number }) {
  const shown = () => [...props.deals].reverse().slice(0, props.most ?? 12);
  const who = (d: Deal) => neighbours().find((n) => n.mayor === d.partner);
  return (
    <Show when={props.deals.length > 0}>
      <Box pad={{ x: 16, y: 12 }} round={CORNER} fill={TILE} gap={8}>
        <Text size={13} weight={600} ink="ink/0.5">Deals</Text>
        <For each={shown()}>
          {(d) => (
            <Box dir="row" align="center" gap={10}>
              <Box w={10} h={10} round={5} fill={who(d)?.colour ?? "#888"} />
              <Box grow={1} gap={0}>
                <Text size={13.5} weight={600} lines={1}>{who(d) ? `${who(d)!.name} of ${who(d)!.town}` : d.partner}</Text>
                <Text size={12} soft lines={1}>{`${d.out ? "bought" : "sold you"} ${d.packages} ${GOODS[d.good].label} · ${ago(d.at)}`}</Text>
              </Box>
              <Text serif size={16} ink={d.out ? GOOD : BAD}>{`${d.out ? "+" : "−"}${money(d.packages * each(d.good, d.price))}`}</Text>
            </Box>
          )}
        </For>
      </Box>
    </Show>
  );
}

/**
 * A good's page, as a stack of widgets, each one thing: its price and its
 * line over the week; what the depots hold of it; what the town made and
 * used of it, and bought and sold, the last day; and its deals.
 */
function Page(props: { good: Good }) {
  const q = () => quoteOf(props.good)!;
  const [w, setW] = createSignal(0);
  const [week, setWeek] = createSignal(true);
  const shown = () => (week() ? q().history : q().history.slice(-25));
  const accent = () => glow(props.good);
  const stock = () => held().get(props.good);
  const shelf = (v: number) => Math.max(0, Math.min(1, v / Math.max(1, stock()?.cap ?? 1)));
  const [shelfW, setShelfW] = createSignal(0);
  const flow = () => flowOf(props.good);
  return (
    <Box pad={{ x: 12, bottom: 14 }} gap={GAP}>
      <PageHead>
        <Text size={17} weight={700} grow={1}>{named(props.good)}</Text>
        <Box dir="row" pad={3} round={16} fill={TILE}>
          <For each={[false, true]}>
            {(wk) => (
              <Press h={26} pad={{ x: 12 }} round={13} justify="center" fill={week() === wk ? "ink/0.2" : undefined} onTap={() => setWeek(wk)}>
                <Text size={12.5} weight={600} ink={week() === wk ? "ink" : "ink/0.55"}>{wk ? "Week" : "Day"}</Text>
              </Press>
            )}
          </For>
        </Box>
      </PageHead>

      {/* The price: a big number and its line. */}
      <Box pad={{ x: 18, top: 16, bottom: 12 }} round={CORNER} fill={TILE} gap={6}>
        <Box dir="row" align="end" gap={8}>
          <Text serif size={44} ink={accent()}>{money(each(props.good, q().price))}</Text>
          <Box grow={1} pad={{ bottom: 8 }}><Text size={14} weight={700} ink={`${accent()}bb`}>coins</Text></Box>
          <Box pad={{ bottom: 8 }}><Text size={14} weight={700} ink={tint(change(q()))}>{percent(change(q()))}</Text></Box>
        </Box>
        <Box onSize={(x) => setW(x)}>
          <Show when={w() > 0}>
            <Chart history={shown().length > 1 ? shown() : [q().price, q().price]} lo={Math.min(...shown(), q().price) - 0.02} hi={Math.max(...shown(), q().price) + 0.02} w={w() - 6} h={96} thick={3} color={accent()} />
          </Show>
        </Box>
        <Box dir="row">
          <Text size={11.5} weight={600} ink="ink/0.35" grow={1}>{week() ? "a week ago" : "a day ago"}</Text>
          <Text size={11.5} weight={600} ink="ink/0.35">now</Text>
        </Box>
      </Box>

      {/* What the depots hold. */}
      <Box pad={16} round={CORNER} fill={TILE} gap={6}>
        <Box dir="row" align="end" gap={8}>
          <Text size={13} weight={600} ink="ink/0.5" grow={1}>In your depots</Text>
          <Text serif size={26}>{Math.floor(stock()?.level ?? 0).toLocaleString()}</Text>
        </Box>
        <Box h={14} round={7} fill="ink/0.12" onSize={(x) => setShelfW(x)}>
          <Box at={{ left: 0, top: 0 }} w={shelfW() * shelf((stock()?.level ?? 0) + (stock()?.incoming ?? 0))} h={14} round={7} fill={`${accent()}59`} />
          <Box at={{ left: 0, top: 0 }} w={shelfW() * shelf(stock()?.level ?? 0)} h={14} round={7} fill={accent()} />
        </Box>
        <Box dir="row">
          <Text size={12} weight={600} ink="ink/0.45" grow={1}>{stock() ? `of ${stock()!.cap.toLocaleString()}` : "no depot yet"}</Text>
          <Show when={(stock()?.incoming ?? 0) > 0}>
            <Text size={12} weight={600} ink={accent()}>+{Math.round(stock()!.incoming)} coming</Text>
          </Show>
        </Box>
      </Box>

      {/* Its day: made and used, bought and sold. */}
      <Box dir="row" gap={GAP}>
        <For each={[["Made", flow()?.made ?? 0, accent()], ["Used", flow()?.used ?? 0, undefined]] as const}>
          {([label, v, ink]) => (
            <Box grow={1} pad={{ x: 16, y: 12 }} round={CORNER} fill={TILE} gap={2}>
              <Text size={12} weight={600} ink="ink/0.45">{label} the last day</Text>
              <Text serif size={26} ink={ink}>{Math.round(v).toLocaleString()}</Text>
            </Box>
          )}
        </For>
      </Box>
      <Box dir="row" gap={GAP}>
        <For each={[["Bought", flow()?.imported ?? 0, flow()?.spent ?? 0, BAD], ["Sold", flow()?.exported ?? 0, flow()?.earned ?? 0, GOOD]] as const}>
          {([label, n, coins, ink]) => (
            <Box grow={1} pad={{ x: 16, y: 12 }} round={CORNER} fill={TILE} gap={2}>
              <Text size={12} weight={600} ink="ink/0.45">{label} the last day</Text>
              <Text serif size={26} ink={n ? ink : undefined}>{n.toLocaleString()}</Text>
              <Text size={12} weight={600} ink="ink/0.45">{n ? `${money(coins)} coins` : "packages"}</Text>
            </Box>
          )}
        </For>
      </Box>

      <Deals deals={market.deals.filter((d) => d.good === props.good)} most={20} />
    </Box>
  );
}
