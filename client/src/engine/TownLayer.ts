import { Color3, Mesh, TransformNode, VertexData, type Scene, type ShadowGenerator, type StandardMaterial } from "@babylonjs/core";
import { perfCount } from "./PerfReport";
import { Tints, TintPlugin } from "./tints";
import type { Paint } from "./town/roof";
import type { InstancePool } from "./InstancePool";
import type { Theme } from "./theme";
import type { Look } from "./objects/look";
import { BLUEPRINTS } from "../blueprints";
import { drawTown, PAVED_Z, treeInstances, type Piece } from "./town/draw";
import type { MeshGeometry } from "./Mesh";
import { bevelled, giveBevel, lacquer } from "./bevel";
import { waysAt } from "./town/dressing";
import { storeysOf, windowOf, type Tile, type Town } from "./town/grid";
import { facts, windowFacts } from "./town/facts";
import { clipTo, fileBy, type Box } from "./town/clip";
import { kerbed, kerbField, kerbsOf, stripLines, type Kerb, type Line } from "./kerbs";
import { RoadTiles } from "./roads";
import { grove, plant, uproot, type Grove } from "./trees";
import type { Dressing } from "./town/dressing";
import type { RGB } from "./town/mass";
import type { Building, BuildingKind, GameObjectEntry, RoadNode, TerrainType } from "../generated";

/** Ground round what is built the town is drawn over: its pavement and
 *  its trees. */
const TOWN_MARGIN = 4;
/** A drawing slower than this is said so in the console, in development. */
const SLOW_MS = 50;
/** The town is kept in chunks this many tiles square, each drawn again
 *  only when something on it or near it changes. */
const CHUNK = 8;
/** How far past its chunk a paving triangle is taken for it, in tiles:
 *  past the texels the chunk's square reads at its edge. */
const PAVING_PAD = 0.1;
/** Tiles of town drawn round the chunks being drawn: a tile's look reads
 *  its neighbours, and what a tile cannot see from them (`facts.ts`) is
 *  worked out over the whole town. */
const MARGIN = 2;

