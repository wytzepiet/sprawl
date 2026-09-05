import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { BuildingKind, Class } from "../generated";
import { BLUEPRINTS, BuildingIcon } from "../blueprints";
import { useGame } from "../state/gameObjects";
import { buildRoadGeometry, BORDER_HALF_W, HALF_W, type ArmInfo } from "../engine/objects/roadGeometry";

/**
 * The skill tree, drawn as a town plan.
 *
 * Roads are the edges and buildings are the nodes: taking a node is building
 * it, and the road to it is laid when both ends stand. The plan is authored
 * here as a small map — a road is `.`, a node is a letter from the legend,
 * anything else is open land — so the whole tree can be read at a glance and
 * redrawn by moving letters about. Nothing is fetched; the game's own rules
 * for the tree come later, and will read the same map.
 */

const MAP = [
  //  North: homes. East: commerce. South: industry. West: roads.
  //  Each avenue winds out from the city, its unlocks on side streets;
  //  a node always sits on a straight, so every bend is a bend.
  "                                    H                                    ",
  "                                    .                                    ",
  "                                    .                                    ",
  "                                    H . . A                              ",
  "                                    .                                    ",
  "                                  .                                      ",
  "                                .                                        ",
  "                          A . . H                                        ",
  "                                .                                        ",
  "                                  .                                      ",
  "                                    .                                    ",
  "        G                           H                     B              ",
  "r .     .           . r .           .                     .           . S",
  "    .   .         .   .   .         .                     .         .    ",
  "      . r . . r .     .     . r . . @ . . S .           . S . . S .      ",
  "              .       o             .     .   .       .         .        ",
  "              .                     .     .     . S .           .        ",
  "              r               W . . I     R                     R        ",
  "                                    .                                    ",
  "                                      .                                  ",
  "                                        .                                ",
  "                                        I . . F                          ",
  "                                        .                                ",
  "                                      .                                  ",
  "                                    .                                    ",
  "                              W . . I                                    ",
  "                                    .                                    ",
  "                                    .                                    ",
  "                                    I                                    ",
];

type Effect =
  | { kind: "Nothing" }
  | { kind: "Weight"; class: Class }
  | { kind: "Building"; building: BuildingKind }
  | { kind: "RoadTiles"; tiles: number }
  | { kind: "OneWay" };

interface Kind {
  name: string;
  cost: number;
  blurb: string;
  effect: Effect;
}

const LEGEND: Record<string, Kind> = {
  "@": { name: "The city", cost: 0, blurb: "Where every city starts.", effect: { kind: "Nothing" } },
  H: { name: "Homes", cost: 1, blurb: "People want to live here. Homes arrive more often.", effect: { kind: "Weight", class: "Living" } },
  A: { name: "Apartments", cost: 1, blurb: "Eight households on a plot of two. They fill fast, and empty onto the road slower.", effect: { kind: "Building", building: "Apartment" } },
  S: { name: "Commerce", cost: 1, blurb: "Somewhere to eat and something to do, from nine till late. Commerce arrives more often.", effect: { kind: "Weight", class: "Commerce" } },
  R: { name: "Restaurant", cost: 1, blurb: "Lunch, and an evening out. A dozen at a time, with the traffic that brings.", effect: { kind: "Building", building: "Restaurant" } },
  B: { name: "Bar", cost: 1, blurb: "The last place open. The evening's traffic goes here, and comes home at two.", effect: { kind: "Building", building: "Bar" } },
  G: { name: "Gas station", cost: 1, blurb: "Cars run dry. Pumps round the clock, wherever the driving is.", effect: { kind: "Building", building: "GasStation" } },
  I: { name: "Industry", cost: 1, blurb: "Jobs that keep to themselves. Industry arrives more often.", effect: { kind: "Weight", class: "Industry" } },
  W: { name: "Workshop", cost: 1, blurb: "Six jobs, seven to four.", effect: { kind: "Building", building: "Workshop" } },
  F: { name: "Factory", cost: 1, blurb: "Twenty-four jobs, six to three. The morning rush starts here.", effect: { kind: "Building", building: "Factory" } },
  r: { name: "Roads", cost: 1, blurb: "Twenty more tiles of road. Room to build.", effect: { kind: "RoadTiles", tiles: 20 } },
  o: { name: "One-way streets", cost: 1, blurb: "One-way streets. Half the road, all the throughput.", effect: { kind: "OneWay" } },
};

