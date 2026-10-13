import type { EngineContext, Mesh, SceneContext } from "@babylonjs/lite";
import { drop, meshOf, show, type MeshGeometry } from "./geometry";
import { setTint, townMaterial } from "./material";
import { rgb } from "./rgb";
import { ROAD_Z } from "./objects/roadGeometry";
import { flatPolygons, PAVED_Z } from "./town/draw";
import { runsOn, shapeOf, type Surface } from "./town/surface";
import { area, type Pt } from "./town/footprint";
import type { Casters } from "./DayNightCycle";

/**
 * Roads above the ground (`server/src/world/decks.rs`). A deck's road is
 * a road tile like the ground's, drawn by the same hand (`roads.ts`), its
 * shape and paint its tile's, lifted to its height (`liftOf`); a slope's
 * eased up across its own tile, from the edge it comes in by at the level
 * below to the edge it goes out by at the level above. Under it, here: its
 * concrete, the road's own outline carried down a deck's thickness and up
 * a parapet's, the parapet round every edge that does not run on into
 * the next tile's road; the deck's underside, which casts its shadow; and
 * a pier under every node a level or more up.
 */

/** How high a half-level is: a level is a storey and a bit. */
export const HALF_LEVEL = 0.175;
/** The deck's thickness under its road, and the parapet's height and width. */
const DECK = 0.09;
const PARAPET: [number, number] = [0.045, 0.03];
/** A pier's side. */
const PIER = 0.14;
const CONCRETE = rgb(0.74, 0.73, 0.7);
/** How finely an edge is cut, so its concrete bends with an eased slope. */
const STEP = 0.06;

/** How high a road's surface stands at a height, in half-levels. */
export const deckZ = (height: number) => ROAD_Z + PAVED_Z + height * HALF_LEVEL;

const ease = (u: number) => u * u * (3 - 2 * u);

/** How high, in half-levels, a road stands a share `f` of the way from a
 *  node at `ha` to one at `hb`: a slope (an odd height) climbs, eased,
 *  across its own tile, from the level below at one edge to the level
 *  above at the other; the other's half of the link is level. */
export function rise(ha: number, hb: number, f: number): number {
  const slope = (h: number, toward: number, d: number) => h - 1 + 2 * ease(toward > h ? 0.5 + d : 0.5 - d);
  if (ha % 2) return f < 0.5 ? slope(ha, hb, f) : hb;
  if (hb % 2) return f < 0.5 ? ha : slope(hb, ha, 1 - f);
  return ha + (hb - ha) * f;
}

/** How a road tile at (x, y) is lifted: how high its low end stands above
 *  the ground's road, in tiles; the way it climbs, in the world's frame,
 *  scaled to a share of its run a tile; and how much it climbs. A level
 *  deck climbs none; a slope two half-levels, from the arm it climbs away
 *  from to the one it climbs to (`Surface::climb`). */
export type Lift = [number, number, number, number];
export function liftOf({ height = 0, climb }: Surface): Lift {
  if (!(height % 2) || !climb) return [height * HALF_LEVEL, 0, 0, 0];
  const len2 = climb[0] * climb[0] + climb[1] * climb[1];
  // The tile's frame is the world's turned half round.
  return [(height - 1) * HALF_LEVEL, -climb[0] / len2, -climb[1] / len2, 2 * HALF_LEVEL];
}

/** How high a lifted tile's road stands over a point of it, in its road
 *  frame (its middle at -0.5, -0.5): `roads.ts`'s shader, here. */
export function liftAt([z0, dx, dy, dz]: Lift, x: number, y: number): number {
  const u = Math.max(0, Math.min(1, (x + 0.5) * dx + (y + 0.5) * dy + 0.5));
  return ROAD_Z + PAVED_Z + z0 + dz * ease(u);
}

/** A deck's road tile, where it is. */
export interface DeckPiece {
  x: number;
  y: number;
  surface: Surface;
}

export class Decks {
  private mesh: Mesh | null = null;
  private material = townMaterial([], 0.95);

  constructor(
    private engine: EngineContext,
    private scene: SceneContext,
    private casters: Casters | undefined,
  ) {
    setTint(this.material, CONCRETE);
  }

  /** The concrete under every deck tile drawn again. */
  rebuild(pieces: Iterable<DeckPiece>) {
    const g: MeshGeometry = { positions: [], normals: [], indices: [] };
    for (const { x, y, surface } of pieces) concrete(g, surface, x + 1, y + 1);
    this.clear();
    if (!g.indices.length) return;
    this.mesh = meshOf(this.engine, "deck_concrete", g);
    this.mesh.material = this.material;
    this.mesh.receiveShadows = true;
    show(this.scene, this.mesh);
    this.casters?.add(this.mesh);
  }

  private clear() {
    if (this.mesh) (this.casters?.remove(this.mesh), drop(this.scene, this.mesh));
    this.mesh = null;
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
 *  tile's frame, as `roads.ts` draws it, carried down to the underside and
 *  up a parapet where it does not run on; the underside; and a pier under
 *  its node, a level or more up. */
function concrete(g: MeshGeometry, surface: Surface, ox: number, oy: number) {
  const lift = liftOf(surface);
  const past = runsOn(surface);
  // The road frame: the tile's turned half round, its middle at -0.5.
  const top = ([x, y]: Pt, dz = 0): V3 => [ox - x, oy - y, liftAt(lift, -x, -y) + dz];
  const polys = shapeOf(surface).map((poly) => poly.map(finer));
  for (const [k, ring] of polys.flatMap((poly) => poly.map((ring, k) => [k, ring] as const))) {
    // Inward is to the left of an outline wound one way, of a hole the other.
    const turn = (area(ring) > 0) === (k === 0) ? 1 : -1;
    for (let i = 0; i < ring.length; i++) {
      const [a, b] = [ring[i], ring[(i + 1) % ring.length]];
      if (past([-a[0], -a[1]], [-b[0], -b[1]])) continue;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const [nx, ny] = [(-(b[1] - a[1]) / len) * turn * PARAPET[1], ((b[0] - a[0]) / len) * turn * PARAPET[1]];
      const [ai, bi]: Pt[] = [[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny]];
      // The side, from under the deck up to the parapet's top, facing out;
      // the parapet's top; its face to the road.
      quad(g, top(b, -DECK), top(a, -DECK), top(a, PARAPET[0]), top(b, PARAPET[0]));
      quad(g, top(b, PARAPET[0]), top(a, PARAPET[0]), top(ai, PARAPET[0]), top(bi, PARAPET[0]));
      quad(g, top(bi, PARAPET[0]), top(ai, PARAPET[0]), top(ai), top(bi));
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
