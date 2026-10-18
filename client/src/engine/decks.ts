import type { EngineContext, Mesh, SceneContext } from "@babylonjs/lite";
import { drop, meshOf, show, type MeshGeometry } from "./geometry";
import { setTint, townMaterial } from "./material";
import { rgb } from "./rgb";
import { CUT } from "./kerbs";
import { ROAD_Z } from "./objects/roadGeometry";
import { flatPolygons, PAVED_Z } from "./town/draw";
import { seams, shapeOf, type Surface } from "./town/surface";
import { area, type Pt } from "./town/footprint";
import type { Casters } from "./DayNightCycle";

/**
 * Roads above the ground (`server/src/world/decks.rs`). A deck's road is
 * a road tile like the ground's, drawn by the same hand (`roads.ts`), its
 * shape and paint its tile's, lifted to its height (`liftOf`); a slope's
 * up across its own tile, from the edge it comes in by at the level below
 * to the edge it goes out by at the level above, and slopes one after
 * another as one climb, eased (`heightAlong`). Under it, here, its
 * concrete: along every edge that does not run on into the next tile's
 * road, a parapet, a low wall from over the road's crumbled edge out past
 * it, its side carried down a deck's thickness, its top lighter, rising
 * out of the ground at a slope's foot as the road rises; the deck's
 * underside, which casts its shadow; a pier under every node a level or
 * more up. No kerb: a bridge is its concrete, not the ground's pavement.
 */

/** How high a half-level is: a level is a storey and a bit. */
export const HALF_LEVEL = 0.175;
/** The deck's thickness under its road. */
const DECK = 0.09;
/** A parapet's height over the road, and how far out past its edge it
 *  stands (in over the edge, `CUT`, as the ground's pavement reaches). */
const WALL = 0.05;
const WALL_OUT = 0.035;
/** How far a parapet runs on past its tile's seam, under the next one's;
 *  and onto the ground's, at a slope's foot, over the end of its kerb
 *  (short of the road's own end past the seam, `carried`'s 0.05). */
const OVERLAP = 0.015;
const FOOT = 0.045;
/** A parapet's least height: at a slope's foot, a kerb's. */
const LOW = 0.012;
const TOP = rgb(0.86, 0.85, 0.82);
/** A pier's side. */
const PIER = 0.14;
const CONCRETE = rgb(0.74, 0.73, 0.7);
/** How finely an edge is cut, so its concrete bends with an eased slope. */
const STEP = 0.06;

/** How high a road's surface stands at a height, in half-levels. */
export const deckZ = (height: number) => ROAD_Z + PAVED_Z + height * HALF_LEVEL;

const ease = (u: number) => u * u * (3 - 2 * u);

/** How high, in half-levels, a road stands along a run of nodes of these
 *  heights, at `x` (node k at k, the edge between its tile and the next
 *  at k + 0.5): a level node level to its tile's edges; a slope (an odd
 *  height), with the slopes on either side of it, one climb, eased, from
 *  the edge before the first to the edge after the last. */
export function heightAlong(heights: number[], x: number): number {
  const last = heights.length - 1;
  const k = Math.max(0, Math.min(last, Math.round(x)));
  if (!(heights[k] % 2)) return heights[k] ?? 0;
  let [s, e] = [k, k];
  while (s > 0 && heights[s - 1] % 2) s--;
  while (e < last && heights[e + 1] % 2) e++;
  const up = e < last ? heights[e + 1] > heights[e] : s > 0 ? heights[s - 1] < heights[s] : true;
  const [from, to] = [heights[s] + (up ? -1 : 1), heights[e] + (up ? 1 : -1)];
  return from + (to - from) * ease(Math.max(0, Math.min(1, (x - s + 0.5) / (e - s + 1))));
}

/** How a road tile is lifted (`roads.ts`'s shader): its height above the
 *  ground's road, in tiles, a cubic in how far across the tile it has
 *  climbed (0 at the edge it climbs from, 1 at the one it climbs to), its
 *  four terms; and how that share is had from a point of the tile, in its
 *  road frame (its middle at -0.5, -0.5): along the way from the one
 *  edge's middle to the other's, straight on or round a bend, x and y and
 *  where it starts. A level deck is level; a slope its share of its run's
 *  eased climb (`Surface::run`). */
