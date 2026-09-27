import type { BuildingKind, TerrainType } from "../../generated";
import { BLUEPRINTS, FACINGS } from "../../blueprints";

/**
 * A thing's look is decided by what it is next to (`docs/look.md`). A rule
 * names a situation and the piece that answers it; the first rule whose
 * situation holds wins. Rules are written against a frame, the way the
 * piece is drawn: `down` is what the thing answers, `left` and `right` are
 * along it, and every rule is tried mirrored too, so a drawing with its
 * corner on the right serves the corner on the left as well.
 *
 * Four tables, by what the rule is matched on:
 * - **plot**: a building, framed on its street.
 * - **path**: a street between two others, framed on each side it fronts.
 * - **node**: a junction of streets, framed on each arm.
 * - **free**: an open tile of grass. Most stay grass; a few become
 *   something because of what surrounds them.
 */

/** What the rules can see of the map. */
export interface Ground {
  building(x: number, y: number): { kind: BuildingKind; facing: number; size: [number, number] } | undefined;
  /** A street or road on this tile, not a driveway: the steps to the
   *  streets it joins, and whether it is a through road. */
  road(x: number, y: number): { arms: [number, number][]; through: boolean } | undefined;
  terrain(x: number, y: number): TerrainType | undefined;
}

/** A piece put down: which, on which tile, turned and maybe mirrored. */
export interface Placed {
  piece: string;
  x: number;
  y: number;
  rot: number;
  mirror: boolean;
}

type Dir = "down" | "up" | "left" | "right";

/** The ground seen from a frame. */
export interface Lens {
  x: number;
  y: number;
  /** A house on the tile that way; for a plot, one on the same street. */
  home(d: Dir): boolean;
  shop(d: Dir): boolean;
  road(d: Dir): boolean;
  /** A road that is not a through road. */
  street(d: Dir): boolean;
  /** This tile is in the middle of a block (free tiles only). */
  enclosed: boolean;
}

interface Rule {
  pieces: string[];
  when(at: Lens): boolean;
}

const tab = (g: Ground, x: number, y: number) => {
  const b = g.building(x, y);
  return b && BLUEPRINTS[b.kind].tab;
};

export const PLOT: Rule[] = [
  // The corner cut on the diagonal, turned to the junction, and joined to
  // the row it ends.
  { pieces: ["corner-terrace"], when: (at) => at.road("down") && at.road("right") && at.home("left") },
  { pieces: ["corner"], when: (at) => at.road("down") && at.road("right") },
  // Houses shoulder to shoulder are one terrace: one ridge, no gaps.
  { pieces: ["terrace"], when: (at) => at.home("left") && at.home("right") },
  { pieces: ["terrace-end"], when: (at) => at.home("right") },
  { pieces: ["house"], when: () => true },
];

export const PATH: Rule[] = [
  // Homes put trees in their street; shops put lamps. Every other tile.
  { pieces: ["street-tree"], when: (at) => at.home("down") && (at.x + at.y) % 2 === 0 },
  { pieces: ["lamp"], when: (at) => at.shop("down") && (at.x + at.y) % 2 === 0 },
];

export const NODE: Rule[] = [
  // A zebra across every street that meets a junction; a through road is
  // crossed at lights, not stripes.
  { pieces: ["crossing"], when: (at) => at.street("down") },
];

export const FREE: Rule[] = [
  // Where the backs of a block meet, the middle is a garden.
  { pieces: ["garden-1", "garden-2", "garden-2", "garden-3"], when: (at) => at.enclosed },
  // A single gap in a row of houses is a pocket green on the street.
  { pieces: ["pocket"], when: (at) => at.street("down") && at.home("left") && at.home("right") },
];

/** The turn that brings a drawing's `down` round to a grid step. */
const turn = ([dx, dy]: [number, number]) => Math.atan2(dx, -dy);

/**
 * The side a building's street is on. A building with a lot is laid out
 * facing it; one without (a house) is given any facing that reaches a
 * street, so its frame is the first side a street is on instead.
 */
function front(g: Ground, x: number, y: number): [number, number] | undefined {
  const b = g.building(x, y);
  if (!b) return undefined;
  if (b.size[0] !== 1 || b.size[1] !== 1) return FACINGS[b.facing % 4];
  return FACINGS.find(([dx, dy]) => g.road(x + dx, y + dy)) ?? FACINGS[b.facing % 4];
}

