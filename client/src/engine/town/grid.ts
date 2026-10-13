import type { BuildingKind, GridCoord } from "../../generated";
import { FACINGS, gateOf, kerbed, plot, yardOf } from "../../blueprints";

/**
 * The town as the look sees it: a grid of tiles, each one kind of thing,
 * built up some storeys, and the road links between them. Where a car
 * parks and which way a door faces are the simulation's: the look is
 * told a building's door and which of its tiles are its yard, and decides
 * the rest from the neighbours alone.
 *
 * Coordinates are the fixture's: column east, row south, the tile (c, r)
 * running from c to c + 1 and r to r + 1.
 */
export type Ground = "open" | "paved" | "road" | "water" | "wood";

/** Which way a link is driven, from where it is seen: both ways, out, in,
 *  or both ways on two one-ways a median apart, a divided road. */
export type Flow = "t" | "o" | "i" | "v";

export interface Tile {
  /** A building's kind, or the ground's. */
  kind: BuildingKind | Ground;
  storeys: number;
  /** Which building it is. */
  id?: number;
  /** Part of its building's yard, as the server lays it out
   *  (`World::yard_of`): paved, its docks against the building. */
  yard?: boolean;
}

export interface Town {
  w: number;
  h: number;
  tile(c: number, r: number): Tile;
  /** Two road tiles, beside or diagonal, that a street runs between. */
  linked(c0: number, r0: number, c1: number, r1: number): boolean;
  /** A road tile on a through road. */
  through(c: number, r: number): boolean;
  /** Which way traffic runs on the link from one road tile to the next
   *  (`Flow`). Unset, both. */
  flow?(c0: number, r0: number, c1: number, r1: number): Flow;
  /** A junction with traffic lights. */
  light?(c: number, r: number): boolean;
  /** Two built tiles, beside or diagonal, joined into one building, as the
   *  brush stroke that painted them ran; unset, the look joins tiles of a
   *  kind by its own rule (`footprint.ts`). */
  joins?(c0: number, r0: number, c1: number, r1: number): boolean;
  /** The way from a built tile to the street its door opens onto, if
   *  that tile is its door: the server's (`Building.door`), or a
   *  fixture's as the server's loader finds it (`parseTown`). */
  door?(c: number, r: number): [number, number] | undefined;
  /** Where a tile is on the map, for what is placed by where it is — every
   *  third street tile's tree, a tree's shade — so it stays put however
   *  the town is framed; unset, where it is in this town. */
  at?(c: number, r: number): [number, number];
}

export const LETTERS: Record<string, BuildingKind> = {
  H: "House", A: "Apartment", S: "Shop", O: "Office", F: "Factory",
  G: "GasStation", M: "Supermarket", D: "Depot", P: "Harbour", W: "Sawmill", Q: "Quarry",
};

/** How tall each kind is built. One height for a kind: a height picked per
 *  tile is a chequerboard of steps across every block. Heights that vary
 *  come with success, and by hand in the sandbox. */
const STOREYS: Partial<Record<BuildingKind, number>> = {
  House: 2, Apartment: 5, Shop: 2, Office: 6, Factory: 1, Depot: 1, Supermarket: 1, GasStation: 1, Sawmill: 1, Quarry: 1,
};

const GROUND = new Set(["open", "paved", "road", "water", "wood"]);
export const isBuilt = (t: Tile) => !GROUND.has(t.kind);

/** How many storeys a kind is built. */
export const storeysOf = (kind: BuildingKind) => STOREYS[kind] ?? 1;

export function tileOf(ch: string): Tile {
  // A building's letter, its yard's small, as `/map` writes the game's.
  const kind = LETTERS[ch.toUpperCase()];
  if (kind) return ch === ch.toUpperCase() ? { kind, storeys: storeysOf(kind) } : { kind, storeys: storeysOf(kind), yard: true };
  const ground: Ground = ch === "=" || ch === "#" ? "road" : ch === "~" || ch === "≈" ? "water" : ch === "T" ? "wood" : ch === ":" ? "paved" : "open";
  return { kind: ground, storeys: 0 };
}

const OPEN: Tile = { kind: "open", storeys: 0 };

