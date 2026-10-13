import { BLUEPRINTS, FACINGS, gateOf, kerbed, plot, sideOf, yardOf } from "../blueprints";
import type { Building, BuildingKind, GameObjectEntry, GridCoord, RoadNode, TerrainType, Tool } from "../generated";

/**
 * Where the mayor's hand may go, worked out here rather than asked of the
 * server: the brush asks it of every tile in view and of every step a drag
 * takes, and the client holds everything the answer needs. It mirrors the
 * server's rules (`game_loop::may` for a road or the demolisher,
 * `World::fit` for a building placed whole); the server keeps its own and
 * refuses by them, so where the two part the server wins and the dots are
 * only wrong.
 */
export interface Hand {
  /** The ground's road on each tile. */
  roads: Map<string, { id: number; node: RoadNode }>;
  /** The roads above it, by tile and height (`decks.rs`). */
  decks?: Map<string, { id: number; node: RoadNode }>;
  /** Where each road node stands, by id. */
  at: Map<number, GridCoord>;
  occupied: Map<string, Building>;
  ground: (x: number, y: number) => TerrainType | undefined;
}

const key = (x: number, y: number) => `${x},${y}`;

/** The world as the hand sees it, read once a change. */
export function hand(each: (f: (e: GameObjectEntry) => void) => void, ground: Hand["ground"]): Hand {
  const h: Hand = { roads: new Map(), at: new Map(), occupied: new Map(), ground };
  each((e) => {
    if (e.object.kind === "RoadNode" && e.position) {
      if (e.object.data.height) (h.decks ??= new Map()).set(`${e.position.x},${e.position.y},${e.object.data.height}`, { id: e.id, node: e.object.data });
      else h.roads.set(key(e.position.x, e.position.y), { id: e.id, node: e.object.data });
      h.at.set(e.id, e.position);
    } else if (e.object.kind === "Building") {
      for (const t of e.object.data.tiles) h.occupied.set(key(t.x, t.y), e.object.data);
    }
  });
  return h;
}

/** `World::plot_at`: the plot a kind placed round a tile stands on,
 *  this way round. */
export function plotAt(kind: BuildingKind, at: GridCoord, facing: number): GridCoord[] {
  const [w, d] = plot(kind, facing).size;
  const out: GridCoord[] = [];
  for (let dy = 0; dy < d; dy++) for (let dx = 0; dx < w; dx++) out.push({ x: at.x - Math.floor(w / 2) + dx, y: at.y - Math.floor(d / 2) + dy });
  return out;
}

/** A building held over the map: where letting go would place it, the
 *  way it would face, its door if it has one, and, if it may not go
 *  there, why, in words. */
export interface Placing {
  kind: BuildingKind;
  /** The tile it is placed round. */
  at: GridCoord;
  tiles: GridCoord[];
  facing: number;
  /** The tile its drive runs onto, and the street it runs from. */
  door: { tile: GridCoord; street: GridCoord } | null;
  why: string | null;
}

/** Tiles of open sea the ferry needs in a line behind a harbour
 *  (`shipping::water::BERTH`). */
const BERTH = 6;

/** What lies behind a harbour on these tiles facing this way, as
 *  `World::berth_at` reads it: "berth" where a tile behind its back has
 *  `BERTH` of sea straight out, else the best of what is there: some
 *  sea, a lake, or land. */
function behind(h: Hand, tiles: GridCoord[], kind: BuildingKind, facing: number): "berth" | "sea" | "lake" | "land" {
  const gate = gateOf(tiles, kind, facing);
  if (!gate) return "land";
  const xs = tiles.map((t) => t.x), ys = tiles.map((t) => t.y);
  const [dx, dy] = FACINGS[facing % 4];
  const deep = dx === 0 ? Math.max(...ys) - Math.min(...ys) + 1 : Math.max(...xs) - Math.min(...xs) + 1;
  const q = { x: gate.x - dx * deep, y: gate.y - dy * deep };
  const sea = (t: GridCoord) => h.ground(t.x, t.y) === "Sea";
  if (Array.from({ length: BERTH }, (_, n) => ({ x: q.x - dx * n, y: q.y - dy * n })).every(sea)) return "berth";
  if (sea(q)) return "sea";
  return h.ground(q.x, q.y) === "Water" ? "lake" : "land";
}

