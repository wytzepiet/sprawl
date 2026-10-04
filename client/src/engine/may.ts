import { BLUEPRINTS, lie, plot } from "../blueprints";
import type { Building, BuildingKind, Effect, GameObjectEntry, GridCoord, Growth, RoadNode, TerrainType, Tool } from "../generated";

/**
 * Where the mayor's hand may go, worked out here rather than asked of the
 * server: the brush asks it of every tile in view and of every step a drag
 * takes, and the client holds everything the answer needs. It mirrors the
 * server's rule (`game_loop::may` and what it calls); the server keeps
 * its own and refuses a step by it, so where the two part the server wins
 * and the dots are only wrong.
 */
export interface Hand {
  roads: Map<string, { id: number; node: RoadNode }>;
  /** Where each road node stands, by id. */
  at: Map<number, GridCoord>;
  occupied: Map<string, Building>;
  ground: (x: number, y: number) => TerrainType | undefined;
  growth: Growth;
  /** Has the build opened this (`state/tree`'s `unlocked`)? */
  opened: (want: (e: Effect) => boolean) => boolean;
}

const key = (x: number, y: number) => `${x},${y}`;

/** The world as the hand sees it, read once a change. */
export function hand(each: (f: (e: GameObjectEntry) => void) => void, ground: Hand["ground"], growth: Growth, opened: Hand["opened"]): Hand {
  const h: Hand = { roads: new Map(), at: new Map(), occupied: new Map(), ground, growth, opened };
  each((e) => {
    if (e.object.kind === "RoadNode" && e.position) {
      h.roads.set(key(e.position.x, e.position.y), { id: e.id, node: e.object.data });
      h.at.set(e.id, e.position);
    } else if (e.object.kind === "Building") {
      for (const t of e.object.data.tiles) h.occupied.set(key(t.x, t.y), e.object.data);
    }
  });
  return h;
}

/** The steps out of a tile, as the brush numbers them: east and on round toward +y. */
export const STEPS: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/** The step a way points, as its index in `STEPS`. */
export function snap(dx: number, dy: number): number {
  return ((Math.round((Math.atan2(dy, dx) * 4) / Math.PI) % 8) + 8) % 8;
}

/** May the hand take this step with this tool: the build's gate, then the world's rule. */
export function may(h: Hand, tool: Tool, from: GridCoord, to: GridCoord): boolean {
  if (typeof tool !== "string") {
    const kind = tool.Building;
    return h.opened((e) => e.kind === "Building" && e.building === kind) && affords(h.growth, kind) && mayPaint(h, kind, from, to) && wouldBeReached(h, kind, from, to);
  }
  if (tool === "Demolish") return h.roads.has(key(to.x, to.y)) || h.occupied.has(key(to.x, to.y));
  const want = tool === "OneWay" ? "OneWay" : tool === "Road" ? "Road" : null;
  if (want && !h.opened((e) => e.kind === want)) return false;
  // Each end not standing yet is a tile laid.
  const fresh = +!h.roads.has(key(from.x, from.y)) + +!h.roads.has(key(to.x, to.y));
  return fresh <= h.growth.road_tiles_left && mayLay(h, from, to, tool === "OneWay");
}

/** Can the purse pay for a tile of a kind: its price shared over the
 *  smallest of it. The table's price; the build's discounts are the
 *  server's, so this may say no a little early. */
export function affords(growth: Growth, kind: BuildingKind): boolean {
  const [w, d] = plot(kind, 0).size;
  return growth.treasury >= BLUEPRINTS[kind].price / (w * d);
}

/** May a drag start here: a tap that builds, or for a road any step out. */
export function mayStart(h: Hand, tool: Tool, at: GridCoord): boolean {
  if (typeof tool === "string" && tool !== "Demolish") return STEPS.some(([dx, dy]) => may(h, tool, at, { x: at.x + dx, y: at.y + dy }));
  return may(h, tool, at, at);
}

const nodeAt = (h: Hand, t: GridCoord) => h.roads.get(key(t.x, t.y));

function arms(node: RoadNode, outgoingOnly: boolean): number[] {
  return outgoingOnly ? node.outgoing : [...node.outgoing, ...node.incoming];
}

/** Would an arm this way meet one already here at sharper than a right angle? */
function tooSharp(h: Hand, at: GridCoord, dx: number, dy: number, outgoingOnly: boolean): boolean {
  const here = nodeAt(h, at);
  if (!here) return false;
  return arms(here.node, outgoingOnly).some((id) => {
    const p = h.at.get(id);
    return !!p && (p.x - at.x) * dx + (p.y - at.y) * dy > 0;
  });
}

function connected(h: Hand, a: GridCoord, b: GridCoord): boolean {
  const [na, nb] = [nodeAt(h, a), nodeAt(h, b)];
  return !!na && !!nb && (na.node.outgoing.includes(nb.id) || na.node.incoming.includes(nb.id));
}

