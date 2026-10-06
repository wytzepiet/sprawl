import { Color3, Mesh, TransformNode, VertexData, type Scene, type ShadowGenerator, type StandardMaterial } from "@babylonjs/core";
import { perfCount } from "./PerfReport";
import { Tints, TintPlugin } from "./tints";
import * as Comlink from "comlink";
import { CHUNK, MARGIN, type Bounds, type ChunkDrawing, type Snapshot } from "./town/layer";
import type { TownApi } from "./townWorker";
import type { InstancePool } from "./InstancePool";
import type { Theme } from "./theme";
import type { Look } from "./objects/look";
import { BLUEPRINTS } from "../blueprints";
import { PAVED_Z } from "./town/draw";
import type { MeshGeometry } from "./Mesh";
import { bevelled, giveBevel, lacquer } from "./bevel";
import { waysAt } from "./town/dressing";
import { storeysOf, type Town } from "./town/grid";
import type { Box } from "./town/clip";
import { kerbed, kerbField } from "./kerbs";
import { RoadTiles } from "./roads";
import { grove, plant, uproot, type Grove } from "./trees";
import type { RGB } from "./town/mass";
import type { Building, BuildingKind, GameObjectEntry, RoadNode, TerrainType } from "../generated";

/** Ground round what is built the town is drawn over: its pavement and
 *  its trees. */
const TOWN_MARGIN = 4;
/** A drawing slower than this is said so in the console, in development. */
const SLOW_MS = 50;
/** The ground as the town worker is told it, by index. */
const KINDS: TerrainType[] = ["Water", "Sea", "Beach", "Grass", "Forest", "Mountain"];

/**
 * The town as the town grid draws it (`engine/town/`), from the live world.
 * A road is drawn a tile at a time, each tile a square with the shape its
 * arms make drawn on it (`roads.ts`), and redrawn when something round it
 * changes. The town round
 * what is built, its pavement, buildings and trees, is kept in
 * chunks: on the next frame after anything built changes, however many
 * changes landed before it, the chunks near it are drawn again, together,
 * from a window of the town a little wider, and cut to their chunks, off
 * the main thread (`town/layer.ts`, `townWorker.ts`), one drawing at a
 * time; meshes are made of them as they land. Cars
 * moving are not a change. The grid runs in the fixture's frame, turned
 * half round onto the map, as the sandbox draws a fixture. Kerbs are
 * rounded from each sheet's own kerb texture (`kerbs.ts`).
 */
export class TownLayer {
  /** Each chunk's meshes, by chunk, and the chunks to draw again. */
  private chunks = new Map<string, { root: TransformNode; meshes: Mesh[]; trees: Grove }>();
  private stale = new Set<string>();
  /** The road tiles, and the tiles to draw again. */
  private roads: RoadTiles;
  private dirty = new Set<string>();
  private frame: number | null = null;
  private tints: Tints;
  /** The town is drawn off the main thread, one drawing at a time. */
  private worker = new Worker(new URL("./townWorker.ts", import.meta.url), { type: "module" });
  private builder = Comlink.wrap<TownApi>(this.worker);
  private drawing = false;

  constructor(
    private scene: Scene,
    private pool: InstancePool,
    private shadows: ShadowGenerator,
    private theme: () => Theme,
    private entities: (f: (e: GameObjectEntry) => void) => void,
    private ground: (x: number, y: number) => TerrainType | undefined,
    private look: (e: GameObjectEntry) => Look,
  ) {
    this.tints = new Tints(scene);
    this.roads = new RoadTiles(scene, (through) => {
      const colour = through ? this.theme().highway : this.theme().road;
      return this.pool.material(`town_road_${colour.toHexString()}`, colour);
    });
  }

  /** A building's slot of the tints, its colour as it looks now; none
   *  for one gone since its town was drawn. */
  private slotOf(id: number, byId: Map<number, GameObjectEntry>): number {
    const e = byId.get(id);
    return e ? this.tints.set(id, this.colourOf(e)) : 0;
  }

  /** A building's colour as it looks now. */
  private colourOf(e: GameObjectEntry): RGB {
    const c = this.look(e).tint(Color3.FromHexString(BLUEPRINTS[(e.object.data as Building).kind as BuildingKind].color));
    return [c.r, c.g, c.b];
  }

  /** A building that only changed how it looks: its colour, and nothing
   *  drawn again. */
  recolour(e: GameObjectEntry) {
    if (this.tints.has(e.id)) this.tints.set(e.id, this.colourOf(e));
  }

  /** Something built changed on this tile: the road there and round it
   *  is drawn again, and the town, on the next frame. */
  touch(x: number, y: number) {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.dirty.add(`${x + dx},${y + dy}`);
    for (let dy = -MARGIN; dy <= MARGIN; dy += MARGIN) for (let dx = -MARGIN; dx <= MARGIN; dx += MARGIN) this.stale.add(chunkOf(x + dx, y + dy));
    this.settle();
  }