export type Lift = [number, number, number, number, number, number, number, number];
export function liftOf({ height = 0, climb, run, ways }: Surface): Lift {
  const low = ways.find(([dc, dr, , flow]) => flow !== "d" && climb && (dc !== climb[0] || dr !== climb[1]));
  if (!(height % 2) || !climb || !run || !low) return [height * HALF_LEVEL, 0, 0, 0, 0, 0, 0.5, 0];
  const [i, n, from, to] = run;
  // ease((i + u) / n), its terms in u.
  const [a, b] = [i / n, 1 / n];
  const d = (to - from) * HALF_LEVEL;
  // From the low edge's middle to the high's, in the tile's frame: the road
  // frame is the tile's turned half round, its middle at -0.5.
  const [lx, ly] = [0.5 + low[0] / 2, 0.5 + low[1] / 2];
  const [cx, cy] = [(climb[0] - low[0]) / 2, (climb[1] - low[1]) / 2];
  const len2 = cx * cx + cy * cy;
  const [dx, dy] = [-cx / len2, -cy / len2];
  // u = ((t - low) · c) / |c|², t = -r: as (r + 0.5) · d + off.
  const off = -(lx * cx + ly * cy) / len2 - 0.5 * (dx + dy);
  return [from * HALF_LEVEL + d * (3 * a * a - 2 * a * a * a), d * (6 * a * b - 6 * a * a * b), d * (3 * b * b - 6 * a * b * b), d * -2 * b * b * b, dx, dy, off, 0];
}

/** How high a lifted tile's road stands over a point of it, in its road
 *  frame: `roads.ts`'s shader, here. */
export function liftAt([z0, z1, z2, z3, dx, dy, off]: Lift, x: number, y: number): number {
  const u = Math.max(0, Math.min(1, (x + 0.5) * dx + (y + 0.5) * dy + off));
  return ROAD_Z + PAVED_Z + z0 + u * (z1 + u * (z2 + u * z3));
}

/** A deck's road tile, where it is. */
export interface DeckPiece {
  x: number;
  y: number;
  surface: Surface;
}

export class Decks {
  private meshes: Mesh[] = [];
  private materials = [CONCRETE, TOP].map((c) => {
    const m = townMaterial([], 0.95);
    setTint(m, c);
    return m;
  });

  constructor(
    private engine: EngineContext,
    private scene: SceneContext,
    private casters: Casters | undefined,
  ) {}

  /** The concrete under every deck tile drawn again: its sides and its
   *  parapets' tops. */
  rebuild(pieces: Iterable<DeckPiece>) {
    const parts: MeshGeometry[] = [0, 1].map(() => ({ positions: [], normals: [], indices: [] }));
    for (const { x, y, surface } of pieces) concrete(parts, surface, x + 1, y + 1);
    this.clear();
    for (const [i, name] of ["deck_concrete", "deck_parapets"].entries()) {
      const geo = parts[i];
      if (!geo.indices.length) continue;
      const mesh = meshOf(this.engine, name, geo);
      mesh.material = this.materials[i];
      mesh.receiveShadows = true;
      show(this.scene, mesh);
      this.casters?.add(mesh);
      this.meshes.push(mesh);
    }
  }

  private clear() {
    for (const mesh of this.meshes) (this.casters?.remove(mesh), drop(this.scene, mesh));
    this.meshes = [];
  }

  dispose() {
    this.clear();
  }
}

type V3 = [number, number, number];

function quad(g: MeshGeometry, a: V3, b: V3, c: V3, d: V3) {
  const [ux, uy, uz] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const [vx, vy, vz] = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
  let [nx, ny, nz] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  const l = Math.hypot(nx, ny, nz) || 1;
  [nx, ny, nz] = [nx / l, ny / l, nz / l];
  const i = g.positions.length / 3;
  for (const p of [a, b, c, d]) g.positions.push(...p), g.normals.push(nx, ny, nz);
  // Wound as the engine's front faces are, the other way round from the
  // normal's (`roads.ts`'s square).
  g.indices.push(i, i + 2, i + 1, i, i + 3, i + 2);
}

