import { isBuilt, type Town } from "./grid";
import { formOf, type Yard } from "./mass";
import { defaultJoins, INSET, type Pt } from "./footprint";
import { CAB, HALF_W, TRAILER } from "../objects/roadGeometry";

/**
 * What a tile cannot see from its neighbours, worked out once over the
 * whole town before anything is drawn. Everything else about a tile's look
 * is a function of it, its neighbours and these facts.
 *
 * - **Heads**: the tiles of a shed that are its office, a couple of storeys
 *   taller (in `town`, the town as drawn).
 * - **Enclosed**: open ground closed in by buildings, a courtyard, which
 *   no street and no edge of the map reaches.
 * - **Yards**: a building whose kind keeps a yard (`mass.ts`) gives up as
 *   much of its ground as the yard must hold: tiles beside a street, in
 *   one run from its quiet end or its busy one, until there is room
 *   enough. The rest is building. A depot's yard holds lorries at docks
 *   on the wall across from its street, and its office stands at the busy
 *   end; a supermarket's holds cars in rows, its car park on the corner.
 * - **Ferry ports**: down one side of a port, the one whose end reaches a
 *   street, runs its exit road, from the ramp at the quay back to the
 *   street, so the cars come off before the queue goes on. Beside it the
 *   yard holds the next sailing, queue lanes from the water back, as many
 *   tiles as one ferry load fills; the rest, in the far corner, is the
 *   terminal. At the middle of its water's edge, a ramp, and
 *   the ferry moored stern on to it (`ferries`).
 * - **Service bays**: a supermarket two tiles or more each way takes its
 *   deliveries at the back. A lane is cut from its quieter side, from the
 *   front to the back, and at the lane's end a bump sticks out of the back
 *   wall: the loading bay, its door facing up the lane, a lorry backed up
 *   to it. None of it takes a tile: the lane is cut from the building, the
 *   bump stands in the margins behind it. A supermarket with another
 *   street besides its front, its wall there a lorry long, takes its
 *   deliveries by the quietest: a loading block standing out of that
 *   wall to the kerb, the lorry parked along the kerb with its tail to
 *   it, its side and car park whole.
 */

/** A supermarket's service bay, in the town's plan: the lane cut from the
 *  building, the bump added to it, the lane's tarmac, and the dock at the
 *  bump's door. */
export interface Service {
  cut?: Pt[];
  bump?: Pt[];
  lane?: Pt[];
  dock: { x: number; y: number; angle: number };
}
/** Room along a wall for a lorry parked at the kerb and the loading
 *  block it backs to, and the block's width along the wall. */
const BLOCK = { w: 0.16 };
const LAYBY = { l: CAB.l + TRAILER.l + BLOCK.w + 0.06 };
/** The lane's width, cut from the building beyond its inset. */
const LANE = 0.3;
/** How far the bump reaches past its tile's edge: into the margin beyond,
 *  still short of a building there. */
const BUMP = 0.12;

/** Lorry bays along a dock: three to a tile of wall. */
export const DOCKS = 3;
/** Cars in a tile of car park: two rows of five, an aisle between. */
export const PARKED = 10;
/** Cars queued in a tile of a ferry port's yard: four lanes of two. */
export const QUEUED = 8;

export interface Facts {
  /** The town as drawn: the painted one with the heads raised. */
  town: Town;
  head(c: number, r: number): boolean;
  enclosed(c: number, r: number): boolean;
  /** What stands in a tile of yard, if it is one. */
  yard(c: number, r: number): Yard["fill"] | undefined;
  /** A yard tile's docks: the ways to the hall walls it faces, straight
   *  across from its street. */
  docks(c: number, r: number): [number, number][];
  services: Service[];
  ferries: Ferry[];
}

/** A ferry port's berth: which way the water is from its quay, and the
 *  quay end of its exit road, where the ramp is. */
export interface Ferry {
  to: [number, number];
  /** Which side of the yard its exit road runs down. */
  side: [number, number];
  x: number;
  y: number;
}

export function facts(painted: Town): Facts {
  const yard = yards(painted);
  const walls = docksOf(painted, (c, r) => yard.has(`${c},${r}`));
  // The yard is open ground, but the building keeps the joins it was
  // painted with, so the walls round its yard stand square.
  const open: Town = {
    ...painted,
    joins: painted.joins ?? defaultJoins(painted),
    tile: (c, r) => (yard.has(`${c},${r}`) ? { kind: "paved", storeys: 0 } : painted.tile(c, r)),
  };
  const { lifted, heads } = sheds(open);
  const closed = courtyards(open);
  return {
    town: lifted,
    head: (c, r) => heads.has(`${c},${r}`),
    enclosed: (c, r) => closed.has(`${c},${r}`),
    yard: (c, r) => yard.get(`${c},${r}`),
    docks: (c, r) => (yard.get(`${c},${r}`) === "docks" ? walls(c, r) : []),
    services: services(painted, yard),
    ferries: ferries(painted, yard),
  };
}

