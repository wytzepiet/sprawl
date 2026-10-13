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
  /** The other roads on a tile, above it or beside its middle, by tile,
   *  height and side (`decks.rs`). */
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
      const [sx, sy] = e.object.data.side ?? MIDDLE;
      if (e.object.data.height || sx || sy) (h.decks ??= new Map()).set(`${e.position.x},${e.position.y},${e.object.data.height},${sx},${sy}`, { id: e.id, node: e.object.data });
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

/** May the hand take this step with this tool, and priority or not
 *  (`Build.road`): the world's rule. */
export function may(h: Hand, tool: Tool, from: GridCoord, to: GridCoord, road = false, goesOn = false): boolean {
  if (tool === "Light") return mayAt(h, tool, from, 0, to, 0);
  if (tool === "Demolish") {
    if (from.x === to.x && from.y === to.y) return h.roads.has(key(to.x, to.y)) || h.occupied.has(key(to.x, to.y));
    return Math.abs(from.x - to.x) <= 1 && Math.abs(from.y - to.y) <= 1 && connected(h, from, to);
  }
  // Into a building is its door, and a through road is no door.
  if (road && h.occupied.has(key(to.x, to.y))) return false;
  return mayLay(h, from, to, tool === "OneWay" || tool === "Wide", goesOn);
}

/** May a drag start here: a tap that does something, or a step out. */
export function mayStart(h: Hand, tool: Tool, at: GridCoord, road = false): boolean {
  if (mayAt(h, tool, at, 0, at, 0, road)) return true;
  // What is taken away is taken where it stands; lights go where they go.
  return tool !== "Demolish" && tool !== "Light" && STEPS.some(([dx, dy]) => mayAt(h, tool, at, 0, { x: at.x + dx, y: at.y + dy }, 0, road));
}

const nodeAt = (h: Hand, t: GridCoord) => h.roads.get(key(t.x, t.y));

function arms(node: RoadNode, outgoingOnly: boolean): number[] {
  return outgoingOnly ? node.outgoing : [...node.outgoing, ...node.incoming];
}

/** The highest a road stands, in half-levels (`decks.rs`). */
export const TOP = 6;

type Node = { id: number; node: RoadNode };

/** Which side of its tile a node stands (`decks::Side`): the step across
 *  its road it is moved by; `MIDDLE`, not moved. */
export type Side = [number, number];
export const MIDDLE: Side = [0, 0];
const same = (a: Side, b: Side) => a[0] === b[0] && a[1] === b[1];
const isMiddle = (s: Side) => !s[0] && !s[1];
export const otherSide = (s: Side): Side => [-s[0], -s[1]];
/** How far from its tile's middle a node on a side stands, in tiles
 *  (`decks::SIDE_OFFSET`). */
export const SIDE_OFFSET = 0.17;
/** Where a node on a side of a tile stands (`World::node_pos`). */
export const spot = (t: GridCoord, [sx, sy]: Side = MIDDLE): [number, number] => {
  const by = sx || sy ? SIDE_OFFSET / Math.hypot(sx, sy) : 0;
  return [t.x + 0.5 + sx * by, t.y + 0.5 + sy * by];
};

/** How far a step goes toward a side (`decks::toward`). */
export const toward = ([dx, dy]: [number, number], s: Side) => dx * s[0] + dy * s[1];

/** The road node on a tile at a height and side (`World::node_in`). */
export const nodeIn = (h: Hand, t: GridCoord, height: number, side: Side = MIDDLE): Node | undefined =>
  height || !isMiddle(side) ? h.decks?.get(`${t.x},${t.y},${height},${side[0]},${side[1]}`) : nodeAt(h, t);

/** The middle road node on a tile at a height (`World::node_at`). */
export const nodeAtH = (h: Hand, t: GridCoord, height: number): Node | undefined => nodeIn(h, t, height);

