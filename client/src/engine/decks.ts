import { markMeshRenderableDirty, type EngineContext, type Mesh, type SceneContext } from "@babylonjs/lite";
import { drop, meshOf, show, type MeshGeometry } from "./geometry";
import { setTint, townMaterial, type TownMaterial } from "./material";
import { rgb } from "./rgb";
import { buildRoadGeometry, HALF_W, ROAD_Z, type ArmInfo } from "./objects/roadGeometry";
import { PAVED_Z } from "./town/draw";
import type { Casters } from "./DayNightCycle";
import type { GameObjectEntry, RoadNode } from "../generated";
import { spot } from "./may";

/**
 * Roads above the ground (`server/src/world/decks.rs`): each link with an
 * end in the air a ribbon of asphalt from node to node at their heights,
 * its concrete sides hanging under it and a parapet along each; a
 * junction or a bend on a deck its road's own shape (`buildRoadGeometry`)
 * laid over the ribbons; a pier under every node a level or more up. A
 * slope is nothing of its own: the ribbons either side of it climb through
 * it, as the cars do.
 *
 * Drawn a mesh a level, so the levels above where the hand is can be seen
 * through, as glass, to what is under them.
 */

/** How high a half-level is: a level is a storey and a bit. */
export const HALF_LEVEL = 0.175;
/** The deck's thickness under its road, and the parapet's height and width. */
const DECK = 0.09;
const PARAPET: [number, number] = [0.045, 0.03];
/** A pier's side. */
const PIER = 0.14;
const ASPHALT = rgb(0.21, 0.2, 0.22);
const CONCRETE = rgb(0.74, 0.73, 0.7);

/** How high a road's surface stands at a height, in half-levels. */
export const deckZ = (height: number) => ROAD_Z + PAVED_Z + height * HALF_LEVEL;

/** How much of a level above the hand shows: a ghost of it. */
const GHOST = 0.28;

interface Level {
  /** Its top's and its sides' materials, solid and seen through. */
  solid: TownMaterial[];
  ghost: TownMaterial[];
  meshes: Mesh[];
  seen: boolean;
}

export class Decks {
  private levels: Level[] = [];

  constructor(
    private engine: EngineContext,
    private scene: SceneContext,
    private casters: Casters | undefined,
  ) {}