/** Each ferry port's berth: on the side with most water along it, at the
 *  middle of that edge. */
function ferries(town: Town, yard: Map<string, Yard["fill"]>): Ferry[] {
  const out: Ferry[] = [];
  for (const cells of buildings(town)) {
    if (formOf(town.tile(...cells[0])).yard?.fill !== "ferry") continue;
    const { to, side } = berth(town, cells);
    const quay = cells.find(([c, r]) => yard.get(`${c},${r}`) === "exit" && town.tile(c + to[0], r + to[1]).kind === "water");
    if (!quay) continue;
    out.push({ to, side, x: quay[0] + 0.5 + to[0] / 2, y: quay[1] + 0.5 + to[1] / 2 });
  }
  return out;
}

/** A ferry port's lie: which way the water is from its quay, the side most
 *  water is on, and which side its exit road runs down, the side whose
 *  last tiles reach a street (the first such, `to` turned left, then
 *  right). */
function berth(town: Town, cells: [number, number][]) {
  const wet = (c: number, r: number) => town.tile(c, r).kind === "water";
  const along = ([dc, dr]: number[]) => cells.filter(([c, r]) => wet(c + dc, r + dr)).length;
  const to = [...SIDES].sort((a, b) => along(b) - along(a))[0] as [number, number];
  const column = (s: number[]) => {
    const far = Math.max(...cells.map(([c, r]) => c * s[0] + r * s[1]));
    return cells.filter(([c, r]) => c * s[0] + r * s[1] === far);
  };
  const sides = [[-to[1], to[0]], [to[1], -to[0]]] as [number, number][];
  const side = sides.find((s) => column(s).some(([c, r]) => SIDES.some(([dc, dr]) => town.tile(c + dc, r + dr).kind === "road"))) ?? sides[0];
  return { to, side, exit: column(side) };
}

/** Each supermarket's service bay, where it is two tiles or more each way:
 *  in the frame of its front `f` (toward its car park, or its street) and
 *  its quieter side `s`. */
function services(town: Town, yard: Map<string, Yard["fill"]>): Service[] {
  const out: Service[] = [];
  for (const cells of buildings(town)) {
    if (town.tile(...cells[0]).kind !== "Supermarket") continue;
    const shop = cells.filter(([c, r]) => !yard.has(`${c},${r}`));
    const open = (c: number, r: number) => yard.has(`${c},${r}`) || town.tile(c, r).kind === "road";
    // Its front: the side with most car park and street along it.
    const along = ([dc, dr]: number[]) => shop.filter(([c, r]) => open(c + dc, r + dr)).length;
    const f = [...SIDES].sort((a, b) => along(b) - along(a))[0];
    if (!shop.length || !along(f)) continue;
    /** A tile's extent along an axis. */
    const span = ([ux, uy]: number[], [c, r]: [number, number]) => {
      const ks = [[c, r], [c + 1, r], [c, r + 1], [c + 1, r + 1]].map(([x, y]) => x * ux + y * uy);
      return [Math.min(...ks), Math.max(...ks)];
    };
    const extent = (u: number[]) => [Math.min(...shop.map((t) => span(u, t)[0])), Math.max(...shop.map((t) => span(u, t)[1]))];
    const back = [-f[0], -f[1]];
    // Deliveries come by the quietest street along its shop, to a loading
    // block standing out of the wall there, the lorry parked
    // along the kerb with its tail to the block, where that wall is a
    // lorry long: nothing is cut from its side or its car park.
    const layby = SIDES.flatMap((d) => {
      const on = shop.filter(([c, r]) => town.tile(c + d[0], r + d[1]).kind === "road");
      const [sx, sy] = [-d[1], d[0]];
      if (!on.length) return [];
      const [q0, q1] = [Math.min(...on.map((t) => span([sx, sy], t)[0])), Math.max(...on.map((t) => span([sx, sy], t)[1]))];
      if (q1 - q0 - 2 * INSET < LAYBY.l) return [];
      const quiet = on.reduce((n, [c, r]) => n + streetAround(town, c + d[0], r + d[1]), 0) / on.length;
      return [{ d, sx, sy, q0, q1, wall: Math.max(...on.map((t) => span(d, t)[1])) - INSET, quiet }];
    }).sort((a, b) => a.quiet - b.quiet)[0];
    if (layby) {
      const { d, sx, sy, q0, q1, wall } = layby;
      /** A point by how far out toward that street and how far along it. */
      const at = (a: number, q: number): Pt => [a * d[0] + q * sx, a * d[1] + q * sy];
      const box = (a: number, b: number, p: number, q: number): Pt[] => [at(a, p), at(b, p), at(b, q), at(a, q)];
      // The block at one end of the wall, out to the kerb; the lorry at
      // the kerb beside it, its tail to the block's side.
      const m0 = (q0 + q1 - LAYBY.l) / 2;
      const kerb = wall + INSET + 0.5 - HALF_W - 0.03 - TRAILER.w / 2;
      const [x, y] = at(kerb, m0 + BLOCK.w);
      out.push({
        bump: box(wall - 0.2, kerb + TRAILER.w / 2, m0, m0 + BLOCK.w),
        dock: { x, y, angle: Math.atan2(sy, sx) },
      });
      continue;
    }
    const [a0, a1] = extent(back);
    const sides = [[-f[1], f[0]], [f[1], -f[0]]];
    if (a1 - a0 < 2 || extent(sides[0])[1] + extent(sides[1])[1] < 2) continue;
    // The quieter side: less street round its back corner.
    const corner = (s: number[]) => shop.reduce((best, t) => (span(s, t)[1] + span(back, t)[1] > span(s, best)[1] + span(back, best)[1] ? t : best));
    const s = sides.map((s) => ({ s, n: streetAround(town, ...corner(s)) })).sort((a, b) => a.n - b.n)[0].s;
    const q1 = extent(s)[1];
    /** A point by how far back it is and how far to the side. */
    const at = (a: number, q: number): Pt => [a * back[0] + q * s[0], a * back[1] + q * s[1]];
    const box = (a: number, b: number, p: number, q: number): Pt[] => [at(a, p), at(b, p), at(b, q), at(a, q)];
    const wall = a1 - INSET;
    const mid = q1 - INSET / 2 - LANE / 2 - 0.03;
    const [x, y] = at(wall, mid);
    out.push({
      cut: box(a0 - 0.01, a1 + 0.01, q1 - INSET - LANE, q1 + 0.01),
      bump: box(wall - 0.05, a1 + BUMP, q1 - INSET - LANE - 0.45, q1 - 0.05),
      lane: box(a0, wall, q1 - INSET - LANE, q1 - 0.06),
      dock: { x, y, angle: Math.atan2(-back[1], -back[0]) },
    });
  }
  return out;
}