/** Every road node on a tile, and how high it stands. */
export function nodesOn(h: Hand, t: GridCoord): [number, Node][] {
  const out: [number, Node][] = [];
  const g = nodeAt(h, t);
  if (g) out.push([0, g]);
  for (const [k, d] of h.decks ?? []) {
    const [x, y] = k.split(",", 2).map(Number);
    if (x === t.x && y === t.y) out.push([d.node.height, d]);
  }
  return out;
}

export const edge = (a: Node, b: Node) => a.node.outgoing.includes(b.id) || b.node.incoming.includes(a.id);

/** `decks::across`: the way across a road through a tile by these arms,
 *  in small whole steps, either way round. */
export function across(arms: [number, number][]): Side | undefined {
  const [x, y] = arms.length === 1 ? [-arms[0][1], arms[0][0]] : arms.length === 2 ? [-(arms[1][1] - arms[0][1]), arms[1][0] - arms[0][0]] : [NaN, NaN];
  if (Number.isNaN(x)) return undefined;
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = gcd(Math.abs(x), Math.abs(y)) || 1;
  return [x / g, y / g];
}

/** A node's arms, by the steps to their tiles, in the server's order. */
function stepsOf(h: Hand, t: GridCoord, n: Node): [number, number][] {
  const ids = [...new Set([...n.node.outgoing, ...n.node.incoming])].sort((a, b) => a - b);
  return ids.flatMap((id) => {
    const p = h.at.get(id);
    return p ? [[p.x - t.x, p.y - t.y] as [number, number]] : [];
  });
}

/** `World::moves_over`: the middle node on a tile that moves over to the
 *  other side when a node is laid on this one: a one-way running through,
 *  straight on or round a bend, or ending, across the side, one lane. */
export function movesOver(h: Hand, t: GridCoord, height: number, side: Side): Node | undefined {
  if (isMiddle(side) || nodeIn(h, t, height, otherSide(side))) return undefined;
  const m = nodeIn(h, t, height);
  if (!m) return undefined;
  const ids = [...new Set([...m.node.outgoing, ...m.node.incoming])];
  const byId = (id: number) => nodesOn(h, h.at.get(id) ?? t).find(([, n]) => n.id === id)?.[1];
  const oneLane = ids.every((id) => {
    const n = byId(id);
    return !!n && edge(m, n) !== edge(n, m) && !m.node.wide.includes(id) && !n.node.wide.includes(m.id);
  });
  const way = across(stepsOf(h, t, m));
  return oneLane && way && (same(side, way) || same(side, otherSide(way))) ? m : undefined;
}

/** The sides a road may be laid on beside the one-way in the middle of a
 *  tile, the one there moving over: across it, either way. */
export function sidesBeside(h: Hand, t: GridCoord, height: number): Side[] {
  const m = nodeIn(h, t, height);
  const way = m && across(stepsOf(h, t, m));
  return way ? [way, otherSide(way)].filter((s) => movesOver(h, t, height, s)) : [];
}

/** `World::bend_of`: the steps of the road a road on this side follows
 *  round a bend, the one beside it or that moves over for it; straight
 *  on, none. */
function bendOf(h: Hand, t: GridCoord, height: number, side: Side): [number, number][] | undefined {
  const beside = nodeIn(h, t, height, otherSide(side)) ?? movesOver(h, t, height, side);
  if (!beside) return undefined;
  const steps = stepsOf(h, t, beside);
  return steps.length === 2 && (steps[0][0] + steps[1][0] || steps[0][1] + steps[1][1]) ? steps : undefined;
}

/** `World::room_at`. */
function roomAt(h: Hand, t: GridCoord, height: number, side: Side = MIDDLE): boolean {
  if (nodeIn(h, t, height, side)) return true;
  if (height > 0 && (h.occupied.has(key(t.x, t.y)) || h.ground(t.x, t.y) === "Mountain")) return false;
  const moving = movesOver(h, t, height, side);
  return nodesOn(h, t).every(([other, n]) => {
    const beside = !isMiddle(side) && other === height && (same(n.node.side ?? MIDDLE, otherSide(side)) || n.id === moving?.id);
    return beside || Math.abs(other - height) >= 2 + (other % 2) + (height % 2);
  });
}

