import type { BuildingKind } from "../../generated";

/**
 * The town as the look sees it: a grid of tiles, each one kind of thing,
 * built up some storeys, and the road links between them. Nothing about who
 * owns what, where a car parks or which way a door faces: those are the
 * simulation's, and the look is decided by the neighbours alone.
 *
 * Coordinates are the fixture's: column east, row south, the tile (c, r)
 * running from c to c + 1 and r to r + 1.
 */
export type Ground = "open" | "paved" | "road" | "water" | "wood";

export interface Tile {
  /** A building's kind, or the ground's. */
  kind: BuildingKind | Ground;
  storeys: number;
  /** Which building the tile is part of, where that is known: two sheds
   *  painted side by side are two sheds. Unknown, tiles of a family join. */
  id?: number;
}

export interface Town {
  w: number;
  h: number;
  tile(c: number, r: number): Tile;
  /** Two road tiles, beside or diagonal, that a street runs between. */
  linked(c0: number, r0: number, c1: number, r1: number): boolean;
  /** A road tile on a through road. */
  through(c: number, r: number): boolean;
  /** Two built tiles, beside or diagonal, joined into one building, as the
   *  brush stroke that painted them ran; unset, the look joins tiles of a
   *  kind by its own rule (`footprint.ts`). */
  joins?(c0: number, r0: number, c1: number, r1: number): boolean;
}

export const LETTERS: Record<string, BuildingKind> = {
  H: "House", A: "Apartment", S: "Shop", O: "Office", W: "Workshop", F: "Factory",
  R: "Restaurant", B: "Bar", G: "GasStation", M: "Supermarket", D: "Warehouse",
};

/** How tall each kind is built. One height for a kind: a height picked per
 *  tile is a chequerboard of steps across every block. Heights that vary
 *  come with success, and by hand in the sandbox. */
const STOREYS: Partial<Record<BuildingKind, number>> = {
  House: 2, Apartment: 5, Shop: 2, Restaurant: 2, Bar: 2, Office: 6, Workshop: 1, Factory: 1, Warehouse: 1, Supermarket: 1, GasStation: 1,
};

export const isBuilt = (t: Tile) => !["open", "paved", "road", "water", "wood"].includes(t.kind);

export function tileOf(ch: string): Tile {
  const kind = LETTERS[ch];
  if (kind) return { kind, storeys: STOREYS[kind] ?? 1 };
  const ground: Ground = ch === "=" || ch === "#" ? "road" : ch === "~" ? "water" : ch === "T" ? "wood" : ch === ":" ? "paved" : "open";
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
  const h = rows.length;
  const tiles = rows.map((row) => Array.from({ length: w }, (_, c) => tileOf(row[c] ?? ".")));
  return townOf(tiles, (c, r) => rows[r]?.[c] === "#", rows);
}

export function townOf(
  tiles: Tile[][],
  through: (c: number, r: number) => boolean,
  rows: string[] = [],
  joins?: (c0: number, r0: number, c1: number, r1: number) => boolean,
): Town & { rows: string[] } {
  const h = tiles.length, w = tiles[0]?.length ?? 0;
  const tile = (c: number, r: number) => tiles[r]?.[c] ?? OPEN;
  const road = (c: number, r: number) => tile(c, r).kind === "road";
  return {
    w, h, rows, tile, through, joins,
    linked(c0, r0, c1, r1) {
      const [dc, dr] = [c1 - c0, r1 - r0];
      if (!road(c0, r0) || !road(c1, r1) || Math.max(Math.abs(dc), Math.abs(dr)) !== 1) return false;
      return dc === 0 || dr === 0 || (!road(c0 + dc, r0) && !road(c0, r0 + dr));
    },
  };
}