/** `World::fit`: may a kind be placed round a tile facing this way, and
 *  if not, why: open land under its whole plot, or a road's dead end it
 *  takes over; a street before its front, its yard's if it keeps one;
 *  a harbour's back on open sea, which brings its own street. */
export function fit(h: Hand, kind: BuildingKind, at: GridCoord, facing: number): Placing {
  const tiles = plotAt(kind, at, facing);
  const p = (why: string | null, door: Placing["door"] = null): Placing => ({ kind, at, tiles, facing, door, why });
  for (const t of tiles) {
    if (h.occupied.has(key(t.x, t.y))) return p("Something stands there");
    const n = nodeAt(h, t);
    if (n && new Set(arms(n.node, false)).size > 1) return p("A street runs through it");
    const g = h.ground(t.x, t.y);
    if (g === "Sea" || g === "Water") return p("Its plot runs into the water");
    if (g === "Beach") return p("On the beach: it stands on grass or forest");
    if (!land(g)) return p("Not on open land");
  }
  const door = drivewayFor(h, tiles, kind, facing);
  if (BLUEPRINTS[kind].quay) {
    const back = behind(h, tiles, kind, facing);
    if (back === "sea") return p(`The water behind is too narrow: the ferry needs ${BERTH} tiles of open sea straight out`);
    if (back === "lake") return p("A lake: the ferry comes only by sea");
    if (back === "land") return p("No berth: its back is not on the sea");
    return p(null, door);
  }
  if (!door) return p(BLUEPRINTS[kind].lot[1] > 0 ? "No street before its yard" : "No street beside it");
  // One that parks at the kerb needs a street all along one side, for its bays.
  if (kerbed(kind) && !FACINGS.some((d) => streetAlong(h, sideOf(tiles, d), d))) return p("No street along a whole side, for its parking");
  return p(null, door);
}

/** How a kind held at a tile would be placed: turned the way the hand
 *  turned it, or, left to itself, the first way it fits, and where none
 *  does, toward the nearest street, a harbour toward the sea, so the
 *  reason shown is the one that matters. */
export function placing(h: Hand, kind: BuildingKind, at: GridCoord, facing: number | null): Placing {
  // Or round a tile beside it that fits: the coast a harbour backs onto,
  // the street a depot's yard must front, are a tile from where the eye
  // puts them.
  const tried = NEAR.map(([dx, dy]) => turned(h, kind, { x: at.x + dx, y: at.y + dy }, facing));
  return tried.find((p) => !p.why) ?? tried[0];
}

/** The tile itself, then those round it, beside before diagonal. */
const NEAR: [number, number][] = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];

function turned(h: Hand, kind: BuildingKind, at: GridCoord, facing: number | null): Placing {
  if (facing !== null) return fit(h, kind, at, facing);
  const all = [0, 1, 2, 3].map((f) => fit(h, kind, at, f));
  const ok = all.find((p) => !p.why);
  if (ok) return ok;
  const rank = BLUEPRINTS[kind].quay
    ? (p: Placing) => ({ berth: 0, sea: 1, lake: 2, land: 3 })[behind(h, p.tiles, kind, p.facing)]
    : (p: Placing) => nearestStreet(h, front(p));
  return all.reduce((a, b) => (rank(b) < rank(a) ? b : a));
}

/** May a kind stand round this tile any way round: where the dots go. */
export const fits = (h: Hand, kind: BuildingKind, at: GridCoord) => [0, 1, 2, 3].some((f) => !fit(h, kind, at, f).why);

/** The tile one out from the middle of a plot's front. */
function front(p: Placing): GridCoord {
  const xs = p.tiles.map((t) => t.x), ys = p.tiles.map((t) => t.y);
  const [dx, dy] = FACINGS[p.facing % 4];
  const mid = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  const [hw, hh] = [(Math.max(...xs) - Math.min(...xs)) / 2 + 1, (Math.max(...ys) - Math.min(...ys)) / 2 + 1];
  return { x: Math.round(mid.x + dx * hw), y: Math.round(mid.y + dy * hh) };
}

