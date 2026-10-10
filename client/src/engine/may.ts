import { lie, plot } from "../blueprints";
import type { Build, Building, BuildingKind, GameObjectEntry, GridCoord, Mark, RoadNode, TerrainType, Tool } from "../generated";

/**
 * Where the mayor's hand may go, worked out here rather than asked of the
 * server: the brush asks it of every tile in view and of every step a drag
 * takes, and the client holds everything the answer needs. It mirrors the
 * server's rule (`game_loop::may` and what it calls); the server keeps
 * its own and refuses a step by it, so where the two part the server wins
 * and the dots are only wrong.
 *
 * The hand sees the world as it will be once its draft is built: its own
 * drafted roads and buildings stand in it, so a house may be drawn beside a
 * drafted street, and the tiles of anyone else's draft are taken.
 */
export interface Hand {
  roads: Map<string, { id: number; node: RoadNode }>;
  /** Where each road node stands, by id. */
  at: Map<number, GridCoord>;
  occupied: Map<string, Building>;
  /** Tiles someone else's draft is drawn on. */
  taken: Set<string>;
  ground: (x: number, y: number) => TerrainType | undefined;
}

const key = (x: number, y: number) => `${x},${y}`;

/** The world as the hand sees it, read once a change, with our own draft
 *  drawn into it and everyone else's taken. */
export function hand(each: (f: (e: GameObjectEntry) => void) => void, ground: Hand["ground"], mine: Mark[] = [], theirs: Mark[] = []): Hand {
  const h: Hand = { roads: new Map(), at: new Map(), occupied: new Map(), taken: new Set(), ground };
  each((e) => {
    if (e.object.kind === "RoadNode" && e.position) {
      h.roads.set(key(e.position.x, e.position.y), { id: e.id, node: e.object.data });
      h.at.set(e.id, e.position);
    } else if (e.object.kind === "Building") {
      for (const t of e.object.data.tiles) h.occupied.set(key(t.x, t.y), e.object.data);
    }
  });
  for (const { step } of theirs) for (const t of lays(step)) h.taken.add(key(t.x, t.y));
  // Drafted roads as nodes of their own, numbered below every real one.
  let next = -1;
  const node = (t: GridCoord) => {
    const k = key(t.x, t.y);
    let n = h.roads.get(k);
    if (!n) {
      n = { id: next--, node: { outgoing: [], incoming: [], joined: false, road: false, laid: true } };
      h.roads.set(k, n);
      h.at.set(n.id, t);
    }
    return n;
  };
  for (const { step } of mine) {
    const { tool, from, to } = step;
    if (typeof tool !== "string") {
      if (!h.occupied.has(key(to.x, to.y))) h.occupied.set(key(to.x, to.y), { kind: tool.Building, tiles: [to], facing: 2, stocks: {}, site: null, park: [], rules: {}, standing: false, selling: [], lorries: 0, land: [], ruts: [], joined: [], door: null });
    } else if (tool !== "Demolish" && !h.occupied.has(key(to.x, to.y))) {
      const [a, b] = [node(from), node(to)];
      a.node.road ||= tool === "Road";
      b.node.road ||= tool === "Road";
      a.node.outgoing.push(b.id);
      (tool === "OneWay" ? b.node.incoming : b.node.outgoing).push(a.id);
    }
  }
  return h;
}

/** The tiles a step lays something on: a road's two, a building's one. */
export function lays({ tool, from, to }: Build): GridCoord[] {
  return tool === "Demolish" ? [] : typeof tool === "string" ? [from, to] : [to];
}

/** The steps out of a tile, as the brush numbers them: east and on round toward +y. */
export const STEPS: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/** The step a way points, as its index in `STEPS`. */
export function snap(dx: number, dy: number): number {
  return ((Math.round((Math.atan2(dy, dx) * 4) / Math.PI) % 8) + 8) % 8;
}

/** May the hand take this step with this tool: the world's rule. */
export function may(h: Hand, tool: Tool, from: GridCoord, to: GridCoord): boolean {
  if (lays({ tool, from, to }).some((t) => h.taken.has(key(t.x, t.y)))) return false;
  if (typeof tool !== "string") {
    const kind = tool.Building;
    return mayPaint(h, kind, from, to) && wouldBeReached(h, kind, from, to);
  }
  if (tool === "Demolish") {
    if (from.x === to.x && from.y === to.y) return h.roads.has(key(to.x, to.y)) || h.occupied.has(key(to.x, to.y));
    return linked(h, from, to);
  }
  // Into a building is its door, and a through road is no door.
  if (tool === "Road" && h.occupied.has(key(to.x, to.y))) return false;
  return mayLay(h, from, to, tool === "OneWay");
}

/** May a drag start here: a tap that builds, or a step out that may be taken. */
export function mayStart(h: Hand, tool: Tool, at: GridCoord): boolean {
  if (may(h, tool, at, at)) return true;
  // Or any step out of it: a road's first, or painting on from a building
  // of the kind. What is taken away is taken where it stands.
  return tool !== "Demolish" && STEPS.some(([dx, dy]) => may(h, tool, at, { x: at.x + dx, y: at.y + dy }));
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

/** `World::link_between`: is anything joining two tiles beside each
 *  other for the demolisher to cut: a road, a door, a row of houses. */
function linked(h: Hand, a: GridCoord, b: GridCoord): boolean {
  if (Math.abs(a.x - b.x) > 1 || Math.abs(a.y - b.y) > 1) return false;
  if (connected(h, a, b)) return true;
  const [on_a, on_b] = [h.occupied.get(key(a.x, a.y)), h.occupied.get(key(b.x, b.y))];
  const same = (p: GridCoord, q: GridCoord) => p.x === q.x && p.y === q.y;
  const door = (bd: Building | undefined, tile: GridCoord, street: GridCoord) => !!bd?.door && same(bd.door.tile, tile) && same(bd.door.street, street);
  if (door(on_a, a, b) || door(on_b, b, a)) return true;
  return !!on_a && !!on_b && on_a !== on_b && on_a.joined.some((t) => same(t, b));
}

/** `World::may_lay`. */
function mayLay(h: Hand, from: GridCoord, to: GridCoord, oneWay: boolean): boolean {
  const [dx, dy] = [to.x - from.x, to.y - from.y];
  if ((dx === 0 && dy === 0) || Math.abs(dx) > 1 || Math.abs(dy) > 1) return false;
  // Not over water, down onto a beach or up a mountain, unless a road
  // already stands there.
  const wet = (t: GridCoord) => {
    const g = h.ground(t.x, t.y);
    return !nodeAt(h, t) && (g === "Water" || g === "Sea" || g === "Beach" || g === "Mountain");
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

const land = (g: TerrainType | undefined) => g === "Grass" || g === "Forest";

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