  /** Everything drawn again: the theme changed. */
  repaint() {
    for (const key of this.roads.tiles()) this.dirty.add(key);
    for (const key of this.chunks.keys()) this.stale.add(key);
    this.settle();
  }

  private settle() {
    this.frame ??= requestAnimationFrame(() => {
      this.frame = null;
      this.draw();
      this.retile();
    });
  }

  private draw() {
    // One drawing at a time: what goes stale meanwhile is drawn when it lands.
    if (this.drawing) return;
    const started = performance.now();
    const buildings: Snapshot["buildings"] = [];
    const roads: Snapshot["roads"] = [];
    const joined: Snapshot["joined"] = [];
    const doors: Snapshot["doors"] = [];
    const byId = new Map<number, GameObjectEntry>();
    // The bounds of the buildings.
    const built: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
    this.entities((e) => {
      if (e.object.kind === "RoadNode" && e.position) {
        const n = e.object.data as RoadNode;
        roads.push([e.position.x, e.position.y, e.id, n.road, n.outgoing, n.incoming]);
      } else if (e.object.kind === "Building" && e.object.data.kind !== "Edge") {
        const b = e.object.data as Building;
        byId.set(e.id, e);
        joined.push([e.id, b.joined.map((t) => [t.x, t.y])]);
        if (b.door) doors.push([b.door.tile.x, b.door.tile.y, b.door.street.x - b.door.tile.x, b.door.street.y - b.door.tile.y]);
        for (const t of b.tiles) {
          buildings.push([t.x, t.y, e.id, b.kind]);
          grow(built, t.x, t.y);
        }
      }
    });

    // The town, paved and dressed, only round what is built: a road
    // across open country is asphalt, and the town is what is paved. The
    // chunks it covers; those it no longer does go, those it newly does are
    // drawn.
    const box = built[0] <= built[2] ? widen(built, TOWN_MARGIN) : null;
    const covered = new Set<string>();
    if (box) for (let cy = Math.floor(box[1] / CHUNK); cy <= Math.floor(box[3] / CHUNK); cy++) for (let cx = Math.floor(box[0] / CHUNK); cx <= Math.floor(box[2] / CHUNK); cx++) covered.add(`${cx},${cy}`);
    for (const key of [...this.chunks.keys()]) if (!covered.has(key)) this.drop(key);
    for (const key of covered) if (!this.chunks.has(key)) this.stale.add(key);
    const todo = [...this.stale].filter((key) => covered.has(key));
    this.stale.clear();
    if (!box || !todo.length) return;

    // The ground under the box, as the worker cannot ask the terrain.
    const [x0, y0, x1, y1] = box;
    const ground = new Uint8Array((x1 - x0 + 1) * (y1 - y0 + 1)).fill(255);
    for (let y = y0, k = 0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++, k++) {
        const g = this.ground(x, y);
        if (g !== undefined) ground[k] = KINDS.indexOf(g);
      }
    }
    const snapshot: Snapshot = { box, todo, buildings, roads, joined, doors, ground, kinds: KINDS, theme: this.theme() };
    const gathered = performance.now() - started;
    this.drawing = true;
    this.builder
      .draw(snapshot)
      .then(
        ({ chunks, window }) => {
          const shown = performance.now();
          for (const c of chunks) {
            this.drop(c.key);
            this.show(c, window, byId);
          }
          perfCount("town.mainMs", gathered + performance.now() - shown);
        },
        (e) => {
          // Never dropped: drawn again, and said so.
          console.error("[town] drawing failed, drawing again", e);
          perfCount("town.failures");
          for (const key of todo) this.stale.add(key);
        },
      )
      .finally(() => {
        this.drawing = false;
        const took = performance.now() - started;
        perfCount("town.draws");
        perfCount("town.drawMs", took);
        if (import.meta.env.DEV && took > SLOW_MS) console.warn(`[town] ${todo.length} chunks drawn in ${took.toFixed(0)} ms, off the main thread`);
        if (this.stale.size) this.settle();
      });
  }

  /** The road on each tile that changed, the shape its arms make:
   *  the world as a town in the fixture's frame round the map's origin,
   *  asked about those tiles alone. */
  private retile() {
    const world = this.world();
    for (const key of this.dirty) {
      const [x, y] = key.split(",").map(Number);
      const at = waysAt(world, -x, -y);
      if (at) this.roads.set(key, x, y, at.through, at.ways);
      else this.roads.delete(key);
    }
    this.dirty.clear();
    this.roads.flush();
  }

  /** The whole world as a town, unbounded, in the fixture's frame turned
   *  about the map's origin: column -x, row -y. */
  private world(): Town {
    const nodes = new Map<string, RoadNode & { id: number }>();
    const kinds = new Map<string, BuildingKind>();
    const doors = doorsOf(this.entities);
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
      door: (c, r) => turned(doors.get(key(c, r))),
    };
  }

  /** A chunk's pieces, drawn in the frame of the window they were drawn
   *  in, placed on the map: its paving a square over the chunk, cut to
   *  the paving, rounded at its kerbs and its yards' lines painted on by a
   *  texture, its texels worked out with the drawing; and its trees. */
  private show({ key, pieces, trees, cut, paving }: ChunkDrawing, [, , x1, y1]: Bounds, byId: Map<number, GameObjectEntry>) {
    const root = new TransformNode(`town_${key}`, this.scene);
    root.position.set(x1 + 1, y1 + 1, 0);
    const meshes: Mesh[] = [];
    for (const p of pieces) {
      // The masses carry each surface's building: its slot, its colour set.
      if (p.name === "mass" && p.geo.colors) for (let k = 2; k < p.geo.colors.length; k += 4) p.geo.colors[k] = this.slotOf(p.geo.colors[k], byId);
      const mesh = new Mesh(`town_${p.name}_${key}`, this.scene);
      const paved = p.name === "pavement";
      const geo = bevelled(paved ? square(cut, PAVED_Z) : p.geo);
      const vd = new VertexData();
      Object.assign(vd, { positions: geo.positions, indices: geo.indices, normals: geo.normals, colors: geo.colors ?? null });
      vd.applyToMesh(mesh);
      giveBevel(mesh, geo);
      mesh.material = bevelOn(this.pool.material(paved ? `town_pavement_${key}` : `town_${p.name}`, p.colour ? new Color3(p.colour.r, p.colour.g, p.colour.b) : Color3.White()), p.name);
      if (p.name === "mass" && !mesh.material.pluginManager?.getPlugin("Tint")) new TintPlugin(mesh.material, this.tints);
      if (paved && paving) kerbed(mesh.material, kerbField(this.scene, paving), this.theme().road);
      mesh.parent = root;
      mesh.isPickable = false;
      mesh.receiveShadows = true;
      if (p.name === "mass") this.shadows.addShadowCaster(mesh);
      meshes.push(mesh);
    }
    const { matrices, colors } = trees;
    const g = grove(this.scene, `town_${key}`, this.shadows);
    g.bodies.parent = g.tops.parent = root;
    if (!plant(g, matrices, colors)) g.bodies.setEnabled(false), g.tops.setEnabled(false);
    this.chunks.set(key, { root, meshes, trees: g });
  }

  /** A chunk's meshes gone. */
  private drop(key: string) {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    for (const m of chunk.meshes) {
      this.shadows.removeShadowCaster(m);
      m.dispose();
    }
    uproot(chunk.trees, this.shadows);
    chunk.root.dispose();
    this.chunks.delete(key);
  }

  dispose() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    for (const key of [...this.chunks.keys()]) this.drop(key);
    this.roads.dispose();
    this.tints.dispose();
    this.worker.terminate();
  }
}

