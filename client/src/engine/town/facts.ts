import { isBuilt, type Town } from "./grid";
import { formOf, type Yard } from "./mass";
import { defaultJoins, INSET, type Pt } from "./footprint";
import { CAB, TRAILER } from "../objects/roadGeometry";

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
 * - **Loading bays**: a supermarket whose shop is two tiles or more each
 *   way takes its deliveries in a corner cut from it, a lorry long and
 *   wide, the lorry backed in along the wall with its tail to the door.
 *   The back corner if a street runs behind, else down a side street,
 *   else down a side with room, beside the car park. The lorry stands in
 *   the shop's own tiles: never on a road, nothing paved for it.
 */

/** A supermarket's loading bay, in the town's plan: the corner cut from
 *  the building, and the dock at its inner end, where the lorry's tail
 *  is. */
export interface Service {
  cut: Pt[];
  dock: { x: number; y: number; angle: number };
  /** The corner tile, the wall it runs along and the way its cab points. */
  corner: [number, number];
  d: number[];
  s: number[];
}
/** The cutout: a lorry long and a little over, a lorry wide and a little
 *  over. */
const BAY = { l: TRAILER.l + 0.02 + CAB.l + 0.04, w: TRAILER.w + 0.06 };

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

/** Each supermarket's loading bay, where its shop is two tiles or more
 *  each way: a lorry-sized cutout in a corner, in the frame of the wall
 *  `d` it runs along and the way `s` the lorry's cab points, out of the
 *  corner. */
function services(town: Town, yard: Map<string, Yard["fill"]>): Service[] {
  const out: Service[] = [];
  for (const cells of buildings(town)) {
    if (town.tile(...cells[0]).kind !== "Supermarket") continue;
    const shop = cells.filter(([c, r]) => !yard.has(`${c},${r}`));
    const parked = (c: number, r: number) => yard.has(`${c},${r}`);
    const road = (c: number, r: number) => town.tile(c, r).kind === "road";
    // Its front: the side with most car park along it, then street.
    const along = (open: typeof road, [dc, dr]: number[]) => shop.filter(([c, r]) => open(c + dc, r + dr)).length;
    const f = [...SIDES].sort((a, b) => along(parked, b) - along(parked, a) || along(road, b) - along(road, a))[0];
    if (!shop.length || !(along(parked, f) + along(road, f))) continue;
    /** How far a tile reaches along an axis. */
    const far = ([ux, uy]: number[], [c, r]: [number, number]) => Math.max(c * ux + r * uy, (c + 1) * ux + r * uy, c * ux + (r + 1) * uy, (c + 1) * ux + (r + 1) * uy);
    const extent = (u: number[]) => Math.max(...shop.map((t) => far(u, t))) + Math.max(...shop.map((t) => far([-u[0], -u[1]], t)));
    if (extent(f) < 2 || extent([f[1], f[0]]) < 2) continue;
    const back = [-f[0], -f[1]];
    const sides = [[-f[1], f[0]], [f[1], -f[0]]];
    const street = (d: number[]) => shop.some(([c, r]) => far(d, [c, r]) === Math.max(...shop.map((t) => far(d, t))) && town.tile(c + d[0], r + d[1]).kind === "road");
    /** The tile at the corner of walls `d` and `s`: furthest along `d`,
     *  then along `s`. */
    const corner = (d: number[], s: number[]) => shop.reduce((best, t) => (far(d, t) - far(d, best) || far(s, t) - far(s, best)) > 0 ? t : best);
    const mine = new Set(cells.map(([c, r]) => `${c},${r}`));
    const room = (c: number, r: number) => mine.has(`${c},${r}`) || !isBuilt(town.tile(c, r));
    const free = (d: number[], s: number[]) => {
      const [c, r] = corner(d, s);
      return room(c + d[0], r + d[1]) && room(c + d[0] + s[0], r + d[1] + s[1]);
    };
    const quiet = (d: number[]) => shop.reduce((n, [c, r]) => n + streetAround(town, c + d[0], r + d[1]), 0);
    /** Out of the corner of `d` and `s`, straight onto a street rather
     *  than across the car park. */
    const clear = (d: number[], s: number[]) => {
      const [c, r] = corner(d, s);
      return !parked(c + s[0], r + s[1]);
    };
    // The back, if a street runs behind, the cab toward a side street, or
    // a side with room; else a side with a street, the cab to the back;
    // else a side with room, the cab to the front, beside the car park
    // rather than through it.
    const [d, s] =
      street(back) ? [back, sides.find(street) ?? sides.find((s) => free(back, s)) ?? sides[0]]
      : sides.some(street) ? [sides.filter(street).sort((a, b) => quiet(a) - quiet(b))[0], back]
      : [sides.filter((d) => free(d, f)).sort((a, b) => +clear(b, f) - +clear(a, f))[0], f];
    if (!d) continue;
    const [c, r] = corner(d, s);
    const [wall, end] = [far(d, [c, r]) - INSET, far(s, [c, r]) - INSET];
    /** A point by how far out along `d` and how far along `s`. */
    const at = (a: number, q: number): Pt => [a * d[0] + q * s[0], a * d[1] + q * s[1]];
    const [x, y] = at(wall - BAY.w / 2, end - BAY.l);
    out.push({
      cut: [at(wall - BAY.w, end - BAY.l), at(wall + INSET, end - BAY.l), at(wall + INSET, end + INSET), at(wall - BAY.w, end + INSET)],
      dock: { x, y, angle: Math.atan2(s[1], s[0]) },
      corner: [c, r], d, s,
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

