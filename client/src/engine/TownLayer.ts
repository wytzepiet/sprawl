import { addToScene, markMaterialUboDirty, type MaterialPlugin, type Mesh } from "@babylonjs/lite";
import { night } from "./lights";
import { spread } from "./budget";
import { perfCount } from "./PerfReport";
import { Tints, tintPlugin } from "./tints";
import { ROOF } from "./roofs";
import type { EngineContext } from "./Canvas";
import type { Casters } from "./DayNightCycle";
import { setTint, townMaterial, type TownMaterial } from "./material";
import { drop, meshOf } from "./geometry";
import { hex, rgb, WHITE, type RGB, type Rgb } from "./rgb";
import * as Comlink from "comlink";
import { areaOf, CHUNK, grow, kerbed, MARGIN, turned, widen, type Bounds, type ChunkDrawing, type Snapshot } from "./town/layer";
import type { TownApi } from "./townWorker";
import { theme } from "./theme";
import type { Look } from "./objects/look";
import { BLUEPRINTS, yardOf } from "../blueprints";
import { KERB_Z, LAYER_ORDER } from "./town/draw";
import type { MeshGeometry } from "./geometry";
import { bevelled, bevelPlugin, giveBevel, lacquer, type Bevel } from "./bevel";
import { surfacesAt } from "./town/surface";
import { Decks, liftOf, type DeckPiece } from "./decks";
import { storeysOf, type Flow, type RoadView, type Tile, type Town } from "./town/grid";
import type { Box } from "./town/clip";
import { kerbField, kerbPlugin, unkerb, type KerbField } from "./kerbs";
import { pavingPlugin, ROUGHNESS as PAVING_ROUGHNESS } from "./paving";
import { RoadTiles } from "./roads";
import { grove, plant, uproot, type Grove } from "./trees";
import { clearProps, placeProps } from "./props";
import type { Building, BuildingKind, GameObjectEntry, GridCoord, RoadNode, TerrainType, Placing } from "../generated";
import { SIDE_OFFSET } from "./tiles";

/** How many roads one tile may hold: the ground's two side by side, and
 *  the decks' over them. */
const ROADS_A_TILE = 8;
/** Ground round what is built the town is drawn over: its pavement and
 *  its trees. */
const TOWN_MARGIN = 4;
/** The town round what is built, a margin wider; none, where nothing is. */
const townOf = (built: Bounds): Bounds | null => (built[0] <= built[2] ? widen(built, TOWN_MARGIN) : null);
/** A drawing slower than this is said so in the console, in development. */
const SLOW_MS = 50;
/** The ground as the town worker is told it, by index. */
const KINDS: TerrainType[] = ["Water", "Sea", "Beach", "Grass", "Forest", "Mountain"];
/** The building held over the map: its id in a drawing, and its colour,
 *  the hand's blue. */
const HELD = -1;
const HELD_BLUE: RGB = [0.36, 0.6, 1];

/** A chunk as it is shown: its meshes, its trees, its kerbs, its props. */
interface Shown {
  meshes: Mesh[];
  trees: Grove;
  kerbs: KerbField | null;
  props: Mesh[];
}

/** The world as a drawing is made of it. */
interface Gathered {
  buildings: Snapshot["buildings"];
  roads: Snapshot["roads"];
  doors: Snapshot["doors"];
  byId: Map<number, GameObjectEntry>;
  /** The bounds of the buildings. */
  built: Bounds;
}

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
 * half round onto the map. Kerbs are
 * rounded from each sheet's own kerb texture (`kerbs.ts`).
 */
/** The masses' windows, the glass their vertices mark (`town/roof.ts`):
 *  lit from within as the night comes on, a lamp's warm colour, dimmer. */
const WINDOW_GLOW = [0.9, 0.58, 0.28];
const WINDOWS: MaterialPlugin = {
  name: "Windows",
  priority: 230,
  getUniforms: () => ({ ubo: [{ name: "windowGlow", type: "f32" }] }),
  writeUbo: (data, offsets) => void (data[offsets.get("windowGlow")! / 4] = night.on),
  getCustomCode: (stage) =>
    stage === "fragment" ? { CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `color += vec3f(${WINDOW_GLOW.join(", ")}) * material.windowGlow * (1. - input.vColor.a);` } : null,
};

