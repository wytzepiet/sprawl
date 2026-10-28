import { Box, Text, Icon } from "~ui";
import { createMemo, createRoot, createSignal, For, Show } from "solid-js";
import { sea, until, voyage } from "../state/sea";
import { change, dayAgo, flowOf, market, quoteOf, stocks } from "../state/market";
import { home } from "../state/deals";
import { GOODS } from "../blueprints";
import { BAD, GOOD, Press, SEA } from "./kit";
import { show } from "./sheet";
import { PageHead, push } from "./pages";
import type { Good, Quote } from "../generated";

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

/** The day, small, for the list: on one scale for every good, a half
 *  either side of the world's price, so a steady good looks steady. */
function Spark(props: { q: Quote }) {
  const day = () => props.q.history.slice(-25);
  const mid = () => (props.q.floor + props.q.ceiling) / 2;
  return (
    <Box pad={{ right: 3 }}>
      <Chart history={day().length > 1 ? day() : [props.q.price, props.q.price]} lo={mid() * 0.6} hi={mid() * 1.4} w={58} h={26} thick={2} color={glow(props.q.good)} />
    </Box>
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
/** The market, and a good's page over it: a mission's step. */
export const toMarket = (g: Good | null) => (show("market", true), g && push(goodPage(g)));

/** The market's head: what the town holds is worth at today's prices,
 *  and how that moved since yesterday. */
export function MarketHead() {
  const worth = () => market.goods.reduce((a, q) => a + (held().get(q.good)?.level ?? 0) * q.price, 0);
  const was = () => market.goods.reduce((a, q) => a + (held().get(q.good)?.level ?? 0) * dayAgo(q), 0);
  const moved = () => (was() > 0 ? worth() / was() - 1 : 0);
  return (
    <Box dir="row" align="end" gap={8} pad={{ x: 16, top: 16, bottom: 8 }}>
      <Show when={worth() >= 0.05} fallback={<Text size={14} weight={600} soft>Goods are kept in a depot</Text>}>
        <Text serif size={30}>{money(worth())}</Text>
        <Box grow={1} pad={{ bottom: 5 }}>
          <Text size={12.5} soft>held</Text>
        </Box>
        <Box pad={{ bottom: 5 }}>
          <Text size={12.5} weight={600} ink={tint(moved())}>{percent(moved())} today</Text>
        </Box>
      </Show>
    </Box>
  );
}

/** Every good: what the town holds, the day's line, the price and its move. */
export function MarketBody() {
  return (
    <Box pad={{ x: 12, bottom: 12 }} gap={2}>
      <For each={market.goods}>
        {(q) => (
          <Press dir="row" align="center" gap={12} pad={{ x: 4, y: 8 }} round={16} onTap={() => push(goodPage(q.good))}>
            <Tile good={q.good} />
            <Box grow={1} gap={1}>
              <Text size={14.5} weight={600}>{named(q.good)}</Text>
              <Box dir="row" gap={6}>
                <Text size={12} soft>{held().has(q.good) ? `${Math.floor(held().get(q.good)!.level)} held` : "none held"}</Text>
                <Show when={net(q.good)}>{(n) => <Text size={12} weight={600} ink={n() > 0 ? GOOD : BAD}>{n() > 0 ? "+" : "−"}{Math.round(Math.abs(n()))} a day</Text>}</Show>
              </Box>
            </Box>
            <Spark q={q} />
            <Box w={64} align="end">
              <Text serif size={18}>{money(each(q.good, q.price))}</Text>
              <Text size={11.5} weight={600} ink={tint(change(q))}>{percent(change(q))}</Text>
            </Box>
          </Press>
        )}
      </For>
    </Box>
  );
}

/** What the town made of a good less what it used, the last day; none
 *  where it does neither, or they all but match. */
const net = (g: Good) => {
  const f = flowOf(g);
  const n = f ? f.made - f.used : 0;
  return Math.abs(n) >= 0.5 ? n : null;
};

/** A widget's ground on the black: the page is a stack of them. */
const TILE = "#1C1C1E";
/** The gap between widgets, and their corners. */
const GAP = 10;
const CORNER = 26;
/** The two squares' height: the page whole above the dock on a laptop. */
const BOX = 132;

/** A ring, `share` of it drawn round from the top, the rest faint: a
 *  countdown's face. */
function Ring(props: { share: number; size: number; color: string }) {
  const r = () => props.size / 2 - 3;
  const round = () => 2 * Math.PI * r();
  return (
    <svg width={props.size} height={props.size} style={{ display: "block", "flex-shrink": 0, transform: "rotate(-90deg)" }}>
      <circle cx={props.size / 2} cy={props.size / 2} r={r()} fill="none" stroke={props.color} stroke-opacity="0.22" stroke-width={6} />
      <circle cx={props.size / 2} cy={props.size / 2} r={r()} fill="none" stroke={props.color} stroke-width={6} stroke-opacity={props.share > 0 ? 1 : 0} stroke-linecap="round" stroke-dasharray={`${round() * Math.min(1, props.share)} ${round()}`} />
    </svg>
  );
}

/**
 * A good's page, as a stack of widgets, each one thing: its price and its
 * line; what the depots hold of it; where the price stands in the world's
 * band; and when the next ferry lands.
 */
function Page(props: { good: Good }) {
  const q = () => quoteOf(props.good)!;
  const [w, setW] = createSignal(0);
  const [week, setWeek] = createSignal(true);
  const shown = () => (week() ? q().history : q().history.slice(-25));
  const ferry = () => sea.sailings.find((s) => s.harbour === home());
  const accent = () => glow(props.good);
  const stock = () => held().get(props.good);
  // Where today's price stands between what the world buys and sells at.
  const share = () => Math.max(0, Math.min(1, (q().price - q().floor) / Math.max(1e-9, q().ceiling - q().floor)));
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

      {/* Two squares: the depots, and the world's band. */}
      <Box dir="row" gap={GAP}>
        <Box grow={1} h={BOX} pad={16} round={CORNER} fill={TILE} gap={4}>
          <Text size={13} weight={600} ink="ink/0.5">In your depots</Text>
          <Text serif size={34}>{Math.floor(stock()?.level ?? 0).toLocaleString()}</Text>
          <Box grow={1} />
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
        <Box grow={1} h={BOX} pad={16} round={CORNER} fill={TILE} dir="row" gap={12}>
          <Box grow={1} justify="between">
            <Box>
              <Text size={12} weight={600} ink="ink/0.45">World sells</Text>
              <Text serif size={20}>{money(each(props.good, q().ceiling))}</Text>
            </Box>
            <Text size={13} weight={700} ink={accent()}>{share() > 0.66 ? "Dear" : share() < 0.33 ? "Cheap" : "Fair"}</Text>
            <Box>
              <Text size={12} weight={600} ink="ink/0.45">World buys</Text>
              <Text serif size={20}>{money(each(props.good, q().floor))}</Text>
            </Box>
          </Box>
          {/* The band upright, the price a dot on it. */}
          <Box w={18} h={BOX - 32} round={9} fill="ink/0.12">
            <Box at={{ left: 0, top: (BOX - 32) * (1 - share()) }} w={18} h={(BOX - 32) * share()} round={9} fill={`${accent()}66`} />
            <Box at={{ left: -3, top: Math.min(BOX - 56, Math.max(0, (BOX - 32) * (1 - share()) - 12)) }} w={24} h={24} round={12} fill="white" />
          </Box>
        </Box>
      </Box>

      {/* What the town made of it and used, the last day. */}
      <Show when={flow()}>
        {(f) => (
          <Box dir="row" gap={GAP}>
            <For each={[["Made", f().made], ["Used", f().used]] as const}>
              {([label, v]) => (
                <Box grow={1} pad={{ x: 16, y: 12 }} round={CORNER} fill={TILE} gap={2}>
                  <Text size={12} weight={600} ink="ink/0.45">{label} the last day</Text>
                  <Text serif size={26} ink={label === "Made" ? accent() : undefined}>{Math.round(v).toLocaleString()}</Text>
                </Box>
              )}
            </For>
          </Box>
        )}
      </Show>

      {/* When the next ferry lands. */}
      <Show when={ferry()}>
        {(f) => (
          <Box dir="row" align="center" gap={12} h={64} pad={{ left: 12, right: 22 }} round={32} fill={TILE}>
            <Ring share={voyage(f())} size={42} color={SEA} />
            <Box grow={1}>
              <Text size={14} weight={700} ink={SEA}>{f().berthed ? "Ferry at the ramp" : "Next ferry in"}</Text>
              <Text size={12} ink="ink/0.5">{f().packages} of {f().deck} on its deck</Text>
            </Box>
            <Text serif size={32} ink={SEA}>{until(f().berthed ? f().departs : f().lands)}</Text>
          </Box>
        )}
      </Show>
    </Box>
  );
}