/** `World::slope_takes`. */
function slopeTakes(h: Hand, at: GridCoord, height: number, side: Side, [dx, dy]: [number, number], other: number): boolean {
  if (height % 2 === 0) return true;
  const here = nodeIn(h, at, height, side);
  if (!here) return true;
  const arms = [...new Set([...here.node.outgoing, ...here.node.incoming])];
  if (arms.length === 0) return true;
  if (arms.length > 1) return false;
  const p = h.at.get(arms[0]);
  const armHeight = [...(h.decks?.values() ?? [])].find((d) => d.id === arms[0])?.node.height ?? 0;
  // Its other arm, straight behind or round a bend, at the climb's other end.
  return !!p && !(p.x - at.x === dx && p.y - at.y === dy) && armHeight !== other;
}

/** `World::may_lay_at`, and the demolisher at a height and side: the
 *  hand's step from one tile at one height and side to the next at
 *  another. In the ground's middles, `may`. */
export function mayAt(h: Hand, tool: Tool, from: GridCoord, hf: number, to: GridCoord, ht: number, road = false, [sf, st]: [Side, Side] = [MIDDLE, MIDDLE], goesOn = false): boolean {
  const [na, nb] = [nodeIn(h, from, hf, sf), nodeIn(h, to, ht, st)];
  // Lights, on a junction or off one: a tap.
  if (tool === "Light") return from.x === to.x && from.y === to.y && !!nb && new Set([...nb.node.outgoing, ...nb.node.incoming]).size > 2;
  if (tool === "Demolish") {
    if (from.x === to.x && from.y === to.y) return !!nb || (ht === 0 && h.occupied.has(key(to.x, to.y)));
    return Math.abs(from.x - to.x) <= 1 && Math.abs(from.y - to.y) <= 1 && !!na && !!nb && (edge(na, nb) || edge(nb, na));
  }
  const oneWay = tool === "OneWay" || tool === "Wide";
  const [dx, dy] = [to.x - from.x, to.y - from.y];
  const middles = isMiddle(sf) && isMiddle(st);
  // Along a road, priority it has not, or has and the hand not; along a
  // one-way the way it runs, the other one-way tool: a lane more, or less,
  // but not on a side (`game::may_step`).
  if (na && nb && (edge(na, nb) || edge(nb, na)) && (na.node.road && nb.node.road) !== road) return true;
  if (oneWay && na && nb && edge(na, nb) && !edge(nb, na) && na.node.wide.includes(nb.id) !== (tool === "Wide")) return tool !== "Wide" || middles;
  if (tool === "Wide" && !middles) return false;
  if ((dx === 0 && dy === 0) || Math.abs(dx) > 1 || Math.abs(dy) > 1 || hf > TOP || ht > TOP) return false;
  if (hf === 0 && ht === 0 && middles) return may(h, tool, from, to, road, goesOn) && roomAt(h, from, 0) && roomAt(h, to, 0);
  // Level, a slope's end, or one slope on to the next (`World::may_lay_at`).
  const on = hf % 2 === 1 && ht % 2 === 1 && Math.abs(hf - ht) === 2;
  if ((Math.abs(hf - ht) > 1 && !on) || (hf === ht && hf % 2 === 1)) return false;
  if (!roomAt(h, from, hf, sf) || !roomAt(h, to, ht, st)) return false;
  // A road on a side: along its run one way, on to the road on its own
  // side or the middle; or, straight on and once there, out toward its
  // side (`World::may_lay_at`).
  for (const [at, height, side, way, there, n] of [[from, hf, sf, [dx, dy], st, na], [to, ht, st, [-dx, -dy], sf, nb]] as const) {
    if (isMiddle(side)) continue;
    const w = way as [number, number];
    const bend = bendOf(h, at, height, side);
    const along = bend ? bend.some(([x, y]) => x === w[0] && y === w[1]) : toward(w, side) === 0;
    if (along) {
      if (!oneWay || (!isMiddle(there) && toward(there, side) <= 0)) return false;
    } else if (bend || toward(w, side) < 0 || (!oneWay && !n) || (n && new Set([...n.node.outgoing, ...n.node.incoming]).size > 2)) return false;
  }
  for (const [t, height] of [[from, hf], [to, ht]] as const) {
    const g = h.ground(t.x, t.y);
    const wet = g === "Water" || g === "Sea" || g === "Beach" || g === "Mountain";
    if (height === 0 && ((wet && !nodeAt(h, t)) || h.occupied.has(key(t.x, t.y)))) return false;
  }
  if (na && nb && (edge(na, nb) || edge(nb, na))) return false;
  if (!slopeTakes(h, from, hf, sf, [dx, dy], ht) || !slopeTakes(h, to, ht, st, [-dx, -dy], hf)) return false;
  // A drag that may go on from `to` may lead its cars on (`World::leads_nowhere`).
  return !(na && leadsNowhere(h, na, from, dx, dy, !oneWay, true)) && !(nb && leadsNowhere(h, nb, to, -dx, -dy, !goesOn, !oneWay && !goesOn));
}