function lens(g: Ground, x: number, y: number, down: [number, number], mirror: boolean, enclosed: boolean, fronting = false): Lens {
  const rot = turn(down);
  const [c, s] = [Math.cos(rot), Math.sin(rot)];
  // A drawing's direction comes across half turned (see `raise`), mirrored
  // first if the piece is, then turned by the frame.
  const step = (d: Dir): [number, number] => {
    const [sx, sy] = { down: [0, 1], up: [0, -1], left: [-1, 0], right: [1, 0] }[d];
    const [lx, ly] = [mirror ? sx : -sx, -sy];
    return [x + Math.round(lx * c - ly * s), y + Math.round(lx * s + ly * c)];
  };
  return {
    x, y, enclosed,
    home: (d) => {
      const [hx, hy] = step(d);
      if (g.building(hx, hy)?.kind !== "House") return false;
      const f = front(g, hx, hy)!;
      return !fronting || (f[0] === down[0] && f[1] === down[1]);
    },
    shop: (d) => tab(g, ...step(d)) === "shops",
    road: (d) => !!g.road(...step(d)),
    street: (d) => g.road(...step(d))?.through === false,
  };
}

/** Pick one of a rule's pieces, the same one for a tile every time. */
function pick(pieces: string[], x: number, y: number) {
  const h = Math.imul(x * 73856093 ^ y * 19349663, 0x85ebca6b) >>> 0;
  return pieces[h % pieces.length];
}

function first(rules: Rule[], g: Ground, x: number, y: number, down: [number, number], enclosed = false, fronting = false): Placed | null {
  for (const rule of rules) {
    for (const mirror of [false, true]) {
      if (rule.when(lens(g, x, y, down, mirror, enclosed, fronting))) {
        return { piece: pick(rule.pieces, x, y), x, y, rot: turn(down), mirror };
      }
    }
  }
  return null;
}

/** The piece a house draws, framed on its street. */
export function plotPiece(g: Ground, x: number, y: number): Placed {
  return first(PLOT, g, x, y, front(g, x, y)!, false, true)!;
}

const AXES: [number, number][] = [[0, 1], [1, 0], [0, -1], [-1, 0]];

/**
 * What a tile that is not a building draws: a street by what fronts it, a
 * junction on each of its arms, open grass by what surrounds it. `enclosed`
 * says the tile is in a block's middle, which only the caller, holding the
 * whole block, can know.
 */
export function dress(g: Ground, x: number, y: number, enclosed: boolean): Placed[] {
  if (g.building(x, y)) return [];
  const road = g.road(x, y);
  if (road) {
    const { arms } = road;
    if (arms.length >= 3) return arms.flatMap((a) => first(NODE, g, x, y, a) ?? []);
    const [a, b] = arms;
    if (road.through || arms.length !== 2 || a[0] !== -b[0] || a[1] !== -b[1]) return [];
    const across: [number, number] = [-a[1], a[0]];
    return [across, [-across[0], -across[1]] as [number, number]].flatMap((d) => first(PATH, g, x, y, d) ?? []);
  }
  if (g.terrain(x, y) !== "Grass") return [];
  for (const d of AXES) {
    const p = first(FREE, g, x, y, d, enclosed);
    if (p) return [p];
  }
  return [];
}

/** Free, as a block's middle counts it: grass with nothing on it. */
export const open = (g: Ground, x: number, y: number) => !g.building(x, y) && !g.road(x, y) && g.terrain(x, y) === "Grass";

/** The biggest a block's middle can be before it is open country. */
export const BLOCK = 40;

/**
 * The open tiles joined to this one, and whether they make a block's
 * middle: closed in, small, and backed onto by a building somewhere.
 * An open run stops counting at `BLOCK`, so wild land costs little.
 */
export function block(g: Ground, x: number, y: number): { tiles: [number, number][]; enclosed: boolean } {
  const seen = new Set([`${x},${y}`]);
  const tiles: [number, number][] = [[x, y]];
  let built = false;
  for (let i = 0; i < tiles.length; i++) {
    if (tiles.length > BLOCK) return { tiles, enclosed: false };
    const [tx, ty] = tiles[i];
    for (const [dx, dy] of AXES) {
      const [nx, ny] = [tx + dx, ty + dy];
      const k = `${nx},${ny}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (g.terrain(nx, ny) === undefined) return { tiles, enclosed: false };
      if (open(g, nx, ny)) tiles.push([nx, ny]);
      else if (g.building(nx, ny)) built = true;
    }
  }
  return { tiles, enclosed: built };
}