const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Each building of a kind with a yard, as its joins hold it together. */
function buildings(town: Town): [number, number][][] {
  const joined = town.joins ?? defaultJoins(town);
  const seen = new Set<string>();
  const out: [number, number][][] = [];
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      const kind = town.tile(c, r).kind;
      if (!formOf(town.tile(c, r)).yard || seen.has(`${c},${r}`)) continue;
      seen.add(`${c},${r}`);
      const cells: [number, number][] = [[c, r]];
      for (let i = 0; i < cells.length; i++) {
        const [a, b] = cells[i];
        for (const [dc, dr] of SIDES) {
          const [x, y] = [a + dc, b + dr];
          if (town.tile(x, y).kind === kind && !seen.has(`${x},${y}`) && (joined(a, b, x, y) || joined(x, y, a, b))) seen.add(`${x},${y}`), cells.push([x, y]);
        }
      }
      out.push(cells);
    }
  }
  return out;
}

/** A yard tile's docks: toward each tile of its building that is not yard
 *  and lies straight across from a street the yard tile is on. */
const docksOf = (town: Town, yard: (c: number, r: number) => boolean) => (c: number, r: number) =>
  SIDES.filter(([dc, dr]) => town.tile(c - dc, r - dr).kind === "road" && town.tile(c + dc, r + dr).kind === town.tile(c, r).kind && !yard(c + dc, r + dr)) as [number, number][];

/** How much street is round a tile, the nearer the more: a corner on a
 *  junction has most. */
function streetAround(town: Town, c: number, r: number) {
  let n = 0;
  for (let dr = -3; dr <= 3; dr++) for (let dc = -3; dc <= 3; dc++) if (town.tile(c + dc, r + dr).kind === "road") n += 1 / (dc * dc + dr * dr);
  return n;
}

/** Each building's yard: street-side tiles in one run from its quiet or
 *  its busy end, until the yard holds what the building needs. */