/** `World::leads_nowhere`: would a new arm here this way lead nowhere,
 *  its cars, coming in along it (`arriving`) or going out (`leaving`),
 *  with roads to turn onto there and every one a turn sharper than a
 *  right angle, which no car makes. */
function leadsNowhere(h: Hand, here: Node, at: GridCoord, dx: number, dy: number, arriving: boolean, leaving: boolean): boolean {
  const byId = (id: number) => [nodeAt(h, h.at.get(id) ?? at), ...[...(h.decks?.values() ?? [])]].find((n) => n?.id === id);
  const ways = arms(here.node, false).flatMap((id) => {
    const p = h.at.get(id);
    if (!p || (p.x - at.x === dx && p.y - at.y === dy)) return [];
    const out = here.node.outgoing.includes(id);
    const into = !!byId(id)?.node.outgoing.includes(here.id) || here.node.incoming.includes(id);
    return [{ out, into, shallow: (p.x - at.x) * dx + (p.y - at.y) * dy <= 0 }];
  });
  const none = (out: boolean) => {
    const these = ways.filter((w) => (out ? w.out : w.into));
    return these.length > 0 && !these.some((w) => w.shallow);
  };
  return (arriving && none(true)) || (leaving && none(false));
}

/** `World::would_turn_sharply`: would a new arm here this way give a car
 *  a turn sharper than a right angle, in by one arm and out by another
 *  within ninety degrees of it; `arriving`, cars come in along the new
 *  arm, `leaving`, they go out along it. A drive may not. */
function tooSharp(h: Hand, at: GridCoord, dx: number, dy: number, arriving: boolean, leaving: boolean): boolean {
  const here = nodeAt(h, at);
  return !!here && tooSharpNode(h, here, at, dx, dy, arriving, leaving);
}

function tooSharpNode(h: Hand, here: Node, at: GridCoord, dx: number, dy: number, arriving: boolean, leaving: boolean): boolean {
  const byId = (id: number) => [nodeAt(h, h.at.get(id) ?? at), ...[...(h.decks?.values() ?? [])]].find((n) => n?.id === id);
  return arms(here.node, false).some((id) => {
    const p = h.at.get(id);
    // An arm to the tile the new one goes to: going back, which no car does.
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

/** `World::may_lay`. */
function mayLay(h: Hand, from: GridCoord, to: GridCoord, oneWay: boolean, goesOn = false): boolean {
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
  if (connected(h, from, to)) return false;
  // Out of `from` and in to `to`, and back too unless it is one way.
  const [nf, nt] = [nodeAt(h, from), nodeAt(h, to)];
  return !(nf && leadsNowhere(h, nf, from, dx, dy, !oneWay, true)) && (!!into || !(nt && leadsNowhere(h, nt, to, -dx, -dy, !goesOn, !oneWay && !goesOn)));
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
