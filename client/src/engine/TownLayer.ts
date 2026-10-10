import type { Mesh } from "@babylonjs/lite";
import { spread } from "./budget";
import { perfCount } from "./PerfReport";
import { Tints, tintPlugin } from "./tints";
import { ROOF } from "./roofs";
import type { EngineContext } from "./Canvas";
import type { Casters } from "./DayNightCycle";
import { setTint, townMaterial, type TownMaterial } from "./material";
import { drop, meshOf, show } from "./geometry";
import { hex, rgb, WHITE, type Rgb } from "./rgb";
import * as Comlink from "comlink";
import { CHUNK, MARGIN, type Bounds, type ChunkDrawing, type Snapshot } from "./town/layer";
import type { TownApi } from "./townWorker";
import type { Theme } from "./theme";
import type { Look } from "./objects/look";
import { BLUEPRINTS } from "../blueprints";
import { KERB_Z } from "./town/draw";
import type { MeshGeometry } from "./geometry";
import { bevelled, bevelPlugin, giveBevel, lacquer, type Bevel } from "./bevel";
import { waysAt } from "./town/dressing";
import { storeysOf, type Town } from "./town/grid";
import type { Box } from "./town/clip";
import { kerbField, kerbPlugin, unkerb, type KerbField } from "./kerbs";
import { pavingPlugin, ROUGHNESS as PAVING_ROUGHNESS } from "./paving";
import { RoadTiles } from "./roads";
import { grove, plant, uproot, type Grove } from "./trees";
import { clearProps, placeProps } from "./props";
import type { RGB } from "./town/mass";
import type { Building, BuildingKind, GameObjectEntry, RoadNode, TerrainType } from "../generated";
import type { Pose } from "../generated/Pose";
import type { Pt } from "./town/footprint";
import { TRAILER } from "./objects/roadGeometry";

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
  private chunks = new Map<string, { meshes: Mesh[]; trees: Grove; kerbs: KerbField | null; props: Mesh[] }>();
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

  /** The masses' material, every chunk's: their buildings' colours read
   *  off the tints, their roofs tiled, lacquered as a building is. And each
   *  other piece's, by its name and colour. */
  private masses: TownMaterial;
  private pieces = new Map<string, TownMaterial>();
  private stopTints: () => void;

  constructor(
    private ctx: EngineContext,
    private casters: Casters,
    private theme: () => Theme,
    private entities: (f: (e: GameObjectEntry) => void) => void,
    private ground: (x: number, y: number) => TerrainType | undefined,
    private look: (e: GameObjectEntry) => Look,
  ) {
    this.tints = new Tints(ctx.engine);
    this.stopTints = ctx.beforeRender(() => this.tints.upload());
    const bevel: Bevel = { width: 0.05, soft: null };
    this.masses = lacquer(townMaterial([bevelPlugin(bevel), tintPlugin(this.tints), ROOF]), "building", bevel);
    this.roads = new RoadTiles(ctx.engine, ctx.scene, (through) => (through ? this.theme().highway : this.theme().road));
  }

  /** A piece's material, made once for its name and colour. */
  private pieceMaterial(name: string, colour: Rgb): TownMaterial {
    const key = `${name} ${colour.r} ${colour.g} ${colour.b}`;
    let material = this.pieces.get(key);
    if (!material) {
      material = townMaterial([bevelPlugin()]);
      setTint(material, colour);
      this.pieces.set(key, material);
    }
    return material;
  }

  /** A building's slot of the tints, its colour as it looks now; none
   *  for one gone since its town was drawn. */
  private slotOf(id: number, byId: Map<number, GameObjectEntry>): number {
    const e = byId.get(id);
    return e ? this.tints.set(id, this.colourOf(e)) : 0;
  }

  /** A building's colour as it looks now. */
  private colourOf(e: GameObjectEntry): RGB {
    const c = this.look(e).tint(hex(BLUEPRINTS[(e.object.data as Building).kind as BuildingKind].material));
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
    const marks = new Map<string, Snapshot["marks"][number]>();
    const byId = new Map<number, GameObjectEntry>();
    // The bounds of the buildings.
    const built: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
    this.entities((e) => {
      if (e.object.kind === "RoadNode" && e.position) {
        const n = e.object.data as RoadNode;
        roads.push([e.position.x, e.position.y, e.id, n.road, n.outgoing, n.incoming]);
      } else if (e.object.kind === "Building" && true) {
        const b = e.object.data as Building;
        byId.set(e.id, e);
        joined.push([e.id, b.joined.map((t) => [t.x, t.y])]);
        if (b.door) doors.push([b.door.tile.x, b.door.tile.y, b.door.street.x - b.door.tile.x, b.door.street.y - b.door.tile.y]);
        for (const p of b.park) for (const side of [-1, 1]) slotLine(marks, p.pose, side);
        // A site is its ground, paved, until it stands (`BuildingObject`).
        for (const t of b.tiles) {
          buildings.push([t.x, t.y, e.id, b.site ? "paved" : b.kind]);
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
    const snapshot: Snapshot = { box, todo, buildings, roads, joined, doors, marks: [...marks.values()], ground, kinds: KINDS, theme: this.theme() };
    const gathered = performance.now() - started;
    this.drawing = true;
    this.builder
      .draw(snapshot)
      .then(
        ({ chunks, window }) => {
          perfCount("town.mainMs", gathered);
          // A chunk a part, in frames' spare time; the next drawing waits
          // for the last, so an older one never lands over a newer.
          const showing = function* (this: TownLayer) {
            for (const c of chunks) {
              const shown = performance.now();
              this.drop(c.key);
              this.show(c, window, byId);
              perfCount("town.mainMs", performance.now() - shown);
              yield;
            }
          };
          return spread(showing.call(this));
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
  private show({ key, pieces, trees, props, cut, paving }: ChunkDrawing, [, , x1, y1]: Bounds, byId: Map<number, GameObjectEntry>) {
    const { engine, scene } = this.ctx;
    const [ox, oy] = [x1 + 1, y1 + 1];
    // The chunk on the map, and a tile round it for what stands over its edge.
    const [cx, cy] = key.split(",").map(Number);
    const area = [cx * CHUNK - 1, cy * CHUNK - 1, (cx + 1) * CHUNK + 1, (cy + 1) * CHUNK + 1] as const;
    const meshes: Mesh[] = [];
    // The chunk's kerb texture, its pavement's own.
    const kerbs = paving ? kerbField(engine, paving) : null;
    for (const p of pieces) {
      // The masses carry each surface's building: its slot, its colour set.
      if (p.name === "mass" && p.geo.colors) for (let k = 2; k < p.geo.colors.length; k += 4) p.geo.colors[k] = this.slotOf(p.geo.colors[k], byId);
      const paved = p.name === "pavement";
      const geo = bevelled(paved ? square(cut, KERB_Z) : p.geo);
      const mesh = meshOf(engine, `town_${p.name}_${key}`, geo);
      giveBevel(engine, mesh, geo);
      const colour = p.colour ? rgb(p.colour.r, p.colour.g, p.colour.b) : WHITE;
      mesh.material = p.name === "mass" ? this.masses : paved ? this.pavement(colour, kerbs) : this.pieceMaterial(p.name, colour);
      mesh.position.x = ox;
      mesh.position.y = oy;
      mesh.receiveShadows = true;
      this.ctx.cull.keep(mesh, area);
      show(scene, mesh);
      if (p.name === "mass") this.casters.add(mesh);
      meshes.push(mesh);
    }
    const { matrices, colors } = trees;
    const g = grove(this.ctx, `town_${key}`);
    for (const mesh of [g.bodies, g.tops]) {
      mesh.position.x = ox;
      mesh.position.y = oy;
    }
    plant(this.ctx, g, matrices, colors, this.casters, area);
    const placed = placeProps(this.ctx, `town_${key}`, props, [ox, oy], area, this.casters);
    this.chunks.set(key, { meshes, trees: g, kerbs, props: placed });
  }

  /** A chunk's pavement's material: paving, rounded at its kerbs and its
   *  yards' lines painted on from its kerb texture, if it has one. */
  private pavement(colour: Rgb, kerbs: KerbField | null): TownMaterial {
    const material = townMaterial(
      kerbs ? [bevelPlugin(), kerbPlugin(kerbs, this.theme().road, colour), pavingPlugin(this.ctx.engine, true)] : [bevelPlugin(), pavingPlugin(this.ctx.engine, false)],
      PAVING_ROUGHNESS,
    );
    setTint(material, colour);
    return material;
  }

  /** A chunk's meshes gone. */
  private drop(key: string) {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    for (const m of chunk.meshes) {
      this.casters.remove(m);
      this.ctx.cull.forget(m);
      drop(this.ctx.scene, m);
    }
    uproot(this.ctx, chunk.trees, this.casters);
    clearProps(this.ctx, chunk.props, this.casters);
    if (chunk.kerbs) unkerb(chunk.kerbs);
    this.chunks.delete(key);
  }

  dispose() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    for (const key of [...this.chunks.keys()]) this.drop(key);
    this.roads.dispose();
    this.stopTints();
    this.worker.terminate();
  }
}

/** A line down one side of a trailer park's slot, from behind the box to
 *  past its hitch, where a lorry's cab stands; a line two slots share
 *  painted once. */
function slotLine(marks: Map<string, Snapshot["marks"][number]>, { at: [x, y], heading }: Pose, side: number) {
  const [ux, uy] = [Math.cos(heading), Math.sin(heading)];
  const [cx, cy] = [x - uy * side * SLOT / 2, y + ux * side * SLOT / 2];
  const [a, b, w] = [-TRAILER.l / 2 - 0.04, TRAILER.l / 2 + 0.12, 0.008];
  const at = (t: number, o: number): Pt => [cx + ux * t - uy * o, cy + uy * t + ux * o];
  marks.set(`${cx.toFixed(2)},${cy.toFixed(2)}`, [at(a, -w), at(b, -w), at(b, w), at(a, w)]);
}
/** A slot's width: the docks' spacing (`BAY_W` in the server's `lots.rs`). */
const SLOT = 0.3;

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