/**
 * The town as the town grid draws it (`engine/town/`), from the live world.
 * A road is drawn a tile at a time, each tile a square with the shape its
 * arms make drawn on it (`roads.ts`), and redrawn when something round it
 * changes. The town round
 * what is built, its pavement, buildings and trees, is kept in
 * chunks: on the next frame after anything built changes, however many
 * changes landed before it, the chunks near it are drawn again, together,
 * from a window of the town a little wider, and cut to their chunks. Cars
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
    const started = performance.now();
    const buildings = new Map<string, { entry: GameObjectEntry; kind: BuildingKind }>();
    const doors = doorsOf(this.entities);
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
        // Turned half round, so the way to the street is too.
        door: (c, r) => turned(doors.get(`${x1 - c},${y1 - r}`)),
        at: (c, r) => [x1 - c, y1 - r],
      };
      return town;
    };

    // Each building painted as the shade a surface takes of its colour
    // and which building it is; its colour set apart (`Tints`).
    const paint: Paint = (t, a, b) => {
      const e = t.id === undefined ? undefined : byId.get(t.id);
      return [a, b, e ? this.tints.set(e.id, this.colourOf(e)) : 0];
    };

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

    // The whole town, and what it cannot see from its tiles; then a window
    // of it round the chunks to draw, a margin wider, drawn once.
    const whole = townOver(box);
    const known = facts(whole);
    const area: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
    for (const key of todo) {
      const [cx, cy] = key.split(",").map(Number);
      grow(area, cx * CHUNK, cy * CHUNK);
      grow(area, cx * CHUNK + CHUNK - 1, cy * CHUNK + CHUNK - 1);
    }
    const [wx0, wy0, wx1, wy1] = widen(area, MARGIN);
    // The window in the whole town's frame: column box[2] - x, row box[3] - y.
    const [c0, r0] = [box[2] - wx1, box[3] - wy1];
    const [w, h] = [wx1 - wx0 + 1, wy1 - wy0 + 1];
    const { pieces, dressing } = drawTown(windowOf(whole, c0, r0, w, h), this.theme(), paint, windowFacts(known, c0, r0, w, h));
    // A tile's place in the window's drawing: tile x runs over x - wx1 - 1
    // to x - wx1, and so for y.
    const frame = ([x0, y0, x1, y1]: Bounds): Box => [x0 - wx1 - 1, y0 - wy1 - 1, x1 - wx1, y1 - wy1];
    // Each piece's triangles filed by the chunks they reach into, so a
    // chunk cuts only its own; the paving's kerbs found once, from the
    // window's whole paving, so a kerb is never where a chunk was cut.
    const chunkAt = (gx: number, gy: number): [number, number] => [Math.floor((gx + wx1 + 1) / CHUNK), Math.floor((gy + wy1 + 1) / CHUNK)];
    const filed = new Map(pieces.map((p) => [p, fileBy(p.geo, chunkAt, (cx, cy) => `${cx},${cy}`, p.name === "pavement" ? PAVING_PAD : 0)]));
    const pavement = pieces.find((p) => p.name === "pavement");
    const kerbs = pavement ? kerbsOf(pavement.geo) : [];
    const lines = stripLines(dressing.yardLines);
    for (const key of todo) {
      const [cx, cy] = key.split(",").map(Number);
      // The chunk, as far as the town reaches into it.
      const tiles: Bounds = [Math.max(cx * CHUNK, box[0]), Math.max(cy * CHUNK, box[1]), Math.min(cx * CHUNK + CHUNK - 1, box[2]), Math.min(cy * CHUNK + CHUNK - 1, box[3])];
      const cut = frame(tiles);
      // The paving as its own triangles, uncut, those at or near the chunk:
      // drawn as a square over it, cut to them by its texture.
      const own: Piece[] = [...filed].map(([p, byChunk]) => {
        const mine = byChunk.get(key) ?? [];
        if (p !== pavement) return { ...p, geo: clipTo(p.geo, cut, mine) };
        return { ...p, geo: { ...p.geo, indices: mine.flatMap((t) => [p.geo.indices[t], p.geo.indices[t + 1], p.geo.indices[t + 2]]) } };
      });
      // A tree stands on the chunk its middle is on; it is not cut.
      const inChunk = dressing.trees.filter((t) => {
        const [x, y] = [-t.x, -t.y];
        return x >= cut[0] && x < cut[2] && y >= cut[1] && y < cut[3];
      });
      this.drop(key);
      this.show(key, own.filter((p) => p.geo.indices.length), inChunk, [wx0, wy0, wx1, wy1], { kerbs, lines }, cut);
    }
    const took = performance.now() - started;
    perfCount("town.draws");
    perfCount("town.drawMs", took);
    if (import.meta.env.DEV && took > SLOW_MS) console.warn(`[town] ${todo.length} chunks drawn in ${took.toFixed(0)} ms over ${w}x${h} tiles`);
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
   *  texture, the kerbs read off the window's whole paving so a kerb is
   *  never where the chunk was cut; and its trees. */
  private show(key: string, pieces: Piece[], trees: Dressing["trees"], [, , x1, y1]: Bounds, paving: { kerbs: Kerb[]; lines: Line[] }, cut: Box) {
    const root = new TransformNode(`town_${key}`, this.scene);
    root.position.set(x1 + 1, y1 + 1, 0);
    const meshes: Mesh[] = [];
    for (const p of pieces) {
      const mesh = new Mesh(`town_${p.name}_${key}`, this.scene);
      const paved = p.name === "pavement";
      const geo = bevelled(paved ? square(cut, PAVED_Z) : p.geo);
      const vd = new VertexData();
      Object.assign(vd, { positions: geo.positions, indices: geo.indices, normals: geo.normals, colors: geo.colors ?? null });
      vd.applyToMesh(mesh);
      giveBevel(mesh, geo);
      mesh.material = bevelOn(this.pool.material(paved ? `town_pavement_${key}` : `town_${p.name}`, p.colour ?? Color3.White()), p.name);
      if (p.name === "mass" && !mesh.material.pluginManager?.getPlugin("Tint")) new TintPlugin(mesh.material, this.tints);
      if (paved) kerbed(mesh.material, kerbField(this.scene, paving.kerbs, cut, { cover: p.geo, lines: paving.lines }), this.theme().road);
      mesh.parent = root;
      mesh.isPickable = false;
      mesh.receiveShadows = true;
      if (p.name === "mass") this.shadows.addShadowCaster(mesh);
      meshes.push(mesh);
    }
    const { matrices, colors } = treeInstances(trees, this.theme());
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

/** A box of tiles: x0, y0, x1, y1. */
type Bounds = [number, number, number, number];

function grow(b: Bounds, x: number, y: number) {
  [b[0], b[1], b[2], b[3]] = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)];
}

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