const [open, setOpen] = createSignal(false);
export { open as treeOpen, setOpen as setTreeOpen };

/** One cell of the plan, in pixels. Nodes fill it; roads run through it. */
const CELL = 44;

type Cell = { x: number; y: number };
// The map is written with a space between cells, so it can be read; a cell
// is every other column.
const at = (x: number, y: number) => MAP[y]?.[x * 2] ?? " ";
const isRoad = (x: number, y: number) => at(x, y) === ".";
const isNode = (x: number, y: number) => at(x, y) in LEGEND;
const isPaved = (x: number, y: number) => isRoad(x, y) || isNode(x, y);
const k = (c: Cell) => `${c.x},${c.y}`;

const STEPS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/**
 * The cells a cell is joined to: the eight around it that are paved, except
 * a diagonal that would cut the corner of a bend, which is the same rule the
 * map's own roads keep so a diagonal is a diagonal and a corner is a corner.
 */
function joined(c: Cell): Cell[] {
  return STEPS.map(([dx, dy]) => ({ x: c.x + dx, y: c.y + dy })).filter((n) => {
    if (!isPaved(n.x, n.y)) return false;
    const dx = n.x - c.x, dy = n.y - c.y;
    if (dx !== 0 && dy !== 0 && (isPaved(c.x + dx, c.y) || isPaved(c.x, c.y + dy))) return false;
    return true;
  });
}

/** A cell's road surface at half-width `hw`, as the map draws it, in pixels. */
const outlines = new Map<string, string>();
function outline(c: Cell, hw: number): string {
  const key = `${k(c)}:${hw}`;
  const cached = outlines.get(key);
  if (cached) return cached;
  const arms: ArmInfo[] = joined(c).map((n) => {
    const a = Math.atan2(n.y - c.y, n.x - c.x);
    return { angle: a < 0 ? a + Math.PI * 2 : a, flow: "twoway" };
  });
  const geo = buildRoadGeometry(arms, hw, 0);
  const pts: string[] = [];
  // The first point is the fan's centre; the rest are the outline.
  for (let i = 3; i < (geo?.positions.length ?? 0); i += 3) {
    pts.push(`${(c.x + 0.5 + geo!.positions[i]) * CELL},${(c.y + 0.5 + geo!.positions[i + 1]) * CELL}`);
  }
  const s = pts.join(" ");
  outlines.set(key, s);
  return s;
}

/**
 * The plan, read: every node, and every run of road between two nodes. A run
 * is followed cell by cell from a node until it reaches another; the road's
 * cells are kept so they can be lit with it.
 */
function read() {
  const nodes: Cell[] = [];
  MAP.forEach((row, y) => { for (let x = 0; x * 2 < row.length; x++) if (at(x, y) in LEGEND) nodes.push({ x, y }); });
  const runs: { a: Cell; b: Cell; cells: Cell[] }[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    for (const first of joined(n)) {
      if (!isRoad(first.x, first.y) || seen.has(k(first))) continue;
      const cells: Cell[] = [];
      let prev = n;
      let cur = first;
      // Walk the run to its far end.
      while (isRoad(cur.x, cur.y)) {
        cells.push(cur);
        seen.add(k(cur));
        const next = joined(cur).find((c) => k(c) !== k(prev));
        if (!next) break;
        prev = cur;
        cur = next;
      }
      if (isNode(cur.x, cur.y)) runs.push({ a: n, b: cur, cells });
    }
  }
  return { nodes, runs };
}