/** Every building's door, by its tile: the way on the map to its street. */
function doorsOf(each: (f: (e: GameObjectEntry) => void) => void): Map<string, [number, number]> {
  const doors = new Map<string, [number, number]>();
  each((e) => {
    const door = e.object.kind === "Building" ? (e.object.data as Building).door : null;
    if (door) doors.set(`${door.tile.x},${door.tile.y}`, [door.street.x - door.tile.x, door.street.y - door.tile.y]);
  });
  return doors;
}

/** A way on the map as the town grid's frame has it, turned half round. */
const turned = (d: [number, number] | undefined): [number, number] | undefined => d && [-d[0], -d[1]];

/** The chunk a tile is on. */
const chunkOf = (x: number, y: number) => `${Math.floor(x / CHUNK)},${Math.floor(y / CHUNK)}`;

const grow = (b: Bounds, x: number, y: number) => {
  [b[0], b[1], b[2], b[3]] = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)];
};
const widen = ([x0, y0, x1, y1]: Bounds, by: number): Bounds => [x0 - by, y0 - by, x1 + by, y1 + by];

/** A square over a box, facing up, at a height. */
const square = ([x0, y0, x1, y1]: Box, z: number): MeshGeometry => ({
  positions: [x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  indices: [0, 2, 1, 0, 3, 2],
});

/** A town material lacquered as what it draws is: buildings;
 *  paving and roads stay matte. Its creases are rounded already, as
 *  every pool material's are. */
function bevelOn(mat: StandardMaterial, name: string): StandardMaterial {
  if (name === "mass") return lacquer(mat, "building");
  return mat;
}