/**
 * A town from a fixture's text (`server/fixtures/*.txt`). Roads join as the
 * server lays them: every road tile to the road tiles beside it, and to
 * those on its diagonals where no tile beside both already joins them.
 */
export function parseTown(text: string): Town & { rows: string[] } {
  const rows = text.split("\n").filter((l) => l.trim() && !l.startsWith("#")).map((l) => l.replace(/\s/g, ""));
  const w = Math.max(...rows.map((r) => r.length));
  const tiles = rows.map((row) => Array.from({ length: w }, (_, c) => tileOf(row[c] ?? ".")));
  // Each building as the server raises a fixture's (`fixtures.rs`): a
  // kind a tile big a building a tile, any other a run of its letter,
  // beside or diagonal; its yard where its small letters are, or else
  // toward the first side with a street.
  let next = 0;
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < w; c++) {
      const t = tiles[r][c];
      if (!isBuilt(t) || t.id !== undefined) continue;
      const kind = t.kind as BuildingKind;
      const id = next++;
      t.id = id;
      const run: GridCoord[] = [{ x: c, y: r }];
      const [pw, ph] = plot(kind, 0).size;
      for (let i = 0; i < run.length && pw * ph > 1; i++) {
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const [x, y] = [run[i].x + dc, run[i].y + dr];
            const n = tiles[y]?.[x];
            if (n?.kind === kind && n.id === undefined) (n.id = id), run.push({ x, y });
          }
        }
      }
      const road = (x: number, y: number) => tiles[y]?.[x]?.kind === "road";
      const fronts = (f: number) => yardOf(run, kind, f)?.some((q) => road(q.x + FACINGS[f][0], q.y + FACINGS[f][1]));
      if (run.some((q) => tiles[q.y][q.x].yard)) continue;
      const facing = [0, 1, 2, 3].find(fronts);
      for (const q of facing === undefined ? [] : yardOf(run, kind, facing)!) tiles[q.y][q.x].yard = true;
    }
  }
  return townOf(tiles, (c, r) => rows[r]?.[c] === "#", rows);
}

/** A town of these tiles. Its doors are found as the server's loader finds
 *  a fixture's (`doorsOf`). */
export function townOf(
  tiles: Tile[][],
  through: (c: number, r: number) => boolean,
  rows: string[] = [],
  joins?: (c0: number, r0: number, c1: number, r1: number) => boolean,
): Town & { rows: string[] } {
  const h = tiles.length, w = tiles[0]?.length ?? 0;
  const tile = (c: number, r: number) => tiles[r]?.[c] ?? OPEN;
  const road = (c: number, r: number) => tile(c, r).kind === "road";
  let doors: Map<string, [number, number]> | undefined;
  const town: Town & { rows: string[] } = {
    w, h, rows, tile, through, joins,
    linked(c0, r0, c1, r1) {
      const [dc, dr] = [c1 - c0, r1 - r0];
      if (!road(c0, r0) || !road(c1, r1) || Math.max(Math.abs(dc), Math.abs(dr)) !== 1) return false;
      return dc === 0 || dr === 0 || (!road(c0 + dc, r0) && !road(c0, r0 + dr));
    },
    door: (c, r) => (doors ??= doorsOf(town)).get(`${c},${r}`),
  };
  return town;
}