/** `World::may_lay`. */
function mayLay(h: Hand, from: GridCoord, to: GridCoord, oneWay: boolean): boolean {
  const [dx, dy] = [to.x - from.x, to.y - from.y];
  if ((dx === 0 && dy === 0) || Math.abs(dx) > 1 || Math.abs(dy) > 1) return false;
  // Not over water or up a mountain, unless a road already stands there.
  const wet = (t: GridCoord) => {
    const g = h.ground(t.x, t.y);
    return !nodeAt(h, t) && (g === "Water" || g === "Sea" || g === "Mountain");
  };
  if (wet(from) || wet(to)) return false;
  // A road may end on a plot, never start on one.
  if (h.occupied.has(key(from.x, from.y))) return false;
  const into = h.occupied.get(key(to.x, to.y));
  if (into && !mayEnter(into.tiles, yardOf(into.tiles, into.kind, into.facing) ?? into.tiles, from, to)) return false;
  if (connected(h, from, to)) return false;
  if (dx !== 0 && dy !== 0 && connected(h, { x: from.x + dx, y: from.y }, { x: from.x, y: from.y + dy })) return false;
  if (oneWay) return !tooSharp(h, from, dx, dy, true);
  return !tooSharp(h, from, dx, dy, false) && (!!into || !tooSharp(h, to, -dx, -dy, false));
}

/** `World::may_enter`: onto an entrance from off the plot, beside it, or
 *  on the diagonal only outward from a corner. */
function mayEnter(tiles: GridCoord[], entrances: GridCoord[], from: GridCoord, to: GridCoord): boolean {
  const on = (x: number, y: number) => tiles.some((t) => t.x === x && t.y === y);
  if (!entrances.some((t) => t.x === to.x && t.y === to.y) || !on(to.x, to.y) || on(from.x, from.y)) return false;
  const [dx, dy] = [from.x - to.x, from.y - to.y];
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) return false;
  return dx === 0 || dy === 0 || (!on(to.x + dx, to.y) && !on(to.x, to.y + dy));
}

/** `World::yard_of`. */
function yardOf(tiles: GridCoord[], kind: BuildingKind, facing: number): GridCoord[] | null {
  const xs = tiles.map((t) => t.x), ys = tiles.map((t) => t.y);
  const [x0, y0] = [Math.min(...xs), Math.min(...ys)];
  const { lot } = lie(kind, facing, [Math.max(...xs) - x0 + 1, Math.max(...ys) - y0 + 1]);
  if (!lot) return null;
  const [[lx, ly], [lw, ld]] = lot;
  return tiles.filter((t) => t.x >= x0 + lx && t.x < x0 + lx + lw && t.y >= y0 + ly && t.y < y0 + ly + ld);
}

const land = (g: TerrainType | undefined) => g === "Grass" || g === "Beach" || g === "Forest";

/** `World::may_paint`: open ground, or another of the kind to join or
 *  link to the one the step came from. */
function mayPaint(h: Hand, kind: BuildingKind, from: GridCoord, to: GridCoord): boolean {
  const there = h.occupied.get(key(to.x, to.y));
  if (there) {
    const here = drawnFrom(h, kind, from, to);
    return !!here && here !== there && there.kind === kind && (grows(kind) || !here.joined.some((t) => t.x === to.x && t.y === to.y));
  }
  const node = nodeAt(h, to);
  // Open land, or a road's dead end: a driveway the building stands over.
  return land(h.ground(to.x, to.y)) && (!node || new Set(arms(node.node, false)).size <= 1);
}

/** `World::would_be_reached`: one standing there, joined or linked to;
 *  grown on to one of its kind; or, new, on a tile a street may run a
 *  drive to. */
function wouldBeReached(h: Hand, kind: BuildingKind, from: GridCoord, to: GridCoord): boolean {
  if (h.occupied.has(key(to.x, to.y)) || (grows(kind) && drawnFrom(h, kind, from, to)) || nodeAt(h, to)) return true;
  for (const [dx, dy] of STEPS) {
    const n = { x: to.x + dx, y: to.y + dy };
    const street = nodeAt(h, n);
    // A street: not a through road, nor a drive on somebody's tile.
    if (street && !street.node.road && !h.occupied.has(key(n.x, n.y)) && !tooSharp(h, n, -dx, -dy, false)) return true;
  }
  return false;
}

/** The building of the kind on `from` beside `to`: what a step to `to` carries on from. */
function drawnFrom(h: Hand, kind: BuildingKind, from: GridCoord, to: GridCoord): Building | undefined {
  const beside = Math.abs(from.x - to.x) <= 1 && Math.abs(from.y - to.y) <= 1 && (from.x !== to.x || from.y !== to.y);
  const b = h.occupied.get(key(from.x, from.y));
  return beside && b?.kind === kind ? b : undefined;
}

/** Does a kind grow into one building, or stand one a tile, linked to its row. */
function grows(kind: BuildingKind): boolean {
  const [w, d] = plot(kind, 0).size;
  return w * d !== 1;
}