export class TownLayer {
  /** Each chunk's meshes, by chunk, and the chunks to draw again. */
  private chunks = new Map<string, Shown>();
  private stale = new Set<string>();
  /** The road tiles, and the tiles to draw again. */
  private roads: RoadTiles;
  /** The decks' road tiles, by key, and the concrete under them. */
  private decks = new Map<string, DeckPiece>();
  private concrete: Decks;
  private dirty = new Set<string>();
  private frame: number | null = null;
  private tints: Tints;
  /** The town is drawn off the main thread, one drawing at a time. */
  private worker = new Worker(new URL("./townWorker.ts", import.meta.url), { type: "module" });
  private builder = Comlink.wrap<TownApi>(this.worker);
  private drawing = false;
  /** A building held over the map, drawn as it would stand: the chunks it
   *  changes drawn again with it in them, by a worker of their own, shown
   *  in place of the town's own, and its drive on the road tiles. One
   *  drawing at a time; a move meanwhile is drawn when it lands. */
  private held: Placing | null = null;
  private heldDirty = false;
  private previewing = false;
  private preview = new Map<string, Shown>();
  private heldWorker = new Worker(new URL("./townWorker.ts", import.meta.url), { type: "module" });
  private previewer = Comlink.wrap<TownApi>(this.heldWorker);

  /** The masses' material, every chunk's: their buildings' colours read
   *  off the tints, their roofs tiled, lacquered as a building is. And each
   *  other piece's, by its name and colour. */
  private masses: TownMaterial;
  private pieces = new Map<string, TownMaterial>();
  private stopTints: () => void;
  private stopGlow: () => void;

  constructor(
    private ctx: EngineContext,
    private casters: Casters,
    private entities: (f: (e: GameObjectEntry) => void) => void,
    private ground: (x: number, y: number) => TerrainType | undefined,
    private look: (e: GameObjectEntry) => Look,
  ) {
    this.tints = new Tints(ctx.engine);
    this.stopTints = ctx.beforeRender(() => this.tints.upload());
    const bevel: Bevel = { width: 0.05, soft: null };
    this.masses = lacquer(townMaterial([bevelPlugin(bevel), tintPlugin(this.tints), ROOF, WINDOWS]), "building", bevel);
    let glow = -1;
    this.stopGlow = ctx.beforeRender(() => {
      if (night.on !== glow) markMaterialUboDirty(this.masses), (glow = night.on);
    });
    this.roads = new RoadTiles(ctx.engine, ctx.scene);
    const { r, g, b } = theme.paved;
    this.concrete = new Decks(ctx.engine, ctx.scene, casters, rgb(r, g, b));
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

  /** A building held over the map, as it would stand, or none. Only one
   *  that may stand there is drawn: one that may not is the hand's to
   *  show, with why. */
  hold(p: Placing | null) {
    const next = p && !p.why ? p : null;
    const same = (a: Placing | null, b: Placing | null) => JSON.stringify(a && [a.tiles, a.door, a.kind]) === JSON.stringify(b && [b.tiles, b.door, b.kind]);
    if (same(next, this.held)) return;
    // Its road tiles drawn again, with its drive and without.
    for (const q of [this.held, next]) for (const t of q ? [...q.tiles, ...(q.door ? [q.door.street] : [])] : []) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) this.dirty.add(`${t.x + dx},${t.y + dy}`);
    this.held = next;
    this.heldDirty = true;
    this.settle();
  }

  /** On the next frame, what changed drawn: the world as a town made at
   *  most once for it. */
  private settle() {
    this.frame ??= requestAnimationFrame(() => {
      this.frame = null;
      let made: Town | undefined;
      const world = () => (made ??= this.world());
      this.draw(world);
      this.retile(world);
      this.drawHeld(world);
    });
  }