export default function SkillTree() {
  const { growth } = useGame();
  const plan = read();
  const w = Math.ceil(Math.max(...MAP.map((r) => r.length)) / 2) * CELL;
  const h = MAP.length * CELL;

  // Local for now: which nodes are taken. The root always is.
  const root = plan.nodes.find((n) => at(n.x, n.y) === "@")!;
  const [taken, setTaken] = createSignal<Set<string>>(new Set([k(root)]));
  const neighbours = (c: Cell) => plan.runs.filter((r) => k(r.a) === k(c) || k(r.b) === k(c)).map((r) => (k(r.a) === k(c) ? r.b : r.a));
  const available = (c: Cell) => !taken().has(k(c)) && neighbours(c).some((n) => taken().has(k(n)));
  const spent = createMemo(() => [...taken()].reduce((sum, key) => { const [x, y] = key.split(",").map(Number); return sum + LEGEND[at(x, y)].cost; }, 0));
  const points = () => growth().level - spent();
  const take = (c: Cell) => { if (available(c)) setTaken((t) => new Set([...t, k(c)])); };

  const [hover, setHover] = createSignal<Cell | null>(null);
  const hoverKind = () => { const c = hover(); return c ? LEGEND[at(c.x, c.y)] : undefined; };

  // Starts fitted to the panel; pan and zoom from there.
  const fit = () => Math.min(1.4, (window.innerWidth - 48 - 40) / w, (window.innerHeight - 48 - 160) / h);
  const [view, setView] = createSignal({ x: 0, y: 0, scale: fit() });
  let drag: { x: number; y: number; vx: number; vy: number } | null = null;

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "l") {
        setOpen((o) => !o);
        if (open()) setView({ x: 0, y: 0, scale: fit() });
      }
      if (e.key === "Escape" && open()) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  const colorOf = (e: Effect) =>
    e.kind === "Building" ? BLUEPRINTS[e.building].color
    : e.kind === "Weight" ? { Living: "#3F9B5A", Commerce: "#2F7FD4", Industry: "#C97A1E" }[e.class]
    : e.kind === "Nothing" ? "#292524"
    : "#8A8F98";

  return (
    <Show when={open()}>
      <div class="fixed inset-0 z-20 bg-stone-900/80 backdrop-blur-sm select-none" onClick={() => setOpen(false)}>
        <div
          class="absolute inset-6 rounded-2xl overflow-hidden shadow-2xl cursor-grab"
          style={{ background: "#8FA36A" }}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => { if (e.button !== 0) return; drag = { x: e.clientX, y: e.clientY, vx: view().x, vy: view().y }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); }}
          onPointerMove={(e) => { if (drag) setView((v) => ({ ...v, x: drag!.vx + (e.clientX - drag!.x), y: drag!.vy + (e.clientY - drag!.y) })); }}
          onPointerUp={() => (drag = null)}
          onWheel={(e) => { e.preventDefault(); setView((v) => ({ ...v, scale: Math.min(2.5, Math.max(0.5, v.scale * (e.deltaY > 0 ? 0.9 : 1.1))) })); }}
        >
          {/* The land's grid, faint, like the map's own. */}
          <div class="absolute inset-0 opacity-30" style={{ "background-image": "linear-gradient(rgba(0,0,0,0.12) 1px, transparent 1px), linear-gradient(90deg, rgba(0,0,0,0.12) 1px, transparent 1px)", "background-size": `${CELL}px ${CELL}px` }} />

          <div class="absolute left-5 top-4 text-stone-900">
            <div class="text-xs font-semibold uppercase tracking-widest text-stone-700/70">Level {growth().level}</div>
            <div class="text-lg font-bold">{points()} {points() === 1 ? "point" : "points"} to spend</div>
          </div>
          <div class="absolute right-5 top-4 text-[11px] text-stone-800/60">drag to pan · wheel to zoom · L or Esc to close</div>

          <svg class="absolute inset-0 h-full w-full">
            <g transform={`translate(${view().x + (window.innerWidth - 48 - w * view().scale) / 2}, ${view().y + (window.innerHeight - 48 - h * view().scale) / 2}) scale(${view().scale})`}>
              {/* Roads, cell by cell in the map's own shapes: a run lit when
                  both its ends stand, dim when one does, faint otherwise. The
                  kerbs of every cell go down first, then every surface, so a
                  surface is never cut by its neighbour's kerb. */}
              <For each={[BORDER_HALF_W, HALF_W]}>
                {(hw) => (
                  <For each={plan.runs}>
                    {(run) => {
                      const ends = () => Number(taken().has(k(run.a))) + Number(taken().has(k(run.b)));
                      const fill = () => hw === HALF_W
                        ? (ends() === 2 ? "#D8CFC4" : ends() === 1 ? "#BFB7AE" : "#86965F")
                        : (ends() === 2 ? "#6E6259" : ends() === 1 ? "#9E948B" : "#7E8E5C");
                      return (
                        <For each={[run.a, ...run.cells, run.b]}>
                          {(c) => <polygon points={outline(c, hw)} fill={fill()} class="transition-[fill] duration-300" />}
                        </For>
                      );
                    }}
                  </For>
                )}
              </For>
              {/* Buildings: solid when taken, outlined when the next point could build them, a footing otherwise. */}
              <For each={plan.nodes}>
                {(c) => {
                  const kind = LEGEND[at(c.x, c.y)];
                  const state = () => (taken().has(k(c)) ? "taken" : available(c) ? "available" : "locked");
                  const big = kind.effect.kind === "Building" || kind.effect.kind === "Nothing";
                  const size = big ? CELL * 1.5 : CELL * 1.05;
                  const color = colorOf(kind.effect);
                  return (
                    <g
                      transform={`translate(${c.x * CELL + CELL / 2}, ${c.y * CELL + CELL / 2})`}
                      class="cursor-pointer"
                      classList={{ "tree-available": state() === "available" }}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); take(c); }}
                      onPointerEnter={() => setHover(c)}
                      onPointerLeave={() => setHover(null)}
                    >
                      {/* Shadow, the map's way: offset, no filter. */}
                      <rect x={-size / 2 + 3} y={-size / 2 + 5} width={size} height={size} rx={8} fill="rgba(0,0,0,0.22)" opacity={state() === "taken" ? 1 : 0} class="transition-opacity duration-300" />
                      <rect
                        x={-size / 2} y={-size / 2} width={size} height={size} rx={8}
                        fill={state() === "taken" ? color : state() === "available" ? "rgba(255,255,255,0.35)" : "rgba(0,0,0,0.08)"}
                        stroke={state() === "available" ? color : state() === "locked" ? "rgba(0,0,0,0.15)" : "none"}
                        stroke-width={3}
                        stroke-dasharray={state() === "available" ? "6 5" : undefined}
                        class="transition-[fill] duration-300"
                      />
                      <Show when={kind.effect.kind === "Building"}>
                        <BuildingIcon kind={(kind.effect as { building: BuildingKind }).building} class={state() === "taken" ? "text-white" : "text-stone-900/60"} x={-size * 0.3} y={-size * 0.3} width={size * 0.6} height={size * 0.6} />
                      </Show>
                      <Show when={kind.effect.kind !== "Building"}>
                        <text text-anchor="middle" dy="0.36em" fill={state() === "taken" ? "#fff" : "rgba(28,25,23,0.6)"} style={{ "font-size": `${size * 0.5}px`, "font-weight": 700 }}>
                          {kind.effect.kind === "Weight" ? "+" : kind.effect.kind === "RoadTiles" ? String(kind.effect.tiles) : kind.effect.kind === "OneWay" ? "→" : "★"}
                        </text>
                      </Show>
                    </g>
                  );
                }}
              </For>
            </g>
          </svg>

          <Show when={hoverKind()}>
            {(kind) => (
              <div class="absolute bottom-5 left-1/2 -translate-x-1/2 max-w-md rounded-xl bg-white/95 px-4 py-3 shadow-xl text-stone-800">
                <div class="flex items-baseline justify-between gap-6">
                  <span class="font-bold">{kind().name}</span>
                  <span class="text-xs text-stone-500">{kind().cost === 0 ? "free" : `${kind().cost} point`}</span>
                </div>
                <div class="text-sm mt-1">{kind().blurb}</div>
              </div>
            )}
          </Show>
        </div>
      </div>
    </Show>
  );
}