/** Steps to the nearest street tile from this one, as far as eight. */
function nearestStreet(h: Hand, t: GridCoord): number {
  for (let r = 0; r <= 8; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) if (Math.max(Math.abs(dx), Math.abs(dy)) === r && nodeAt(h, { x: t.x + dx, y: t.y + dy })) return r;
  return 99;
}

/** `World::driveway_for`: the street a plot's drive would run from, and
 *  the tile it runs onto (`enters`); straight before diagonal; never at a
 *  hairpin. */
function drivewayFor(h: Hand, tiles: GridCoord[], kind: BuildingKind, facing: number): Placing["door"] {
  const candidates: [number, GridCoord, GridCoord][] = [];
  for (const t of tiles)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const n = { x: t.x + dx, y: t.y + dy };
        if (enters(tiles, kind, facing, n, t)) candidates.push([+(dx !== 0 && dy !== 0), t, n]);
      }
  candidates.sort((a, b) => a[0] - b[0]);
  for (const [, t, n] of candidates) {
    const street = nodeAt(h, n);
    if (street && !street.node.road && !h.occupied.has(key(n.x, n.y)) && !tooSharp(h, n, t.x - n.x, t.y - n.y, true, true)) return { tile: t, street: n };
  }
  return null;
}

/** The steps out of a tile, as the brush numbers them: east and on round toward +y. */
export const STEPS: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/** The step a way points, as its index in `STEPS`. */
export function snap(dx: number, dy: number): number {
  return ((Math.round((Math.atan2(dy, dx) * 4) / Math.PI) % 8) + 8) % 8;
}

/** May the hand take this step with this tool: the world's rule. */
export function may(h: Hand, tool: Tool, from: GridCoord, to: GridCoord): boolean {
  if (tool === "Light") return mayAt(h, tool, from, 0, to, 0);
  if (tool === "Demolish") {
    if (from.x === to.x && from.y === to.y) return h.roads.has(key(to.x, to.y)) || h.occupied.has(key(to.x, to.y));
    return Math.abs(from.x - to.x) <= 1 && Math.abs(from.y - to.y) <= 1 && connected(h, from, to);
  }
  // Into a building is its door, and a through road is no door.
  if (tool === "Road" && h.occupied.has(key(to.x, to.y))) return false;
  return mayLay(h, from, to, tool === "OneWay");
}

/** May a drag start here: a tap that does something, or a step out. */
export function mayStart(h: Hand, tool: Tool, at: GridCoord): boolean {
  if (may(h, tool, at, at)) return true;
  // What is taken away is taken where it stands; lights go where they go.
  return tool !== "Demolish" && tool !== "Light" && STEPS.some(([dx, dy]) => may(h, tool, at, { x: at.x + dx, y: at.y + dy }));
}

const nodeAt = (h: Hand, t: GridCoord) => h.roads.get(key(t.x, t.y));

function arms(node: RoadNode, outgoingOnly: boolean): number[] {
  return outgoingOnly ? node.outgoing : [...node.outgoing, ...node.incoming];
}

/** The highest a road stands, in half-levels (`decks.rs`). */
export const TOP = 6;

type Node = { id: number; node: RoadNode };

/** The road node on a tile at a height (`World::node_at`). */
export const nodeAtH = (h: Hand, t: GridCoord, height: number): Node | undefined => (height ? h.decks?.get(`${t.x},${t.y},${height}`) : nodeAt(h, t));

/** Every road node on a tile, and how high it stands. */
export function nodesOn(h: Hand, t: GridCoord): [number, Node][] {
  const out: [number, Node][] = [];
  const g = nodeAt(h, t);
  if (g) out.push([0, g]);
  for (let height = 1; height <= TOP; height++) {
    const d = h.decks?.get(`${t.x},${t.y},${height}`);
    if (d) out.push([height, d]);
  }
  return out;
}

const edge = (a: Node, b: Node) => a.node.outgoing.includes(b.id) || b.node.incoming.includes(a.id);

/** `World::room_at`. */
function roomAt(h: Hand, t: GridCoord, height: number): boolean {
  if (nodeAtH(h, t, height)) return true;
  if (height > 0 && (h.occupied.has(key(t.x, t.y)) || h.ground(t.x, t.y) === "Mountain")) return false;
  return nodesOn(h, t).every(([other]) => Math.abs(other - height) >= 2 + (other % 2) + (height % 2));
}