  /** The world as a drawing is made of it, the building held in it if asked. */
  private gather(held: Placing | null): Gathered {
    const g: Gathered = { buildings: [], roads: [], doors: [], byId: new Map(), built: [Infinity, Infinity, -Infinity, -Infinity] };
    this.entities((e) => {
      // The ground's roads: what is above it is drawn as decks (`decks.ts`).
      if (e.object.kind === "RoadNode" && e.position) {
        const n = e.object.data as RoadNode;
        if (n.height) return;
        g.roads.push([e.position.x, e.position.y, e.id, n.road.length > 0, n.outgoing, n.incoming]);
      } else if (e.object.kind === "Building") {
        const b = e.object.data as Building;
        g.byId.set(e.id, e);
        if (b.door) g.doors.push([b.door.tile.x, b.door.tile.y, b.door.street.x - b.door.tile.x, b.door.street.y - b.door.tile.y]);
        // A site is its ground, paved, until it stands (`BuildingObject`).
        const yard = yardTiles(b.tiles, b.kind, b.facing);
        for (const t of b.tiles) {
          g.buildings.push([t.x, t.y, e.id, b.site ? "paved" : b.kind, yard.has(`${t.x},${t.y}`)]);
          grow(g.built, t.x, t.y);
        }
      }
    });
    if (held) {
      const yard = yardTiles(held.tiles, held.kind, held.facing);
      for (const t of held.tiles) {
        g.buildings.push([t.x, t.y, HELD, held.kind, yard.has(`${t.x},${t.y}`)]);
        grow(g.built, t.x, t.y);
      }
      if (held.door) g.doors.push([held.door.tile.x, held.door.tile.y, held.door.street.x - held.door.tile.x, held.door.street.y - held.door.tile.y]);
    }
    return g;
  }

  /** The roads on each of these road tiles, as they are drawn here. */
  private views(roads: Snapshot["roads"], world: Town): Snapshot["views"] {
    const tiles = new Set(roads.map(([x, y]) => `${x},${y}`));
    return [...tiles].map((k) => {
      const [x, y] = k.split(",").map(Number);
      return [x, y, world.roadsOn!(-x, -y)];
    });
  }

