import type { EngineContext, Mesh, SceneContext } from "@babylonjs/lite";
import { drop, meshOf, show, type MeshGeometry } from "./geometry";
import { setTint, townMaterial } from "./material";
import { rgb, type Rgb } from "./rgb";
import { ROAD_Z } from "./objects/roadGeometry";
import { flatPolygons, KERB_Z, PAVED_Z } from "./town/draw";
import { runsOn, shapeOf, VERGE_KERB, type Surface } from "./town/surface";
import { area, type Pt } from "./town/footprint";
import type { Casters } from "./DayNightCycle";

/**
 * Roads above the ground (`server/src/world/decks.rs`). A deck's road is
 * a road tile like the ground's, drawn by the same hand (`roads.ts`), its
 * shape and paint its tile's, lifted to its height (`liftOf`); a slope's
 * up across its own tile, from the edge it comes in by at the level below
 * to the edge it goes out by at the level above, and slopes one after
 * another as one climb, eased (`heightAlong`). Under it, here: its
 * concrete, the road's own outline grown a kerb's width (`VERGE_KERB`)
 * round every edge that does not run on into the next tile's road, the
 * kerb paved and a step up, as round a junction out of town, the side
 * carried down a deck's thickness; the deck's underside, which casts its
 * shadow; and a pier under every node a level or more up.
 */

/** How high a half-level is: a level is a storey and a bit. */
export const HALF_LEVEL = 0.175;
/** The deck's thickness under its road. */
const DECK = 0.09;
/** A kerb's step up from the road, as the ground's pavement stands. */
const STEP_UP = KERB_Z - ROAD_Z - PAVED_Z;
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
  private material = townMaterial([], 0.95);
  private paving = townMaterial([], 0.95);

  constructor(
    private engine: EngineContext,
    private scene: SceneContext,
    private casters: Casters | undefined,
    private paved: () => Rgb,
  ) {
    setTint(this.material, CONCRETE);
  }

  /** The concrete under every deck tile drawn again, and its kerbs. */
  rebuild(pieces: Iterable<DeckPiece>) {
    const g: MeshGeometry = { positions: [], normals: [], indices: [] };
    const kerbs: MeshGeometry = { positions: [], normals: [], indices: [] };
    for (const { x, y, surface } of pieces) concrete(g, kerbs, surface, x + 1, y + 1);
    this.clear();
    setTint(this.paving, this.paved());
    for (const [name, geo, material] of [["deck_concrete", g, this.material], ["deck_kerbs", kerbs, this.paving]] as const) {
      if (!geo.indices.length) continue;
      const mesh = meshOf(this.engine, name, geo);
      mesh.material = material;
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

/** A deck tile's concrete, placed at (ox, oy): its road's outline in the
 *  tile's frame, as `roads.ts` draws it, grown a kerb's width where it
 *  does not run on, the kerb a step up (into `kerbs`), its side carried
 *  down to the underside; the underside; and a pier under its node, a
 *  level or more up. */
function concrete(g: MeshGeometry, kerbs: MeshGeometry, surface: Surface, ox: number, oy: number) {
  const lift = liftOf(surface);
  const past = runsOn(surface);
  // The road frame: the tile's turned half round, its middle at -0.5.
  const top = ([x, y]: Pt, dz = 0): V3 => [ox - x, oy - y, liftAt(lift, -x, -y) + dz];
  const polys = shapeOf(surface).map((poly) => poly.map(finer));
  for (const [k, ring] of polys.flatMap((poly) => poly.map((ring, k) => [k, ring] as const))) {
    // Inward is to the left of an outline wound one way, of a hole the other.
    const turn = (area(ring) > 0) === (k === 0) ? 1 : -1;
    const n = ring.length;
    const edge = (i: number) => [ring[i], ring[(i + 1) % n]] as const;
    const kept = ring.map((_, i) => !past(...(edge(i).map(([x, y]) => [-x, -y]) as [Pt, Pt])));
    // Each edge's outward way, a unit long; at a corner, the two edges'
    // between them, as far out as keeps each a kerb's width off.
    const outward = (i: number): Pt => {
      const [a, b] = edge(i);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [((b[1] - a[1]) / len) * turn, (-(b[0] - a[0]) / len) * turn];
    };
    const out = ring.map((p, i): Pt => {
      const [u, v] = [outward((i + n - 1) % n), outward(i)];
      const [before, after] = [kept[(i + n - 1) % n], kept[i]];
      const [mx, my] = before && after ? [u[0] + v[0], u[1] + v[1]] : before ? u : v;
      const dot = (mx * v[0] + my * v[1]) / (Math.hypot(mx, my) || 1);
      const w = VERGE_KERB / Math.max(dot, 0.5) / (Math.hypot(mx, my) || 1);
      return [p[0] + mx * w, p[1] + my * w];
    });
    for (let i = 0; i < n; i++) {
      if (!kept[i]) continue;
      const [a, b] = edge(i);
      const [ao, bo] = [out[i], out[(i + 1) % n]];
      // The side, from under the deck up to the kerb's top, facing out;
      // the kerb's top; its face to the road.
      quad(g, top(bo, -DECK), top(ao, -DECK), top(ao, STEP_UP), top(bo, STEP_UP));
      quad(kerbs, top(bo, STEP_UP), top(ao, STEP_UP), top(a, STEP_UP), top(b, STEP_UP));
      quad(g, top(b, STEP_UP), top(a, STEP_UP), top(a), top(b));
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
    const [x, y, z] = top([0.5 + (surface.shift?.[0] ?? 0), 0.5 + (surface.shift?.[1] ?? 0)], -DECK);
    const r = PIER / 2;
    const c: [number, number][] = [[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]];
    for (let k = 0; k < 4; k++) {
      const [p, q] = [c[k], c[(k + 1) % 4]];
      quad(g, [p[0], p[1], 0], [q[0], q[1], 0], [q[0], q[1], z], [p[0], p[1], z]);
    }
  }
}
