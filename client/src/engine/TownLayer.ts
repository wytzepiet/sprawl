import { Color3, Mesh, TransformNode, VertexData, type Scene, type ShadowGenerator } from "@babylonjs/core";
import type { InstancePool } from "./InstancePool";
import type { Theme } from "./theme";
import type { Look } from "./objects/look";
import { BLUEPRINTS } from "../blueprints";
import { drawTown, flatPolygons, PAVED_Z, type Piece } from "./town/draw";
import { roadShape, waysAt } from "./town/dressing";
import { ROAD_Z } from "./objects/roadGeometry";
import { storeysOf, type Tile, type Town } from "./town/grid";
import type { RGB } from "./town/mass";
import type { Building, BuildingKind, GameObjectEntry, RoadNode, TerrainType } from "../generated";

/** How long the town waits after a change before it is drawn again: a
 *  drag's steps land one after another, and are drawn once. */
const SETTLE_MS = 120;
/** Ground round what is built the town is drawn over: its pavement, its
 *  lawns and its trees. */
const TOWN_MARGIN = 4;
/** A drawing slower than this is said so in the console, in development:
 *  the town is drawn whole, and this is the first sign it has outgrown
 *  that. */
const SLOW_MS = 50;

/**
 * The town as the town grid draws it (`engine/town/`), from the live world.
 * A road is drawn a tile at a time, each tile an instance of the shape its
 * arms make, and redrawn when something round it changes. The town round
 * what is built, its pavement, buildings, lawns and trees, is made into a
 * `Town` and drawn whole a moment after anything built changes. Cars
 * moving are not a change. The grid runs in the fixture's frame, turned
 * half round onto the map, as the sandbox draws a fixture.
 */