/** `World::slope_takes`. */
function slopeTakes(h: Hand, at: GridCoord, height: number, [dx, dy]: [number, number], other: number): boolean {
  if (height % 2 === 0) return true;
  const here = nodeAtH(h, at, height);
  if (!here) return true;
  const arms = [...new Set([...here.node.outgoing, ...here.node.incoming])];
  if (arms.length === 0) return true;
  if (arms.length > 1) return false;
  const p = h.at.get(arms[0]);
  const armHeight = [...(h.decks?.values() ?? [])].find((d) => d.id === arms[0])?.node.height ?? 0;
  return !!p && p.x - at.x === -dx && p.y - at.y === -dy && armHeight !== other;
}

/** `World::may_lay_at`, and the demolisher at a height: the hand's step
 *  from one tile at one height to the next at another. On the ground,
 *  `may`. */
export function mayAt(h: Hand, tool: Tool, from: GridCoord, hf: number, to: GridCoord, ht: number): boolean {
  // Lights, on a junction or off one: a tap.
  if (tool === "Light") {
    const n = nodeAtH(h, to, ht);
    return from.x === to.x && from.y === to.y && !!n && new Set([...n.node.outgoing, ...n.node.incoming]).size > 2;
  }
  if (tool === "Demolish") {
    if (from.x === to.x && from.y === to.y) return !!nodeAtH(h, to, ht) || (ht === 0 && h.occupied.has(key(to.x, to.y)));
    const [a, b] = [nodeAtH(h, from, hf), nodeAtH(h, to, ht)];
    return Math.abs(from.x - to.x) <= 1 && Math.abs(from.y - to.y) <= 1 && !!a && !!b && (edge(a, b) || edge(b, a));
  }
  const oneWay = tool === "OneWay";
  const [dx, dy] = [to.x - from.x, to.y - from.y];
  if ((dx === 0 && dy === 0) || Math.abs(dx) > 1 || Math.abs(dy) > 1 || hf > TOP || ht > TOP) return false;
  if (hf === 0 && ht === 0) return may(h, tool, from, to) && roomAt(h, from, 0) && roomAt(h, to, 0);
  if (Math.abs(hf - ht) > 1 || (hf === ht && hf % 2 === 1)) return false;
  if (!roomAt(h, from, hf) || !roomAt(h, to, ht)) return false;
  for (const [t, height] of [[from, hf], [to, ht]] as const) {
    const g = h.ground(t.x, t.y);
    const wet = g === "Water" || g === "Sea" || g === "Beach" || g === "Mountain";
    if (height === 0 && ((wet && !nodeAt(h, t)) || h.occupied.has(key(t.x, t.y)))) return false;
  }
  const [a, b] = [nodeAtH(h, from, hf), nodeAtH(h, to, ht)];
  if (a && b && (edge(a, b) || edge(b, a)) && !(oneWay && edge(b, a) && !edge(a, b))) return false;
  if (!slopeTakes(h, from, hf, [dx, dy], ht) || !slopeTakes(h, to, ht, [-dx, -dy], hf)) return false;
  if (dx !== 0 && dy !== 0) {
    const [p, q] = [{ x: from.x + dx, y: from.y }, { x: from.x, y: from.y + dy }];
    const crossed = nodesOn(h, p).some(([hp, np]) => nodesOn(h, q).some(([hq, nq]) => (edge(np, nq) || edge(nq, np)) && Math.abs(hp + hq - (hf + ht)) < 4));
    if (crossed) return false;
  }
  return !(a && tooSharpNode(h, a, from, dx, dy, !oneWay, true)) && !(b && tooSharpNode(h, b, to, -dx, -dy, true, !oneWay));
}

/** `World::would_turn_sharply`: would a new arm here this way give a car
 *  a turn sharper than a right angle, in by one arm and out by another
 *  within ninety degrees of it; `arriving`, cars come in along the new
 *  arm, `leaving`, they go out along it. Only turns a car can make count. */
function tooSharp(h: Hand, at: GridCoord, dx: number, dy: number, arriving: boolean, leaving: boolean): boolean {
  const here = nodeAt(h, at);
  return !!here && tooSharpNode(h, here, at, dx, dy, arriving, leaving);
}