const SIDES: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];
const CORNERS: [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const EIGHT: [number, number][] = [...SIDES, ...CORNERS];

/**
 * Each door as the server's loader finds it (`World::driveway_for`), the
 * way from its tile to its street: a house's on the first side a street
 * runs straight past, or else on the diagonal where a drive meets its
 * street square, not at a hairpin; a yard's gate from a street ahead of
 * it, by its gate (`World::enters`), beside first; anything else's on the first side a
 * street runs past, the side it parks on first (`baysOf`).
 */
function doorsOf(town: Town): Map<string, [number, number]> {
  const doors = new Map<string, [number, number]>();
  const street = (x: number, y: number) => town.tile(x, y).kind === "road" && !town.through(x, y);
  const square = (x: number, y: number, fx: number, fy: number) =>
    EIGHT.every(([dx, dy]) => !town.linked(x, y, x + dx, y + dy) || dx * fx + dy * fy >= 0) && EIGHT.some(([dx, dy]) => town.linked(x, y, x + dx, y + dy));
  const yarded = new Set<number>();
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      const t = town.tile(c, r);
      if (t.yard && t.id !== undefined) yarded.add(t.id);
      if (t.kind !== "House") continue;
      const door =
        SIDES.find(([fx, fy]) => street(c + fx, r + fy) && (town.linked(c + fx, r + fy, c + fx - fy, r + fy + fx) || town.linked(c + fx, r + fy, c + fx + fy, r + fy - fx))) ??
        CORNERS.find(([fx, fy]) => street(c + fx, r + fy) && square(c + fx, r + fy, fx, fy));
      if (door) doors.set(`${c},${r}`, door);
    }
  }
  // One that parks at the kerb: the first street beside it, its tiles and
  // ways in the server's order, which is this frame's turned half round.
  const kerbside = new Set<number>();
  for (let r = town.h - 1; r >= 0; r--) {
    for (let c = town.w - 1; c >= 0; c--) {
      const t = town.tile(c, r);
      if (!isBuilt(t) || !kerbed(t.kind as BuildingKind) || t.id === undefined || kerbside.has(t.id)) continue;
      const way = ([[1, 0], [0, 1], [0, -1], [-1, 0]] as [number, number][]).find(([dx, dy]) => street(c + dx, r + dy));
      if (way) doors.set(`${c},${r}`, way), kerbside.add(t.id);
    }
  }
  for (const id of yarded) {
    const run: GridCoord[] = [];
    for (let r = 0; r < town.h; r++) for (let c = 0; c < town.w; c++) if (isBuilt(town.tile(c, r)) && town.tile(c, r).id === id) run.push({ x: c, y: r });
    const kind = town.tile(run[0].x, run[0].y).kind as BuildingKind;
    const marked = run.filter((q) => town.tile(q.x, q.y).yard);
    const facing = [0, 1, 2, 3].find((f) => {
      const yard = yardOf(run, kind, f);
      return yard?.length === marked.length && marked.every((q) => yard.some((p) => p.x === q.x && p.y === q.y));
    });
    if (facing === undefined) continue;
    const [fx, fy] = FACINGS[facing];
    const gate = gateOf(run, kind, facing);
    const on = (x: number, y: number) => run.some((q) => q.x === x && q.y === y);
    const enters = ({ x, y }: GridCoord, [dx, dy]: [number, number]) =>
      dx * fx + dy * fy > 0 && !on(x + dx, y + dy) && street(x + dx, y + dy) && (!dx || !dy || (!on(x + dx, y) && !on(x, y + dy) && square(x + dx, y + dy, dx, dy)));
    for (const way of EIGHT) {
      const q = marked.find((q) => q.x === gate?.x && q.y === gate.y && enters(q, way));
      if (!q) continue;
      doors.set(`${q.x},${q.y}`, way);
      break;
    }
  }
  return doors;
}


/** A town seen through a window from column x0, row y0: its tiles within,
 *  open ground beyond, and nothing joined or linked across the frame. */
export function windowOf(town: Town, x0: number, y0: number, w: number, h: number): Town {
  const inside = (c: number, r: number) => c >= 0 && r >= 0 && c < w && r < h;
  return {
    w,
    h,
    tile: (c, r) => (inside(c, r) ? town.tile(c + x0, r + y0) : OPEN),
    linked: (a, b, c, d) => inside(a, b) && inside(c, d) && town.linked(a + x0, b + y0, c + x0, d + y0),
    through: (c, r) => inside(c, r) && town.through(c + x0, r + y0),
    flow: town.flow && ((a, b, c, d) => town.flow!(a + x0, b + y0, c + x0, d + y0)),
    joins: town.joins && ((a, b, c, d) => inside(a, b) && inside(c, d) && town.joins!(a + x0, b + y0, c + x0, d + y0)),
    door: town.door && ((c, r) => (inside(c, r) ? town.door!(c + x0, r + y0) : undefined)),
    at: (c, r) => (town.at ? town.at(c + x0, r + y0) : [c + x0, r + y0]),
  };
}