  /** Every deck drawn again from the road nodes. */
  rebuild(each: (f: (e: GameObjectEntry) => void) => void) {
    const nodes = new Map<number, { x: number; y: number; n: RoadNode }>();
    each((e) => {
      if (e.object.kind !== "RoadNode" || !e.position) return;
      const [x, y] = spot(e.position, e.object.data.side);
      nodes.set(e.id, { x, y, n: e.object.data });
    });
    // By the level each piece belongs to: a link's, its higher end's.
    const geos = [0, 1, 2, 3].map(() => ({ top: empty(), side: empty() }));
    const levelOf = (h: number) => Math.ceil(h / 2);
    const seen = new Set<string>();
    for (const [id, a] of nodes) {
      const arms = [...new Set([...a.n.outgoing, ...a.n.incoming])].filter((o) => nodes.has(o));
      for (const o of arms) {
        const b = nodes.get(o)!;
        if (!a.n.height && !b.n.height) continue;
        const k = id < o ? `${id},${o}` : `${o},${id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const g = geos[levelOf(Math.max(a.n.height, b.n.height))];
        ribbon(g.top, g.side, [a.x, a.y, deckZ(a.n.height)], [b.x, b.y, deckZ(b.n.height)], widthOf(a.n, id, b.n, o));
      }
      if (!a.n.height) continue;
      const g = geos[levelOf(a.n.height)];
      // A junction's, a bend's or an end's shape over the ribbons; a slope
      // and a straight run need none.
      const ways = arms.map((o) => ({ angle: Math.atan2(nodes.get(o)!.y - a.y, nodes.get(o)!.x - a.x), hw: widthOf(a.n, id, nodes.get(o)!.n, o) }));
      const straight = ways.length === 2 && Math.abs(Math.abs(ways[0].angle - ways[1].angle) - Math.PI) < 1e-6;
      if (a.n.height % 2 === 0 && !straight) cap(g.top, g.side, ways, [a.x, a.y, deckZ(a.n.height)]);
      if (a.n.height >= 2) pier(g.side, [a.x, a.y], deckZ(a.n.height) - DECK);
    }
    this.clear();
    const made = (ghost: boolean) =>
      ([[ASPHALT, 0.75], [CONCRETE, 0.95]] as const).map(([colour, rough]) => {
        const m = townMaterial([], rough);
        setTint(m, colour);
        if (ghost) Object.assign(m, { alpha: GHOST, alphaBlend: true });
        return m;
      });
    this.levels = geos.map((g, level) => {
      const [solid, ghost] = [made(false), made(true)];
      const meshes = ([g.top, g.side] as MeshGeometry[]).flatMap((geo, i) => {
        if (!geo.indices.length) return [];
        const mesh = meshOf(this.engine, `deck_${level}_${i}`, geo);
        mesh.material = solid[i];
        mesh.receiveShadows = true;
        show(this.scene, mesh);
        this.casters?.add(mesh);
        return [mesh];
      });
      return { solid, ghost, meshes, seen: false };
    });
  }

  /** The hand is at this level: those above it are seen through, and
   *  cast no shadow. */
  seeThroughAbove(level: number) {
    this.levels.forEach((l, i) => {
      const seen = i > level;
      if (l.seen === seen) return;
      l.seen = seen;
      for (const mesh of l.meshes) {
        const kind = mesh.name.endsWith("_0") ? 0 : 1;
        mesh.material = (seen ? l.ghost : l.solid)[kind];
        if (seen) this.casters?.remove(mesh);
        else this.casters?.add(mesh);
        markMeshRenderableDirty(mesh);
      }
    });
  }

  private clear() {
    for (const l of this.levels) for (const m of l.meshes) (this.casters?.remove(m), drop(this.scene, m));
    this.levels = [];
  }

  dispose() {
    this.clear();
  }
}

const empty = (): MeshGeometry => ({ positions: [], normals: [], indices: [] });

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

/** How wide a link's deck is either side of its middle: a one-way's of
 *  one lane thin, as on the ground (`surface.ts`). */
const THIN = 0.13;
function widthOf(a: RoadNode, aId: number, b: RoadNode, bId: number): number {
  const [out, back] = [a.outgoing.includes(bId), b.outgoing.includes(aId)];
  return out !== back && !a.wide.includes(bId) && !b.wide.includes(aId) ? THIN : HALF_W;
}

/** A link's deck from one node's middle to the other's: its road on top,
 *  its sides hanging under it, and a parapet along each edge. */
function ribbon(top: MeshGeometry, side: MeshGeometry, a: V3, b: V3, hw: number) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const [nx, ny] = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
  const at = (p: V3, s: number, dz = 0): V3 => [p[0] + nx * hw * s, p[1] + ny * hw * s, p[2] + dz];
  quad(top, at(a, -1), at(b, -1), at(b, 1), at(a, 1));
  for (const s of [1, -1]) {
    // The side: from the road's edge down the deck's thickness, facing out.
    const [p, q] = s > 0 ? [a, b] : [b, a];
    quad(side, at(p, s), at(q, s), at(q, s, -DECK), at(p, s, -DECK));
    // The parapet: a low wall on the edge.
    const inner = (pt: V3, dz: number): V3 => [pt[0] + nx * (hw - PARAPET[1]) * s, pt[1] + ny * (hw - PARAPET[1]) * s, pt[2] + dz];
    quad(side, at(q, s, PARAPET[0]), at(p, s, PARAPET[0]), inner(p, PARAPET[0]), inner(q, PARAPET[0]));
    quad(side, at(q, s), at(p, s), at(p, s, PARAPET[0]), at(q, s, PARAPET[0]));
    quad(side, inner(p, 0), inner(q, 0), inner(q, PARAPET[0]), inner(p, PARAPET[0]));
  }
}

/** A deck node's road shape, as a ground junction's is, over the ribbons;
 *  its rim hanging down. */
function cap(top: MeshGeometry, side: MeshGeometry, ways: { angle: number; hw: number }[], [x, y, z]: V3) {
  const arms: ArmInfo[] = ways.map(({ angle: a, hw }) => ({ angle: a < 0 ? a + 2 * Math.PI : a, flow: "twoway", hw }));
  const geo = buildRoadGeometry(arms, HALF_W, 0);
  if (!geo) return;
  const i0 = top.positions.length / 3;
  for (let i = 0; i < geo.positions.length; i += 3) top.positions.push(x + geo.positions[i], y + geo.positions[i + 1], z + 0.002), top.normals.push(0, 0, 1);
  for (let i = 0; i < geo.indices.length; i += 3) top.indices.push(i0 + geo.indices[i], i0 + geo.indices[i + 1], i0 + geo.indices[i + 2]);
  void side;
}

/** A square pier from the ground up to the deck's underside. */
function pier(side: MeshGeometry, [x, y]: [number, number], z: number) {
  const r = PIER / 2;
  const c: [number, number][] = [[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]];
  for (let k = 0; k < 4; k++) {
    const [p, q] = [c[k], c[(k + 1) % 4]];
    quad(side, [p[0], p[1], 0], [q[0], q[1], 0], [q[0], q[1], z], [p[0], p[1], z]);
  }
}
