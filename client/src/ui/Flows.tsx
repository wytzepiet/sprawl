import { For, Show, createMemo } from "solid-js";
import { builtVersion, eachEntity, getEntity, reached } from "../state/gameObjects";
import { subject } from "../state/selection";
import { now } from "../state/town";
import { BLUEPRINTS, GOODS, middle } from "../blueprints";
import { onMap } from "./kit";
import type { Building, Car, Good } from "../generated";

/** How far a family drives to a shop (`town::homes::REACH`). */
const REACH = 26;

/** A flow: goods, or workers, going from one building to another. */
interface Flow {
  from: number;
  to: number;
  /** The good's colour; none, workers. */
  good: Good | null;
}

type Placed = { id: number; b: Building; at: [number, number] };

/** Every building no road has left out. */
function placed(): Placed[] {
  builtVersion();
  const out: Placed[] = [];
  eachEntity((e) => {
    if (e.object.kind === "Building" && reached(e)) out.push({ id: e.id, b: e.object.data as Building, at: middle(e.object.data as Building) });
  });
  return out;
}

const far = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const apart = (a: [number, number], b: [number, number]) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));

/** The nearest maker of a good to a place, as the lorries choose. */
function source(all: Placed[], good: Good, at: [number, number]): Placed | null {
  let best: Placed | null = null;
  for (const p of all) if (BLUEPRINTS[p.b.kind].makes === good && (!best || far(p.at, at) < far(best.at, at))) best = p;
  return best;
}

/** The shop a house drives to: the nearest within reach. */
function shopOf(all: Placed[], at: [number, number]): Placed | null {
  let best: Placed | null = null;
  for (const p of all) if (p.b.kind === "Shop" && apart(p.at, at) <= REACH && (!best || apart(p.at, at) < apart(best.at, at))) best = p;
  return best;
}

/** What the selected building trades with, as far as the client can
 *  tell: where what it takes comes from, where what it makes goes, the
 *  families a shop serves, and who comes to work. */
function flows(id: number): Flow[] {
  const e = getEntity(id);
  if (!e || e.object.kind !== "Building") return [];
  const b = e.object.data as Building;
  const all = placed();
  const me = all.find((p) => p.id === id);
  if (!me) return [];
  const bp = BLUEPRINTS[b.kind];
  const out: Flow[] = [];
  const workers = () => {
    for (const car of b.crew) {
      const c = getEntity(car)?.object.data as Car | undefined;
      if (c) out.push({ from: c.owner, to: id, good: null });
    }
  };
  if (b.home) {
    const shop = shopOf(all, me.at);
    const want = b.home.wants[0]?.good ?? "Fish";
    if (shop) out.push({ from: shop.id, to: id, good: want });
    for (const p of all) {
      if (p.b.crew.some((car) => (getEntity(car)?.object.data as Car | undefined)?.owner === id)) out.push({ from: id, to: p.id, good: null });
    }
    return out;
  }
  if (b.kind === "Shop") {
    for (const good of Object.keys(b.stocks) as Good[]) {
      const s = source(all, good, me.at);
      if (s) out.push({ from: s.id, to: id, good });
    }
    for (const p of all) {
      if (p.b.home && shopOf(all, p.at)?.id === id) out.push({ from: id, to: p.id, good: p.b.home.wants[0]?.good ?? "Fish" });
    }
    return out;
  }
  for (const good of Object.keys(bp.takes) as Good[]) {
    const s = source(all, good, me.at);
    if (s) out.push({ from: s.id, to: id, good });
  }
  if (bp.makes) {
    const good = bp.makes;
    for (const p of all) {
      const takes = p.b.kind === "Shop" ? good in p.b.stocks : good in BLUEPRINTS[p.b.kind].takes;
      if (takes && source(all, good, p.at)?.id === id) out.push({ from: id, to: p.id, good });
    }
  }
  workers();
  return out;
}

/**
 * Where a selected building's goods come from and go to, drawn over the
 * town as arcs in each good's colour, a dash running along each the way
 * the goods go; who comes to work, in white.
 */
export default function Flows() {
  style();
  // Looked at again four times a second: what is on a shelf, who is on
  // a crew, and what stands, change under a card left open.
  const lines = createMemo(() => {
    now();
    builtVersion();
    const id = subject();
    return id === null ? [] : flows(id);
  }, [], { equals: (a, b) => a.length === b.length && a.every((f, i) => f.from === b[i].from && f.to === b[i].to && f.good === b[i].good) });
  return (
    <svg style={{ position: "absolute", left: "0", top: "0", width: "100%", height: "100%", "pointer-events": "none", overflow: "visible" }}>
      <For each={lines()}>{(f) => <Arc flow={f} />}</For>
    </svg>
  );
}

// Each dash moves on by a dash and its gap, 18 px, every 0.6 s.
let styled = false;
function style() {
  if (styled) return;
  styled = true;
  const el = document.createElement("style");
  el.textContent = "@keyframes flow-run { to { stroke-dashoffset: -18 } } .flow { animation: flow-run 0.6s linear infinite }";
  document.head.appendChild(el);
}

const end = (id: number) => () => {
  const e = getEntity(id);
  return e?.object.kind === "Building" ? ([...middle(e.object.data as Building), 0.4] as [number, number, number]) : null;
};

function Arc(props: { flow: Flow }) {
  const a = onMap(end(props.flow.from));
  const b = onMap(end(props.flow.to));
  const color = props.flow.good ? GOODS[props.flow.good].color : "#ffffff";
  const d = () => {
    const [p, q] = [a(), b()];
    if (!p || !q) return null;
    // Bowed up by a fifth of its length, so two the other way about part.
    const [mx, my] = [(p.sx + q.sx) / 2, (p.sy + q.sy) / 2];
    const len = Math.hypot(q.sx - p.sx, q.sy - p.sy);
    const [nx, ny] = len > 0 ? [(q.sy - p.sy) / len, -(q.sx - p.sx) / len] : [0, 0];
    const k = len * 0.2;
    return `M${p.sx},${p.sy} Q${mx + nx * k},${my + ny * k} ${q.sx},${q.sy}`;
  };
  const w = props.flow.good ? 3.5 : 2;
  return (
    <Show when={d()}>
      {(path) => (
        <g>
          <path d={path()} fill="none" stroke="#00000055" stroke-width={w + 3} stroke-linecap="round" />
          <path d={path()} fill="none" stroke={color} stroke-width={w} stroke-linecap="round" stroke-dasharray="10 8" class="flow" />
          <circle cx={b()!.sx} cy={b()!.sy} r={w + 1.5} fill={color} stroke="white" stroke-width="1.5" />
        </g>
      )}
    </Show>
  );
}