  /** The ground under a box, as the worker cannot ask the terrain. */
  private groundUnder([x0, y0, x1, y1]: Bounds): Uint8Array {
    const ground = new Uint8Array((x1 - x0 + 1) * (y1 - y0 + 1)).fill(255);
    for (let y = y0, k = 0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++, k++) {
        const g = this.ground(x, y);
        if (g !== undefined) ground[k] = KINDS.indexOf(g);
      }
    }
    return ground;
  }

  /** The chunks round the building held drawn again with it standing, and
   *  shown in place of the town's own; or, let go, the town's own again. */
  private drawHeld(world: () => Town) {
    if (this.previewing || !this.heldDirty) return;
    this.heldDirty = false;
    const held = this.held;
    // Let go, the town's own is shown again once it is drawn as it now
    // stands, a building placed standing in it.
    if (!held && (this.drawing || this.stale.size)) return void (this.heldDirty = true);
    if (!held) return this.unhold();
    const started = performance.now();
    const todo = new Set<string>();
    for (const t of held.tiles) for (let dy = -MARGIN; dy <= MARGIN; dy += MARGIN) for (let dx = -MARGIN; dx <= MARGIN; dx += MARGIN) todo.add(chunkOf(t.x + dx, t.y + dy));
    // The town round them, a margin wider, all a tile's look can read.
    const box = widen(areaOf(todo), TOWN_MARGIN + MARGIN);
    const g = this.gather(held);
    const inside = ([x, y]: [number, number, ...unknown[]]) => x >= box[0] - 1 && x <= box[2] + 1 && y >= box[1] - 1 && y <= box[3] + 1;
    const snapshot: Snapshot = {
      box, town: townOf(g.built), todo: [...todo], buildings: g.buildings.filter(inside), roads: g.roads.filter(inside), views: this.views(g.roads.filter(inside), world()), doors: g.doors.filter(inside), ground: this.groundUnder(box), kinds: KINDS,
    };
    this.previewing = true;
    this.previewer
      .draw(snapshot)
      .then(({ chunks, window }) => {
        // Let go meanwhile: nothing to show.
        if (this.held !== held) return;
        this.unhold();
        for (const c of chunks) {
          const real = this.chunks.get(c.key);
          if (real) this.want(real, false);
          this.preview.set(c.key, this.make(c, window, g.byId));
        }
        perfCount("town.heldMs", performance.now() - started);
      })
      .catch((e) => console.error("[town] the building held could not be drawn", e))
      .finally(() => {
        this.previewing = false;
        if (this.heldDirty) this.settle();
      });
  }

  /** The held building's chunks gone, the town's own shown again. */
  private unhold() {
    for (const [key, shown] of this.preview) {
      this.dropShown(shown);
      const real = this.chunks.get(key);
      if (real) this.want(real, true);
    }
    this.preview.clear();
  }

  /** A chunk shown or hidden, whatever the view. */
  private want(shown: Shown, wanted: boolean) {
    for (const m of [...shown.meshes, ...shown.trees.meshes, ...shown.props]) this.ctx.cull.want(m, wanted);
  }

  private draw(world: () => Town) {
    // One drawing at a time: what goes stale meanwhile is drawn when it lands.
    if (this.drawing) return;
    const started = performance.now();
    const { buildings, roads, doors, byId, built } = this.gather(null);

    // The town, paved and dressed, only round what is built: a road
    // across open country is asphalt, and the town is what is paved; and
    // out in the country, the kerbs round a junction and down a divided
    // road's middle (`kerbed`). The
    // chunks they cover; those no longer covered go, those newly are drawn.
    const town = townOf(built);
    const box: Bounds = town ?? [Infinity, Infinity, -Infinity, -Infinity];
    const covered = new Set<string>();
    if (town) for (let cy = Math.floor(town[1] / CHUNK); cy <= Math.floor(town[3] / CHUNK); cy++) for (let cx = Math.floor(town[0] / CHUNK); cx <= Math.floor(town[2] / CHUNK); cx++) covered.add(`${cx},${cy}`);
    for (const [x, y] of [...kerbed(roads)].map((k) => k.split(",").map(Number))) {
      grow(box, x - 1, y - 1);
      grow(box, x + 1, y + 1);
      for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) covered.add(chunkOf(x + dx, y + dy));
    }
    for (const key of [...this.chunks.keys()]) if (!covered.has(key)) this.drop(key);
    for (const key of covered) if (!this.chunks.has(key)) this.stale.add(key);
    const todo = [...this.stale].filter((key) => covered.has(key));
    this.stale.clear();
    if (!todo.length) return;

    const near = ([x, y]: [number, number, ...unknown[]]) => x >= box[0] - 1 && x <= box[2] + 1 && y >= box[1] - 1 && y <= box[3] + 1;
    const snapshot: Snapshot = { box, town, todo, buildings, roads, views: this.views(roads.filter(near), world()), doors, ground: this.groundUnder(box), kinds: KINDS };
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
              const made = this.make(c, window, byId);
              // Under a building held, it waits to be seen again.
              if (this.preview.has(c.key)) this.want(made, false);
              this.chunks.set(c.key, made);
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
        if (this.stale.size || this.heldDirty) this.settle();
      });
  }

  /** The roads on each tile that changed, the shape each one's arms
   *  make: the world as a town in the fixture's frame round the map's
   *  origin, asked about those tiles alone. Two roads may share a tile,
   *  side by side, each its own: `x,y#0` and `x,y#1`. */
  private retile(world: () => Town) {
    if (!this.dirty.size) return;
    let decked = false;
    for (const key of this.dirty) {
      const [x, y] = key.split(",").map(Number);
      const surfaces = surfacesAt(world(), -x, -y);
      for (let i = 0; i < ROADS_A_TILE; i++) {
        const k = `${key}#${i}`;
        const s = surfaces[i];
        decked ||= this.decks.has(k) || !!s?.height;
        this.decks.delete(k);
        if (!s) {
          this.roads.delete(k);
          continue;
        }
        this.roads.set(k, x, y, s, s.height ? liftOf(s) : undefined);
        if (s.height) this.decks.set(k, { x, y, surface: s });
      }
    }
    if (decked) this.concrete.rebuild(this.decks.values());
    this.dirty.clear();
    this.roads.flush();
  }

  /** The whole world as a town, unbounded, in the fixture's frame turned
   *  about the map's origin: column -x, row -y. A building's tiles carry
   *  which building and whether its yard, as the chunks' do. */
  private world(): Town {
    // The ground's roads: the middle's by tile, every one by tile and by id.
    const nodes = new Map<string, RoadNode & { id: number }>();
    const onTile = new Map<string, (RoadNode & { id: number })[]>();
    const byId = new Map<number, { n: RoadNode & { id: number }; x: number; y: number }>();
    const built = new Map<string, Tile>();
    // Every building's door, by its tile: the way on the map to its street.
    const doors = new Map<string, [number, number]>();
    const raise = (id: number, { tiles, kind, facing, site }: Pick<Building, "tiles" | "kind" | "facing"> & { site?: unknown }) => {
      const yard = site ? new Set<string>() : yardTiles(tiles, kind, facing);
      for (const t of tiles) built.set(`${t.x},${t.y}`, { kind, storeys: storeysOf(kind), id, yard: yard.has(`${t.x},${t.y}`) });
    };
    this.entities((e) => {
      if (e.object.kind === "RoadNode" && e.position) {
        const n = { ...e.object.data, id: e.id };
        const k = `${e.position.x},${e.position.y}`;
        byId.set(e.id, { n, x: e.position.x, y: e.position.y });
        if (!n.height && !n.side?.[0] && !n.side?.[1]) nodes.set(k, n);
        (onTile.get(k) ?? onTile.set(k, []).get(k)!).push(n);
      }
      else if (e.object.kind === "Building") {
        const b = e.object.data as Building;
        raise(e.id, b);
        if (b.door) doors.set(`${b.door.tile.x},${b.door.tile.y}`, [b.door.street.x - b.door.tile.x, b.door.street.y - b.door.tile.y]);
      }
    });
    // And the building held, its drive on its street.
    const held = this.held;
    if (held) raise(HELD, held);
    if (held?.door) doors.set(`${held.door.tile.x},${held.door.tile.y}`, [held.door.street.x - held.door.tile.x, held.door.street.y - held.door.tile.y]);
    const key = (c: number, r: number) => `${-c},${-r}`;
    // The tile's road on the ground, for what the ground asks of it; a tile
    // with only a deck over it is a road tile too, so its deck is drawn.
    const road = (c: number, r: number) => (built.has(key(c, r)) ? undefined : nodes.get(key(c, r)) ?? onTile.get(key(c, r))?.find((n) => !n.height));
    const flowOf = (a: RoadNode & { id: number }, b: RoadNode & { id: number }): Flow => {
      if (a.wide.includes(b.id)) return "O";
      if (b.wide.includes(a.id)) return "I";
      const [out, back] = [a.outgoing.includes(b.id) || b.incoming.includes(a.id), b.outgoing.includes(a.id) || a.incoming.includes(b.id)];
      return out && back ? "t" : out ? "o" : "i";
    };
    // A slope's run, the slopes one after another it climbs with: which of
    // them it is from the low end, how many, and the heights from and to.
    const runOf = (n: RoadNode & { id: number }): [number, number, number, number] => {
      const next = (m: RoadNode & { id: number }, higher: boolean) =>
        [...m.outgoing, ...m.incoming].map((id) => byId.get(id)?.n).find((o) => o && (higher ? o.height > m.height : o.height < m.height));
      let [low, below] = [n, 0];
      for (let o = next(low, false); o && o.height % 2; o = next(low, false)) [low, below] = [o, below + 1];
      let [high, above] = [n, 0];
      for (let o = next(high, true); o && o.height % 2; o = next(high, true)) [high, above] = [o, above + 1];
      return [below, below + above + 1, low.height - 1, high.height + 1];
    };
    // A road moved to a side of its tile, in the town's frame, turned.
    const shiftOf = ({ side }: RoadNode): [number, number] => {
      const [sx, sy] = side ?? [0, 0];
      const by = sx || sy ? SIDE_OFFSET / Math.hypot(sx, sy) : 0;
      return [-sx * by, -sy * by];
    };
    return {
      w: Infinity,
      h: Infinity,
      tile: (c, r) => built.get(key(c, r)) ?? (onTile.has(key(c, r)) ? { kind: "road", storeys: 0 } : { kind: "open", storeys: 0 }),
      linked: (c0, r0, c1, r1) => {
        const [a, b] = [road(c0, r0), road(c1, r1)];
        return !!a && !!b && (a.outgoing.includes(b.id) || a.incoming.includes(b.id));
      },
      through: (c, r) => !!road(c, r)?.road.length,
      roadsOn: (c, r): RoadView[] =>
        built.has(key(c, r))
          ? []
          : (onTile.get(key(c, r)) ?? []).map((n) => {
              const arms = [...new Set([...n.outgoing, ...n.incoming])].flatMap((id) => {
                const o = byId.get(id);
                if (!o || Math.abs(o.x + c) > 1 || Math.abs(o.y + r) > 1) return [];
                return [{ dc: -(o.x + c), dr: -(o.y + r), flow: flowOf(n, o.n), shift: shiftOf(o.n), through: n.road.includes(id), height: o.n.height }];
              });
              // A slope climbs toward its arm above it, one of a run.
              const up = n.height % 2 ? arms.find((a) => a.height > n.height) : undefined;
              return { shift: shiftOf(n), through: n.road.length > 0, light: n.light != null, arms, height: n.height, climb: up && ([up.dc, up.dr] as [number, number]), run: up && runOf(n) };
            }),
      door: (c, r) => turned(doors.get(key(c, r))),
    };
  }

  /** A chunk's pieces, drawn in the frame of the window they were drawn
   *  in, placed on the map: its paving a square over the chunk, cut to
   *  the paving, rounded at its kerbs and its yards' lines painted on by a
   *  texture, its texels worked out with the drawing; and its trees. */
  private make({ key, pieces, trees, props, cut, paving }: ChunkDrawing, [, , x1, y1]: Bounds, byId: Map<number, GameObjectEntry>): Shown {
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
      if (p.name === "mass" && p.geo.colors) for (let k = 2; k < p.geo.colors.length; k += 4) p.geo.colors[k] = p.geo.colors[k] === HELD ? this.tints.set(HELD, HELD_BLUE) : this.slotOf(p.geo.colors[k], byId);
      const paved = p.name === "pavement";
      const geo = bevelled(paved ? square(cut, KERB_Z) : p.geo);
      const mesh = meshOf(engine, `town_${p.name}_${key}`, geo);
      giveBevel(engine, mesh, geo);
      const colour = p.colour ?? WHITE;
      mesh.material = p.name === "mass" ? this.masses : paved ? this.pavement(colour, kerbs) : this.pieceMaterial(p.name, colour);
      if (p.name !== "lines") mesh.renderOrder = paved ? LAYER_ORDER.pavement : LAYER_ORDER.mass;
      mesh.position.x = ox;
      mesh.position.y = oy;
      mesh.receiveShadows = true;
      this.ctx.cull.keep(mesh, area);
      addToScene(scene, mesh);
      if (p.name === "mass" || p.name === "hedges") this.casters.add(mesh);
      meshes.push(mesh);
    }
    const { matrices, colors } = trees;
    const g = grove(`town_${key}`, [ox, oy]);
    plant(this.ctx, g, matrices, colors, this.casters, area);
    const placed = placeProps(this.ctx, `town_${key}`, props, [ox, oy], area, this.casters);
    return { meshes, trees: g, kerbs, props: placed };
  }

  /** A chunk's pavement's material: paving, rounded at its kerbs and its
   *  yards' lines painted on from its kerb texture, if it has one. */
  private pavement(colour: Rgb, kerbs: KerbField | null): TownMaterial {
    const material = townMaterial(
      kerbs ? [bevelPlugin(), kerbPlugin(kerbs), pavingPlugin(this.ctx.engine, true)] : [bevelPlugin(), pavingPlugin(this.ctx.engine, false)],
      PAVING_ROUGHNESS,
    );
    setTint(material, colour);
    return material;
  }

  /** A chunk's meshes gone. */
  private drop(key: string) {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    this.dropShown(chunk);
    this.chunks.delete(key);
  }

  private dropShown(chunk: Shown) {
    for (const m of chunk.meshes) {
      this.casters.remove(m);
      this.ctx.cull.forget(m);
      drop(this.ctx.scene, m);
    }
    uproot(this.ctx, chunk.trees, this.casters);
    clearProps(this.ctx, chunk.props, this.casters);
    if (chunk.kerbs) unkerb(chunk.kerbs);
  }

  dispose() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    for (const key of [...this.chunks.keys()]) this.drop(key);
    this.unhold();
    this.roads.dispose();
    this.concrete.dispose();
    this.stopTints();
    this.stopGlow();
    this.worker.terminate();
    this.heldWorker.terminate();
  }
}

/** A building's yard, as the server lays its lot out, by tile. */
const yardTiles = (tiles: GridCoord[], kind: BuildingKind, facing: number) => new Set((yardOf(tiles, kind, facing) ?? []).map((t) => `${t.x},${t.y}`));


/** The chunk a tile is on. */
const chunkOf = (x: number, y: number) => `${Math.floor(x / CHUNK)},${Math.floor(y / CHUNK)}`;


/** A square over a box, facing up, at a height. */
const square = ([x0, y0, x1, y1]: Box, z: number): MeshGeometry => ({
  positions: [x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  indices: [0, 2, 1, 0, 3, 2],
});