function yards(town: Town): Map<string, Yard["fill"]> {
  const out = new Map<string, Yard["fill"]>();
  for (const cells of buildings(town)) {
    const { fill, end, need } = formOf(town.tile(...cells[0])).yard!;
    const yard = new Set<string>();
    // A ferry port's exit road is laid first, down its side, and the yard
    // fills from the water back, nearest the exit first.
    const lie = fill === "ferry" ? berth(town, cells) : undefined;
    const exit = new Set((lie?.exit ?? []).map(([c, r]) => `${c},${r}`));
    const inYard = (c: number, r: number) => yard.has(`${c},${r}`) || exit.has(`${c},${r}`);
    const walls = docksOf(town, inYard);
    const street = (c: number, r: number) => SIDES.some(([dc, dr]) => town.tile(c + dc, r + dr).kind === "road");
    const holds = (c: number, r: number) => (fill === "docks" ? DOCKS * walls(c, r).length : fill === "ferry" ? QUEUED : street(c, r) ? PARKED : 0);
    const shore = (c: number, r: number) => Math.min(...cells.filter(([x, y]) => SIDES.some(([dc, dr]) => town.tile(x + dc, y + dr).kind === "water")).map(([x, y]) => Math.abs(x - c) + Math.abs(y - r)));
    const held = () => [...yard].reduce((n, k) => n + holds(...(k.split(",").map(Number) as [number, number])), 0);
    const toExit = ([c, r]: [number, number]) => (lie ? -(c * lie.side[0] + r * lie.side[1]) : 0);
    const order = (a: [number, number], b: [number, number]) =>
      (end === "water" ? shore(...a) - shore(...b) : (end === "quiet" ? 1 : -1) * (streetAround(town, ...a) - streetAround(town, ...b))) || toExit(a) - toExit(b) || a[1] - b[1] || a[0] - b[0];
    while (held() < need(cells.length) && yard.size + exit.size + 1 < cells.length) {
      const next = cells
        .filter(([c, r]) => !inYard(c, r) && holds(c, r))
        .filter(([c, r]) => !yard.size || SIDES.some(([dc, dr]) => inYard(c + dc, r + dr)))
        .sort(order)[0];
      if (!next) break;
      yard.add(`${next[0]},${next[1]}`);
    }
    for (const k of yard) out.set(k, fill);
    for (const k of exit) out.set(k, "exit");
  }
  return out;
}

/** Open ground in regions (joined side by side) that touch neither a road
 *  nor the map's edge. */
function courtyards(town: Town): Set<string> {
  const open = (c: number, r: number) => ["open", "paved"].includes(town.tile(c, r).kind);
  const out = new Set<string>();
  const seen = new Set<string>();
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      if (!open(c, r) || seen.has(`${c},${r}`)) continue;
      const region: [number, number][] = [[c, r]];
      seen.add(`${c},${r}`);
      let reached = false;
      for (let i = 0; i < region.length; i++) {
        const [x, y] = region[i];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const [nx, ny] = [x + dx, y + dy];
          if (nx < 0 || ny < 0 || nx >= town.w || ny >= town.h) reached = true;
          else if (town.tile(nx, ny).kind === "road") reached = true;
          else if (open(nx, ny) && !seen.has(`${nx},${ny}`)) seen.add(`${nx},${ny}`), region.push([nx, ny]);
        }
      }
      if (!reached) for (const [x, y] of region) out.add(`${x},${y}`);
    }
  }
  return out;
}

/**
 * A shed as a business park has it: an office at its street end, a couple
 * of storeys over the hall and lighter. It is found from the building's
 * tiles: its long way is the way it is longer, and its head is the end,
 * right across, with the tile that has most street round it, the corner on
 * a junction if it has one. A workshop of a tile or three is a hall alone.
 */
function sheds(town: Town) {
  const key = (c: number, r: number) => `${c},${r}`;
  const heads = new Set<string>();
  const seen = new Set<string>();
  const street = (c: number, r: number) => streetAround(town, c, r);
  const joined = town.joins ?? defaultJoins(town);
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      if (formOf(town.tile(c, r)).family !== "industry" || seen.has(key(c, r))) continue;
      seen.add(key(c, r));
      const cells = [[c, r]];
      for (let i = 0; i < cells.length; i++) {
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const [[a, b], [x, y]] = [cells[i], [cells[i][0] + dc, cells[i][1] + dr]];
          if (isBuilt(town.tile(x, y)) && (joined(a, b, x, y) || joined(x, y, a, b)) && !seen.has(key(x, y))) seen.add(key(x, y)), cells.push([x, y]);
        }
      }
      if (cells.length < 4) continue;
      const span = (k: number) => Math.max(...cells.map((p) => p[k])) - Math.min(...cells.map((p) => p[k]));
      const long = span(1) > span(0) ? 1 : 0;
      const ends = [Math.min(...cells.map((p) => p[long])), Math.max(...cells.map((p) => p[long]))];
      const head = cells.filter((p) => ends.includes(p[long])).reduce((a, b) => (street(b[0], b[1]) > street(a[0], a[1]) ? b : a));
      if (street(head[0], head[1])) for (const p of cells) if (p[long] === head[long]) heads.add(key(p[0], p[1]));
    }
  }
  const lifted: Town = { ...town, tile: (c, r) => (heads.has(key(c, r)) ? { ...town.tile(c, r), storeys: town.tile(c, r).storeys + 2 } : town.tile(c, r)) };
  return { lifted, heads };
}

