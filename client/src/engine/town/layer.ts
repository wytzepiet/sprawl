import type { TerrainType } from "../../generated";
import { kerbsOf, kerbTexels, roadsOf, stripLines, type KerbTexels } from "../kerbLines";
import type { Theme } from "../theme";
import { clipTo, fileBy, type Box } from "./clip";
import { drawTown, flatPolygons, treeInstances, type Piece } from "./draw";
import { asphalt } from "./dressing";
import type { Polygon } from "./footprint";
import { facts, windowFacts } from "./facts";
import { storeysOf, windowOf, type Tile, type Town } from "./grid";
import type { Paint } from "./roof";

/**
 * The town's chunks drawn from a snapshot of the world, plain data in and
 * out: what `TownLayer` hands the town worker (`townWorker.ts`), so the
 * drawing, its footprints, roofs and dressing, never holds up a frame.
 */

/** The town is kept in chunks this many tiles square. */
export const CHUNK = 8;
/** How far past its chunk a paving triangle is taken for it, in tiles:
 *  past the texels the chunk's square reads at its edge. */
const PAVING_PAD = 0.1;
/** Tiles of town drawn round the chunks being drawn: a tile's look reads
 *  its neighbours, and what a tile cannot see from them (`facts.ts`) is
 *  worked out over the whole town. */
export const MARGIN = 2;

/** A box of tiles: x0, y0, x1, y1. */
export type Bounds = [number, number, number, number];

/** The world as the town is drawn from it, within `box`. */
export interface Snapshot {
  box: Bounds;
  /** The chunks to draw. */
  todo: string[];
  /** Every built tile: x, y, its building, and the building's kind. */
  buildings: [number, number, number, Tile["kind"]][];
  /** Every road tile: x, y, its node, whether a road rather than a street,
   *  and the nodes it leads to and from. */
  roads: [number, number, number, boolean, number[], number[]][];
  /** Each building, and the tiles of the row the hand drew it in. */
  joined: [number, [number, number][]][];
  /** Each building's door: its tile, and the way to its street. */
  doors: [number, number, number, number][];
  /** The ground under the box, a row of x at a time, as `kinds` lists it,
   *  255 where it is not known. */
  ground: Uint8Array;
  kinds: TerrainType[];
  theme: Theme;
}

/** One chunk drawn: its pieces in the frame of the window they were drawn
 *  in, its trees, the tiles it covers in that frame, and its paving's kerb
 *  texels over them. The masses' vertex colours carry each surface's shade
 *  and its building (`Paint`). */
export interface ChunkDrawing {
  key: string;
  pieces: Piece[];
  trees: { matrices: Float32Array; colors: Float32Array };
  cut: Box;
  paving: KerbTexels | null;
}

export interface Drawing {
  chunks: ChunkDrawing[];
  /** The window the chunks were drawn in, round them a margin wider. */
  window: Bounds;
}

const grow = (b: Bounds, x: number, y: number) => {
  [b[0], b[1], b[2], b[3]] = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)];
};
const widen = ([x0, y0, x1, y1]: Bounds, by: number): Bounds => [x0 - by, y0 - by, x1 + by, y1 + by];
/** A way on the map as the town grid's frame has it, turned half round. */
const turned = (d: [number, number] | undefined): [number, number] | undefined => d && [-d[0], -d[1]];