export class TownLayer {
  private roots: TransformNode[] = [];
  private meshes: Mesh[] = [];
  /** Each road tile's instance, by tile, and the tiles to draw again. */
  private roads = new Map<string, { key: string; id: number }>();
  private dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private scene: Scene,
    private pool: InstancePool,
    private shadows: ShadowGenerator,
    private theme: () => Theme,
    private entities: (f: (e: GameObjectEntry) => void) => void,
    private ground: (x: number, y: number) => TerrainType | undefined,
    private look: (e: GameObjectEntry) => Look,
  ) {}

  /** Something built changed on this tile: the road there and round it
   *  is drawn again, and the town once it settles. */
  touch(x: number, y: number) {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.dirty.add(`${x + dx},${y + dy}`);
    this.settle();
  }

  /** Every road drawn again: the theme changed. */
  repaint() {
    for (const key of this.roads.keys()) this.dirty.add(key);
    this.settle();
  }

  private settle() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.draw();
      this.retile();
    }, SETTLE_MS);
  }

  private draw() {
    const started = performance.now();
    const buildings = new Map<string, { entry: GameObjectEntry; kind: BuildingKind }>();
    const roads = new Map<string, { entry: GameObjectEntry; node: RoadNode }>();
    const byId = new Map<number, GameObjectEntry>();
    // The bounds of the buildings.
    const built: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
    this.entities((e) => {
      if (e.object.kind === "RoadNode" && e.position) {
        roads.set(`${e.position.x},${e.position.y}`, { entry: e, node: e.object.data });
      } else if (e.object.kind === "Building" && e.object.data.kind !== "Edge") {
        const b = e.object.data as Building;
        byId.set(e.id, e);
        for (const t of b.tiles) {
          buildings.set(`${t.x},${t.y}`, { entry: e, kind: b.kind });
          grow(built, t.x, t.y);
        }
      }
    });
    this.clear();

    const OPEN: Tile = { kind: "open", storeys: 0 };
    const ROAD: Tile = { kind: "road", storeys: 0 };
    const WATER: Tile = { kind: "water", storeys: 0 };
    const WOOD: Tile = { kind: "wood", storeys: 0 };
    const tiles = new Map<string, Tile>();
    for (const [key, { entry, kind }] of buildings) tiles.set(key, { kind, storeys: storeysOf(kind), id: entry.id });
    for (const key of roads.keys()) if (!tiles.has(key)) tiles.set(key, ROAD);
    /** The world within these bounds as a town, in the fixture's frame:
     *  column c, row r, the map turned half round from its far corner. */
    const townOver = ([x0, y0, x1, y1]: Bounds): Town => {
      // Filled once: the town grid asks after a tile many times over.
      const [w, h] = [x1 - x0 + 1, y1 - y0 + 1];
      const grid: Tile[] = new Array(w * h);
      const nodes: ({ entry: GameObjectEntry; node: RoadNode } | undefined)[] = new Array(w * h);
      for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
          const key = `${x1 - c},${y1 - r}`;
          const t = tiles.get(key);
          const g = t ? undefined : this.ground(x1 - c, y1 - r);
          grid[r * w + c] = t ?? (g === "Water" || g === "Sea" ? WATER : g === "Forest" ? WOOD : OPEN);
          // A road tile's node; none under a building, where a drive ends.
          if (t === ROAD) nodes[r * w + c] = roads.get(key);
        }
      }
      const inside = (c: number, r: number) => c >= 0 && r >= 0 && c < w && r < h;
      const tile = (c: number, r: number): Tile => (inside(c, r) ? grid[r * w + c] : OPEN);
      const road = (c: number, r: number) => (inside(c, r) ? nodes[r * w + c] : undefined);
      const town: Town = {
        w,
        h,
        tile,
        linked: (c0, r0, c1, r1) => {
          const [a, b] = [road(c0, r0), road(c1, r1)];
          return !!a && !!b && (a.node.outgoing.includes(b.entry.id) || a.node.incoming.includes(b.entry.id));
        },
        through: (c, r) => !!road(c, r)?.node.road,
        // A building is joined in itself, and to the row the hand drew it
        // in (`Building::joined`); tiles painted apart stand apart.
        joins: (c0, r0, c1, r1) => {
          const [a, b] = [tile(c0, r0).id, tile(c1, r1).id];
          if (a === undefined || b === undefined) return false;
          const [x, y] = [x1 - c1, y1 - r1];
          return a === b || !!(byId.get(a)?.object.data as Building | undefined)?.joined.some((t) => t.x === x && t.y === y);
        },
      };
      return town;
    };

    const looks = new Map<number, Look>();
    const colour = (t: Tile): RGB => {
      const base = Color3.FromHexString(BLUEPRINTS[t.kind as BuildingKind].color);
      if (t.id === undefined) return [base.r, base.g, base.b];
      const e = byId.get(t.id);
      let look = looks.get(t.id);
      if (!look && e) looks.set(t.id, (look = this.look(e)));
      const c = look ? look.tint(base) : base;
      return [c.r, c.g, c.b];
    };

    // The town, paved and dressed, only round what is built: a road
    // across open country is asphalt, and the town is what is paved.
    const sizes: string[] = [];
    if (built[0] <= built[2]) {
      const bounds = widen(built, TOWN_MARGIN);
      const town = townOver(bounds);
      this.show(drawTown(town, this.theme(), colour).pieces, bounds);
      sizes.push(`${town.w}x${town.h}`);
    }
    const took = performance.now() - started;
    if (import.meta.env.DEV && took > SLOW_MS) console.warn(`[town] drawn in ${took.toFixed(0)} ms over ${sizes.join(" and ")} tiles`);
  }

  /** The road on each tile that changed, an instance of its arms' shape:
   *  the world as a town in the fixture's frame round the map's origin,
   *  asked about those tiles alone. */
  private retile() {
    const world = this.world();
    const theme = this.theme();
    for (const key of this.dirty) {
      const [x, y] = key.split(",").map(Number);
      const was = this.roads.get(key);
      if (was) this.pool.removeInstance(was.key, was.id);
      this.roads.delete(key);
      const at = waysAt(world, -x, -y);
      if (!at) continue;
      const colour = at.through ? theme.highway : theme.road;
      const shape = `road_${colour.toHexString()}_${at.ways.map(([dc, dr, on]) => `${dc}${dr}${on ? "+" : ""}`).sort().join(",")}`;
      // Through roads over the streets that meet them: a street's end runs
      // on under one.
      this.pool.ensureBucket(shape, flatPolygons(roadShape(at.ways), ROAD_Z + PAVED_Z + (at.through ? 0.001 : 0)), colour, false, true);
      this.roads.set(key, { key: shape, id: this.pool.addInstance(shape, [x + 1, y + 1, 0]) });
    }
    this.dirty.clear();
  }

  /** The whole world as a town, unbounded, in the fixture's frame turned
   *  about the map's origin: column -x, row -y. */
  private world(): Town {
    const nodes = new Map<string, RoadNode & { id: number }>();
    const kinds = new Map<string, BuildingKind>();
    this.entities((e) => {
      if (e.object.kind === "RoadNode" && e.position) nodes.set(`${e.position.x},${e.position.y}`, { ...e.object.data, id: e.id });
      else if (e.object.kind === "Building") for (const t of (e.object.data as Building).tiles) kinds.set(`${t.x},${t.y}`, e.object.data.kind);
    });
    const key = (c: number, r: number) => `${-c},${-r}`;
    const road = (c: number, r: number) => (kinds.has(key(c, r)) ? undefined : nodes.get(key(c, r)));
    return {
      w: Infinity,
      h: Infinity,
      tile: (c, r) => {
        const kind = kinds.get(key(c, r));
        return kind ? { kind, storeys: storeysOf(kind) } : road(c, r) ? { kind: "road", storeys: 0 } : { kind: "open", storeys: 0 };
      },
      linked: (c0, r0, c1, r1) => {
        const [a, b] = [road(c0, r0), road(c1, r1)];
        return !!a && !!b && (a.outgoing.includes(b.id) || a.incoming.includes(b.id));
      },
      through: (c, r) => !!road(c, r)?.road,
    };
  }

  /** Pieces drawn in the frame of these bounds, placed on the map. */
  private show(pieces: Piece[], [, , x1, y1]: Bounds) {
    const root = new TransformNode("town", this.scene);
    root.position.set(x1 + 1, y1 + 1, 0);
    this.roots.push(root);
    for (const p of pieces) {
      const mesh = new Mesh(`town_${p.name}`, this.scene);
      const vd = new VertexData();
      Object.assign(vd, { positions: p.geo.positions, indices: p.geo.indices, normals: p.geo.normals, colors: p.geo.colors ?? null });
      vd.applyToMesh(mesh);
      mesh.material = this.pool.material(`town_${p.name}`, p.colour ?? Color3.White());
      mesh.parent = root;
      mesh.isPickable = false;
      // A tree's body casts its shadow and its top takes the others'.
      mesh.receiveShadows = p.name !== "tree_bodies";
      if (p.name === "mass" || p.name === "tree_bodies") this.shadows.addShadowCaster(mesh);
      this.meshes.push(mesh);
    }
  }

  private clear() {
    for (const m of this.meshes) {
      this.shadows.removeShadowCaster(m);
      m.dispose();
    }
    for (const r of this.roots) r.dispose();
    this.meshes = [];
    this.roots = [];
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.clear();
    for (const { key, id } of this.roads.values()) this.pool.removeInstance(key, id);
    this.roads.clear();
  }
}

/** A box of tiles: x0, y0, x1, y1. */
type Bounds = [number, number, number, number];

function grow(b: Bounds, x: number, y: number) {
  [b[0], b[1], b[2], b[3]] = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)];
}

const widen = ([x0, y0, x1, y1]: Bounds, by: number): Bounds => [x0 - by, y0 - by, x1 + by, y1 + by];