/** A parapet's round end at `at`, come from `from`: a half disc from its
 *  inner corner to its outer, out the way it ran, at height `h`, its side
 *  down to the road. */
function cap(g: MeshGeometry, tops: MeshGeometry, top: (p: Pt, dz?: number) => V3, inner: Pt, outer: Pt, from: Pt, at: Pt, h: number) {
  const c: Pt = [(inner[0] + outer[0]) / 2, (inner[1] + outer[1]) / 2];
  const r = Math.hypot(outer[0] - c[0], outer[1] - c[1]);
  const l = Math.hypot(at[0] - from[0], at[1] - from[1]) || 1;
  const f: Pt = [(at[0] - from[0]) / l, (at[1] - from[1]) / l];
  const s: Pt = [(inner[0] - c[0]) / (r || 1), (inner[1] - c[1]) / (r || 1)];
  const arc: Pt[] = Array.from({ length: 9 }, (_, k) => {
    const t = (Math.PI * k) / 8;
    return [c[0] + r * (Math.cos(t) * s[0] + Math.sin(t) * f[0]), c[1] + r * (Math.sin(t) * f[1] + Math.cos(t) * s[1])];
  });
  for (let k = 0; k < 8; k++) {
    const [p, q] = [arc[k], arc[k + 1]];
    // Wound as the wall's own top and side are (`concrete`'s), whichever
    // way round the arc runs.
    const up = (p[0] - c[0]) * (q[1] - c[1]) - (p[1] - c[1]) * (q[0] - c[0]) < 0;
    if (up) {
      quad(tops, top(q, h), top(p, h), top(c, h), top(c, h));
      quad(g, top(p, 0), top(q, 0), top(q, h), top(p, h));
    } else {
      quad(tops, top(p, h), top(q, h), top(c, h), top(c, h));
      quad(g, top(q, 0), top(p, 0), top(p, h), top(q, h));
    }
  }
}

/** A ring cut so no edge is longer than `STEP`. */
function finer(ring: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < ring.length; i++) {
    const [a, b] = [ring[i], ring[(i + 1) % ring.length]];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / STEP));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

/** A deck tile's concrete, placed at (ox, oy), into its sides and its
 *  tops: its road's outline in the tile's frame, as `roads.ts` draws it, a
 *  parapet along it where it does not run on, its side carried down to the
 *  underside; the underside; and a pier under its node, a level or more
 *  up. */