/** The snapshot's chunks, drawn. */
export function drawChunks(s: Snapshot): Drawing {
  const box = s.box;
  const OPEN: Tile = { kind: "open", storeys: 0 };
  const ROAD: Tile = { kind: "road", storeys: 0 };
  const WATER: Tile = { kind: "water", storeys: 0 };
  const WOOD: Tile = { kind: "wood", storeys: 0 };
  const tiles = new Map<string, Tile>();
  for (const [x, y, id, kind] of s.buildings) tiles.set(`${x},${y}`, { kind, storeys: storeysOf(kind as never), id });
  const roads = new Map<string, { id: number; road: boolean; outgoing: number[]; incoming: number[] }>();
  for (const [x, y, id, road, outgoing, incoming] of s.roads) {
    roads.set(`${x},${y}`, { id, road, outgoing, incoming });
    if (!tiles.has(`${x},${y}`)) tiles.set(`${x},${y}`, ROAD);
  }
  const joined = new Map(s.joined);
  const doors = new Map(s.doors.map(([x, y, dx, dy]) => [`${x},${y}`, [dx, dy] as [number, number]]));
  const [bw] = [box[2] - box[0] + 1];
  const groundAt = (x: number, y: number) => s.kinds[s.ground[(y - box[1]) * bw + (x - box[0])]];

  // The world within the box as a town, in the fixture's frame: column c,
  // row r, the map turned half round from its far corner. Filled once: the
  // town grid asks after a tile many times over.
  const [x0, y0, x1, y1] = box;
  const [w, h] = [x1 - x0 + 1, y1 - y0 + 1];
  const grid: Tile[] = new Array(w * h);
  const nodes: (ReturnType<typeof roads.get> | undefined)[] = new Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const key = `${x1 - c},${y1 - r}`;
      const t = tiles.get(key);
      const g = t ? undefined : groundAt(x1 - c, y1 - r);
      grid[r * w + c] = t ?? (g === "Water" || g === "Sea" ? WATER : g === "Forest" ? WOOD : OPEN);
      // A road tile's node; none under a building, where a drive ends.
      if (t === ROAD) nodes[r * w + c] = roads.get(key);
    }
  }
  const inside = (c: number, r: number) => c >= 0 && r >= 0 && c < w && r < h;
  const tile = (c: number, r: number): Tile => (inside(c, r) ? grid[r * w + c] : OPEN);
  const road = (c: number, r: number) => (inside(c, r) ? nodes[r * w + c] : undefined);
  // And past the box, what is built there still: so a road running out of
  // the town runs on through its paving's rounded end, not ending at it.
  const beyond = (c: number, r: number) => tiles.get(`${x1 - c},${y1 - r}`);
  const tileOn = (c: number, r: number): Tile => (inside(c, r) ? grid[r * w + c] : (beyond(c, r) ?? OPEN));
  const roadOn = (c: number, r: number) => (inside(c, r) ? nodes[r * w + c] : beyond(c, r) === ROAD ? roads.get(`${x1 - c},${y1 - r}`) : undefined);
  const whole: Town = {
    w,
    h,
    tile,
    linked: (c0, r0, c1, r1) => {
      const [a, b] = [road(c0, r0), road(c1, r1)];
      return !!a && !!b && (a.outgoing.includes(b.id) || a.incoming.includes(b.id));
    },
    through: (c, r) => !!road(c, r)?.road,
    // A building is joined in itself, and to the row the hand drew it
    // in (`Building::joined`); tiles painted apart stand apart.
    joins: (c0, r0, c1, r1) => {
      const [a, b] = [tile(c0, r0).id, tile(c1, r1).id];
      if (a === undefined || b === undefined) return false;
      const [x, y] = [x1 - c1, y1 - r1];
      return a === b || !!joined.get(a)?.some(([tx, ty]) => tx === x && ty === y);
    },
    // Turned half round, so the way to the street is too.
    door: (c, r) => turned(doors.get(`${x1 - c},${y1 - r}`)),
    at: (c, r) => [x1 - c, y1 - r],
  };

  const on: Town = {
    ...whole,
    tile: tileOn,
    linked: (c0, r0, c1, r1) => {
      const [a, b] = [roadOn(c0, r0), roadOn(c1, r1)];
      return !!a && !!b && (a.outgoing.includes(b.id) || a.incoming.includes(b.id));
    },
    through: (c, r) => !!roadOn(c, r)?.road,
  };

  // Each building painted as the shade a surface takes of its colour and
  // which building it is; its colour is the main thread's (`Tints`).
  const paint: Paint = (t, a, b) => [a, b, t.id ?? -1];

  // The whole town, and what it cannot see from its tiles; then a window
  // of it round the chunks to draw, a margin wider, drawn once.
  const known = facts(whole);
  const area: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const key of s.todo) {
    const [cx, cy] = key.split(",").map(Number);
    grow(area, cx * CHUNK, cy * CHUNK);
    grow(area, cx * CHUNK + CHUNK - 1, cy * CHUNK + CHUNK - 1);
  }
  const window = widen(area, MARGIN);
  const [wx0, wy0, wx1, wy1] = window;
  // The window in the whole town's frame: column box[2] - x, row box[3] - y.
  const [c0, r0] = [x1 - wx1, y1 - wy1];
  const [ww, wh] = [wx1 - wx0 + 1, wy1 - wy0 + 1];
  const inWindow = windowOf(whole, c0, r0, ww, wh);
  const { pieces, dressing } = drawTown(inWindow, s.theme, paint, windowFacts(known, c0, r0, ww, wh));
  // The roads, as the paving is cut for them: every tile's asphalt and the
  // lanes off it, overlapping as they are drawn.
  const { street, through } = asphalt(windowOf(on, c0, r0, ww, wh));
  const roadSheet = flatPolygons([...street, ...through, ...dressing.lanes.map((l): Polygon => [l])], 0);
  const roadEdges = roadsOf(roadSheet).edges;
  // A tile's place in the window's drawing: tile x runs over x - wx1 - 1
  // to x - wx1, and so for y.
  const frame = ([fx0, fy0, fx1, fy1]: Bounds): Box => [fx0 - wx1 - 1, fy0 - wy1 - 1, fx1 - wx1, fy1 - wy1];
  // Each piece's triangles filed by the chunks they reach into, so a chunk
  // cuts only its own; the paving's kerbs found once, from the window's
  // whole paving, so a kerb is never where a chunk was cut, and the yards'
  // lines on it.
  const chunkAt = (gx: number, gy: number): [number, number] => [Math.floor((gx + wx1 + 1) / CHUNK), Math.floor((gy + wy1 + 1) / CHUNK)];
  const filed = new Map(pieces.map((p) => [p, fileBy(p.geo, chunkAt, (cx, cy) => `${cx},${cy}`, p.name === "pavement" ? PAVING_PAD : 0)]));
  // And the roads', so a chunk's paving asks only those near it whether a
  // point is on a road.
  const roadsBy = fileBy(roadSheet, chunkAt, (cx, cy) => `${cx},${cy}`, PAVING_PAD);
  const pavement = pieces.find((p) => p.name === "pavement");
  const [kerbs, lines] = [pavement ? kerbsOf(pavement.geo) : [], stripLines(dressing.yardLines)];
  const chunks = s.todo.map((key): ChunkDrawing => {
    const [cx, cy] = key.split(",").map(Number);
    // The chunk, as far as the town reaches into it.
    const cut = frame([Math.max(cx * CHUNK, x0), Math.max(cy * CHUNK, y0), Math.min(cx * CHUNK + CHUNK - 1, x1), Math.min(cy * CHUNK + CHUNK - 1, y1)]);
    // The paving as its own triangles, uncut, those at or near the chunk:
    // drawn as a square over it, cut to them by its texture.
    const own: Piece[] = [...filed].map(([p, byChunk]) => {
      const mine = byChunk.get(key) ?? [];
      if (p !== pavement) return { ...p, geo: clipTo(p.geo, cut, mine) };
      return { ...p, geo: { ...p.geo, indices: mine.flatMap((t) => [p.geo.indices[t], p.geo.indices[t + 1], p.geo.indices[t + 2]]) } };
    });
    // A tree stands on the chunk its middle is on; it is not cut.
    const trees = dressing.trees.filter((t) => {
      const [x, y] = [-t.x, -t.y];
      return x >= cut[0] && x < cut[2] && y >= cut[1] && y < cut[3];
    });
    // Its paving's kerb texture, cut to it by its own triangles, its
    // kerbs and lines the window's.
    const sheet = own.find((p) => p.name === "pavement" && p.geo.indices.length);
    const near = (roadsBy.get(key) ?? []).flatMap((t) => [roadSheet.indices[t], roadSheet.indices[t + 1], roadSheet.indices[t + 2]]);
    const paving = sheet ? kerbTexels(kerbs, cut, { cover: sheet.geo, lines, roads: { sheet: { ...roadSheet, indices: near }, edges: roadEdges } }) : null;
    return { key, pieces: own.filter((p) => p.geo.indices.length), trees: treeInstances(trees, s.theme), cut, paving };
  });
  return { chunks, window };
}