/** `World::turns_sharply`: the same, of a node at any height. */
function tooSharpNode(h: Hand, here: Node, at: GridCoord, dx: number, dy: number, arriving: boolean, leaving: boolean): boolean {
  const byId = (id: number) => [nodeAt(h, h.at.get(id) ?? at), ...[...(h.decks?.values() ?? [])]].find((n) => n?.id === id);
  return arms(here.node, false).some((id) => {
    const p = h.at.get(id);
    // The arm itself, there the other way already: a divided road.
    if (!p || (p.x - at.x) * dx + (p.y - at.y) * dy <= 0 || (p.x - at.x === dx && p.y - at.y === dy)) return false;
    const out = here.node.outgoing.includes(id);
    const into = !!byId(id)?.node.outgoing.includes(here.id) || here.node.incoming.includes(id);
    return (arriving && out) || (leaving && into);
  });
}

/** `World::street_along`: a street tile before each of these tiles on the
 *  side (dx, dy), each joined to the next. */
function streetAlong(h: Hand, run: GridCoord[], [dx, dy]: [number, number]): boolean {
  const out = run.map((t) => ({ x: t.x + dx, y: t.y + dy }));
  return out.length > 0 && out.every((t) => nodeAt(h, t) && !nodeAt(h, t)!.node.road) && out.every((t, i) => i === 0 || connected(h, out[i - 1], t));
}

function connected(h: Hand, a: GridCoord, b: GridCoord): boolean {
  const [na, nb] = [nodeAt(h, a), nodeAt(h, b)];
  return !!na && !!nb && (na.node.outgoing.includes(nb.id) || na.node.incoming.includes(nb.id));
}

/** `World::runs_one_way`: the road from one tile to the next runs there
 *  and not back. */
function runsOneWay(h: Hand, a: GridCoord, b: GridCoord): boolean {
  const [na, nb] = [nodeAt(h, a), nodeAt(h, b)];
  return !!na && !!nb && na.node.outgoing.includes(nb.id) && !nb.node.outgoing.includes(na.id);
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
  if (into && !facings(into.kind, into.facing).some((f) => enters(into.tiles, into.kind, f, from, to))) return false;
  // Joined already; but a one-way laid against a one-way makes a divided road.
  if (connected(h, from, to) && !(oneWay && runsOneWay(h, to, from))) return false;
  if (dx !== 0 && dy !== 0 && connected(h, { x: from.x + dx, y: from.y }, { x: from.x, y: from.y + dy })) return false;
  // Out of `from` and in to `to`, and back too unless it is one way.
  return !tooSharp(h, from, dx, dy, !oneWay, true) && (!!into || !tooSharp(h, to, -dx, -dy, true, !oneWay));
}

/** `World::enters`: may a drive run from `from` onto `to` of a plot
 *  lying this way: off the plot onto it, beside it, or on the diagonal
 *  only outward from a corner; onto its yard's gate, from ahead of it,
 *  if its kind keeps one. */
function enters(tiles: GridCoord[], kind: BuildingKind, facing: number, from: GridCoord, to: GridCoord): boolean {
  const on = (x: number, y: number) => tiles.some((t) => t.x === x && t.y === y);
  const [dx, dy] = [from.x - to.x, from.y - to.y];
  if (!on(to.x, to.y) || on(from.x, from.y) || Math.abs(dx) > 1 || Math.abs(dy) > 1) return false;
  if (dx && dy && (on(to.x + dx, to.y) || on(to.x, to.y + dy))) return false;
  const yard = yardOf(tiles, kind, facing);
  if (!yard) return true;
  // A yard is entered only by its gate, so its lane runs straight in.
  const gate = gateOf(tiles, kind, facing);
  if (!gate || gate.x !== to.x || gate.y !== to.y) return false;
  const [fx, fy] = FACINGS[facing % 4];
  return yard.some((t) => t.x === to.x && t.y === to.y) && dx * fx + dy * fy > 0;
}

/** `World::facings`: the ways a building may turn to find its street,
 *  its own first. */
function facings(kind: BuildingKind, facing: number): number[] {
  const { quay, lot } = BLUEPRINTS[kind];
  return quay || !lot[1] ? [facing] : [0, 2, 1, 3].map((k) => (facing + k) % 4);
}

const land = (g: TerrainType | undefined) => g === "Grass" || g === "Forest";