function concrete([g, tops]: MeshGeometry[], surface: Surface, ox: number, oy: number) {
  const lift = liftOf(surface);
  // As high as the road has risen off the ground, down to a kerb's.
  const rise = ([x, y]: Pt) => liftAt(lift, -x, -y) - ROAD_Z - PAVED_Z;
  const wall = (p: Pt) => Math.max(LOW, Math.min(WALL, rise(p)));
  // The road frame: the tile's turned half round, its middle at -0.5.
  const top = ([x, y]: Pt, dz = 0): V3 => [ox - x, oy - y, liftAt(lift, -x, -y) + dz];
  // Cut just past each seam it runs on over (`OVERLAP`), so a parapet
  // ends there, under the end of the next tile's: not a piece of edge
  // further on, nor short of it with a crack between. Onto the ground, at
  // a slope's foot, further (`FOOT`), its end round.
  const cuts = seams(surface).map(({ way: [dc, dr], past }) => ({ past, reach: rise([0.5 + dc / 2, 0.5 + dr / 2]) < 0.005 ? FOOT : OVERLAP }));
  const atSeams = (ring: Pt[]) => ring.flatMap((a, i): Pt[] => {
    const b = ring[(i + 1) % ring.length];
    const out: Pt[] = [a];
    for (const { past, reach } of cuts) {
      const [fa, fb] = [past([-a[0], -a[1]]) - reach, past([-b[0], -b[1]]) - reach];
      if (fa * fb < 0) out.push([a[0] + ((b[0] - a[0]) * fa) / (fa - fb), a[1] + ((b[1] - a[1]) * fa) / (fa - fb)]);
    }
    return out;
  });
  const polys = shapeOf(surface).map((poly) => poly.map((ring) => atSeams(finer(ring))));
  for (const [k, ring] of polys.flatMap((poly) => poly.map((ring, k) => [k, ring] as const))) {
    // Inward is to the left of an outline wound one way, of a hole the other.
    const turn = (area(ring) > 0) === (k === 0) ? 1 : -1;
    const n = ring.length;
    const edge = (i: number) => [ring[i], ring[(i + 1) % n]] as const;
    // Along an edge short of the cut, not one past it (none shorter: a
    // piece of edge just short of the seam is wall too).
    const kept = ring.map((_, i) => !cuts.some(({ past, reach }) => Math.min(...edge(i).map(([x, y]) => past([-x, -y]))) > reach / 2));
    // Each edge's outward way, a unit long; at a corner, the two edges'
    // between them, as far out as keeps each a kerb's width off.
    const outward = (i: number): Pt => {
      const [a, b] = edge(i);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [((b[1] - a[1]) / len) * turn, (-(b[0] - a[0]) / len) * turn];
    };
    const off = (by: number) => ring.map((p, i): Pt => {
      const [u, v] = [outward((i + n - 1) % n), outward(i)];
      const [before, after] = [kept[(i + n - 1) % n], kept[i]];
      const [mx, my] = before && after ? [u[0] + v[0], u[1] + v[1]] : before ? u : v;
      const dot = (mx * v[0] + my * v[1]) / (Math.hypot(mx, my) || 1);
      const w = by / Math.max(dot, 0.5) / (Math.hypot(mx, my) || 1);
      return [p[0] + mx * w, p[1] + my * w];
    });
    // Out past the edge, and in over the road's crumbled edge as far as
    // the ground's pavement reaches over it (`CUT`).
    const [out, inn] = [off(WALL_OUT), off(-CUT)];
    for (let i = 0; i < n; i++) {
      if (!kept[i]) continue;
      const [a, b] = [inn[i], inn[(i + 1) % n]];
      const [ao, bo] = [out[i], out[(i + 1) % n]];
      const [ha, hb] = [wall(ring[i]), wall(ring[(i + 1) % n])];
      // The side, from under the deck up to the wall's top, facing out;
      // its top, lighter; its face to the road.
      quad(g, top(bo, -DECK), top(ao, -DECK), top(ao, ha), top(bo, hb));
      quad(tops, top(b, hb), top(a, ha), top(ao, ha), top(bo, hb));
      quad(g, top(b, hb), top(a, ha), top(a), top(b));
      // Its end on the ground, at a slope's foot, round.
      for (const [end, from, at] of [[!kept[(i + 1) % n], ring[i], (i + 1) % n], [!kept[(i + n - 1) % n], ring[(i + 1) % n], i]] as const) {
        if (end && rise(ring[at]) < 0.005) cap(g, tops, top, inn[at], out[at], from, ring[at], wall(ring[at]));
      }
    }
  }
  // The underside, a deck's thickness down, as the road above it lies.
  const under = flatPolygons(polys, 0);
  const b0 = g.positions.length / 3;
  for (let i = 0; i < under.positions.length; i += 3) {
    const [x, y] = [under.positions[i], under.positions[i + 1]];
    g.positions.push(ox + x, oy + y, liftAt(lift, x, y) - DECK);
    g.normals.push(0, 0, 1);
  }
  for (const i of under.indices) g.indices.push(b0 + i);
  // A pier under a level's node, from the ground up.
  if ((surface.height ?? 0) >= 2 && !((surface.height ?? 0) % 2)) {
    const at: Pt = [0.5 + (surface.shift?.[0] ?? 0), 0.5 + (surface.shift?.[1] ?? 0)];
    const [x, y, z] = top(at, -DECK);
    const r = PIER / 2;
    const c: [number, number][] = [[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]];
    for (let k = 0; k < 4; k++) {
      const [p, q] = [c[k], c[(k + 1) % 4]];
      quad(g, [p[0], p[1], 0], [q[0], q[1], 0], [q[0], q[1], z], [p[0], p[1], z]);
    }
  }
}
