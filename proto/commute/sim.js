// Sprawl, pull: whoever needs something goes and gets it. Houses drive to a
// shop; shops and workshops send their lorry to whoever makes what they lack;
// woodcutters, farms and pits stack their yards and wait to be fetched from.
// Every errand is a trip on your roads, and a queue shows where supply is short.
// Every house also has a worker, who keeps their own hours at the nearest
// maker with a seat free: that is what takes cars out of their neighbourhood,
// and a maker loses the time its workers spend on the road.
// The sim knows nothing of the screen: index.html draws it, bot.js plays it.

(function (root) {

const W = 48, H = 32;
const GRASS = 0, FOREST = 1, WATER = 2, MEADOW = 3, CLAY = 4, SAND = 5;
const WOOD = 4;          // logs a forest tile holds
const REGROW = 14;       // seconds for every forest tile to grow back a log
const STEPS8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const STEPS4 = [[1, 0], [0, 1], [-1, 0], [0, -1]];

const SPEED = 2.4;       // tiles a second
const GAP = 0.42;        // bumper to bumper, in tiles
const STOP = 0.5;        // a junction's stop line, short of its centre
const GHOST = 12;        // seconds stuck before a truck squeezes through
const PATIENCE = 60;     // seconds a house waits on a want
const SEATS = 2, JOBS = 2;   // workers a maker hires, and needs to work full speed
const SHIFT = 40, REST = 20;   // seconds at work, and at home between shifts; a maker
                               // loses only the time its workers spend on the road
const DAY = 120;
const CLEAN_DAY_ROADS = 3;   // road tiles for a day nobody left         // seconds from one morning to the next; the last quarter or so is night
const OUT_CAP = 3;
const START = [32, 12];

const GOODS = {
  fish:      { name: 'Fish',      col: '#3d8fd1', pay: 1 },
  log:       { name: 'Logs',      col: '#8b5e34', pay: 0 },
  plank:     { name: 'Planks',    col: '#e0a640', pay: 3 },
  wheat:     { name: 'Wheat',     col: '#d9c24a', pay: 0 },
  bread:     { name: 'Bread',     col: '#d07a3a', pay: 2 },
  clay:      { name: 'Clay',      col: '#c49563', pay: 0 },
  brick:     { name: 'Bricks',    col: '#c0533e', pay: 4 },
  furniture: { name: 'Furniture', col: '#2f9c8f', pay: 4 },
  sand:      { name: 'Sand',      col: '#d8bd7a', pay: 0 },
  glass:     { name: 'Glass',     col: '#5fb6c9', pay: 5 },
  wool:      { name: 'Wool',      col: '#b9a7d6', pay: 0 },
  clothes:   { name: 'Clothes',   col: '#8a62c7', pay: 5 },
};

const KINDS = {
  fishery:    { name: 'Fishery',    out: 'fish',      time: 4.0, cost: 12, near: WATER,  why: 'Houses want fish. A fishery on the water catches it. A shop sends its lorry for it, and residents drive to the shop to buy.' },
  woodcutter: { name: 'Woodcutter', out: 'log',       time: 3.5, cost: 10, near: FOREST, why: 'A woodcutter by the forest cuts logs.' },
  sawmill:    { name: 'Sawmill',    out: 'plank',     time: 3.0, cost: 15, needs: { log: 1 }, loud: true, why: 'A house wants planks to grow. A sawmill makes them.' },
  farm:       { name: 'Farm',       out: 'wheat',     time: 4.0, cost: 12, on: MEADOW,  why: 'A farm on the meadow grows wheat.' },
  bakery:     { name: 'Bakery',     out: 'bread',     time: 3.5, cost: 18, needs: { wheat: 1 }, why: 'Bigger houses want bread. A bakery bakes it.' },
  claypit:    { name: 'Clay pit',   out: 'clay',      time: 4.0, cost: 12, on: CLAY,    why: 'A clay pit digs clay where the ground is ochre.' },
  brickworks: { name: 'Brickworks', out: 'brick',     time: 4.0, cost: 25, needs: { clay: 1, log: 1 }, loud: true, why: 'A house wants bricks to grow. A brickworks fires them from clay and logs.' },
  workshop:   { name: 'Workshop',   out: 'furniture', time: 5.0, cost: 25, needs: { plank: 2 }, loud: true, why: 'Townhouses want furniture. A workshop makes it from planks.' },
  sandpit:    { name: 'Sand pit',   out: 'sand',      time: 4.0, on: SAND,  why: 'A sand pit digs on the beach across the river.' },
  glassworks: { name: 'Glassworks', out: 'glass',     time: 4.5, needs: { sand: 1, log: 1 }, loud: true, why: 'A townhouse wants glass to grow. A glassworks melts sand over a wood fire.' },
  sheep:      { name: 'Sheep farm', out: 'wool',      time: 4.5, on: MEADOW, why: 'Sheep on the meadow give wool. They want the same meadow as the farms.' },
  tailor:     { name: 'Tailor',     out: 'clothes',   time: 4.0, needs: { wool: 1 }, why: 'Apartments want clothes. A tailor sews them from wool.' },
};
// A shop makes nothing: lorries stock its shelves and residents drive there.
KINDS.depot = { name: 'Depot', out: null, depot: true, why: 'A depot keeps a big yard of whatever the buildings round it use. Its big lorry fetches in bulk from makers far out; shops and workshops nearby fetch from the depot instead of driving all the way.' };
KINDS.shop = { name: 'Shop', out: null, shop: true, why: 'Houses buy what they want at a shop, building materials too. Its lorries fetch from whoever makes it; residents drive over to buy.' };
const WOOD_NEED = REGROW / KINDS.woodcutter.time;   // forest tiles that keep one woodcutter cutting for good
const SHELF = 2, SHELF_MAX = 30, DAY_NEED = 2.5;   // a shop holds a day's worth: a couple of each, and
                                                 // about what a house buys in a day for each house it serves
const REACH = 10;        // road tiles a resident will drive to a shop
const MAKER = {};
for (const k in KINDS) if (KINDS[k].out) MAKER[KINDS[k].out] = k;

const LEVELS = [
  null,
  { name: 'Cottage',   people: 2,  wants: { fish: 30 },                                       grow: { plank: 2 }, after: 2 },
  { name: 'House',     people: 4,  wants: { fish: 34, bread: 40 },                            grow: { brick: 3 }, after: 5 },
  { name: 'Townhouse', people: 8,  wants: { fish: 38, bread: 42, furniture: 55 },             grow: { glass: 3 }, after: 7 },
  { name: 'Apartment', people: 14, wants: { fish: 40, bread: 44, furniture: 55, clothes: 60 } },
];

const STATUSES = [
  { name: 'Hamlet',     at: 0,   size: [20, 13] },
  { name: 'Village',    at: 12,  size: [28, 18] },
  { name: 'Town',       at: 40,  size: [36, 24] },
  { name: 'City',       at: 110, size: [44, 29] },
  { name: 'Metropolis', at: 250, size: [48, 32] },
];

// No money. Growth hands you the picks: every PICK_STEP people moving in or up, one. And
// every new house brings a little road, so supply keeps pace with the town.
const ROAD_COST = 1, BRIDGE_COST = 3, PICK_STEP = 10, HOUSE_ROADS = 2, START_ROADS = 24;

function rng(seed) {
  return () => {
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const xy = i => [i % W, (i / W) | 0];
const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? -1 : y * W + x;
const cheb = (a, b) => { const [ax, ay] = xy(a), [bx, by] = xy(b); return Math.max(Math.abs(ax - bx), Math.abs(ay - by)); };
const edgeLen = (a, b) => (a % W !== b % W && ((a / W) | 0) !== ((b / W) | 0)) ? Math.SQRT2 : 1;
const ekey = (a, b) => a * 4096 + b;

function distToPolyline(x, y, pts) {
  let best = Infinity;
  for (let k = 0; k < pts.length - 1; k++) {
    const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

function makeTerrain(seed) {
  const r = rng(seed);
  const t = new Uint8Array(W * H);
  const river = [[10, -1], [13, 6], [12, 12], [17, 18], [25, 20], [33, 21], [43, 21]];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const coast = 40 + Math.round(2 * Math.sin(y * 0.35) + 1.2 * Math.sin(y * 0.9 + 2));
    let k = GRASS;
    if (x >= coast) k = WATER;
    else if (distToPolyline(x, y, river) < 0.75 + 0.25 * Math.sin(x * 0.7 + y)) k = WATER;
    t[y * W + x] = k;
  }
  const blob = (cx, cy, rad, k) => {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (t[i] === WATER) continue;
      const d = Math.hypot(x - cx, y - cy) + (r() - 0.5) * 1.4;
      if (d < rad) t[i] = k;
    }
  };
  blob(25, 8, 2.8, FOREST); blob(36, 4, 2.2, FOREST); blob(6, 6, 4, FOREST); blob(16, 27, 3.5, FOREST);
  blob(44, 27, 2, FOREST); blob(20, 12, 2, FOREST);
  blob(23, 15, 2.4, MEADOW); blob(8, 16, 3, MEADOW); blob(36, 27, 2.6, MEADOW);
  blob(35, 17.5, 1.5, CLAY); blob(5, 25, 2, CLAY);
  blob(31, 24.5, 2.2, SAND); blob(44, 24, 1.4, SAND);
  return t;
}

function Sim(seed = 7) {
  const s = this;
  s.seed = seed;
  s.r = rng(seed * 31 + 5);
  s.terrain = makeTerrain(seed);
  s.wood = new Map();
  for (let i = 0; i < W * H; i++) if (s.terrain[i] === FOREST) s.wood.set(i, WOOD);
  s.adj = new Map();             // road tile -> Set of road tiles it joins
  s.roundabouts = new Set();
  s.buildings = new Map();       // id -> building (houses too)
  s.tileB = new Map();           // tile -> building id
  s.vehicles = [];
  s.lanes = new Map();           // directed edge key -> vehicles front first
  s.locks = new Map();           // junction tile -> vehicles holding it
  s.pins = [];
  s.events = [];
  s.unlocked = new Set();
  s.waiting = new Set();         // makers that come once what feeds them is down
  s.time = 0; s.day = 1; s.streak = 0; s.roads = START_ROADS; s.tokens = { roundabout: 0, shop: 1 };
  s.week = 1; s.weekT = 0; s.arrived = 0; s.pickFrom = 0; s.offer = null; s.leftThisWeek = 0; s.dayFrom = { arrived: 0, left: 0 };
  s.nextId = 1; s.graphV = 0; s.distCache = new Map();
  s.spawned = 0; s.nextSpawn = 30; s.status = 0;
  s.stats = { delivered: 0, left: 0, firsts: {}, wanted: {}, made: {} };
  s.tools = new Set(['road', 'bulldoze']);

  s.computeBounds(true);
  s.unlocked.add('shop');
  const [sx, sy] = START;
  s.addHouse(at(sx, sy), true);
  s.addHouse(at(sx - 1, sy + 2), true);
  // the first dock: the shore tile closest to the cottage on its row
  for (let x = sx + 1; x < W; x++) {
    const i = at(x, sy);
    if (s.terrain[i + 1] === WATER) { s.place('fishery', i, true); break; }
  }
}

const P = Sim.prototype;

// ---- helpers ------------------------------------------------------------------

P.emit = function (e) { e.t = this.time; this.events.push(e); };
P.first = function (key) {
  if (this.stats.firsts[key] !== undefined) return false;
  this.stats.firsts[key] = this.time;
  return true;
};
P.B = function (id) { return this.buildings.get(id); };
P.inBounds = function (i) {
  const [x, y] = xy(i), b = this.bounds;
  return x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
};
P.people = function () {
  let n = 0;
  for (const b of this.buildings.values()) if (b.house) n += LEVELS[b.level].people;
  return n;
};
P.computeBounds = function (snap) {
  const st = STATUSES[this.status];
  const [w, h] = st.size;
  const x0 = Math.max(0, Math.min(W - w, START[0] - Math.floor(w / 2) + 2));
  const y0 = Math.max(0, Math.min(H - h, START[1] - Math.floor(h / 2)));
  this.bounds = { x0, y0, x1: x0 + w - 1, y1: y0 + h - 1 };
};
P.degree = function (i) { const a = this.adj.get(i); return a ? a.size : 0; };
P.isJunction = function (i) { return this.degree(i) >= 3; };
P.loudNear = function (i) {
  for (const b of this.buildings.values())
    if (!b.house && KINDS[b.kind].loud && cheb(b.tile, i) <= 2) return true;
  return false;
};

// ---- roads --------------------------------------------------------------------

P.roadable = function (i) {
  return i >= 0 && this.inBounds(i) && !this.tileB.has(i);
};
P.tileCost = function (i) {
  if (this.adj.has(i)) return 0;
  return this.terrain[i] === WATER ? BRIDGE_COST : ROAD_COST;
};
// Join two neighbouring tiles. Returns what it cost, or -1 when it can't.
P.addRoad = function (a, b) {
  if (a === b || !this.roadable(a) || !this.roadable(b) || cheb(a, b) !== 1) return -1;
  if (this.adj.get(a)?.has(b)) return 0;
  const [ax, ay] = xy(a), [bx, by] = xy(b);
  if (ax !== bx && ay !== by) {
    // no diagonal through another diagonal
    const c = at(ax, by), d = at(bx, ay);
    if (this.adj.get(c)?.has(d)) return -1;
  }
  const cost = this.tileCost(a) + this.tileCost(b);
  if (cost > this.roads) return -1;
  this.roads -= cost;
  for (const i of [a, b]) {
    if (!this.adj.has(i)) this.adj.set(i, new Set());
    if (this.terrain[i] === FOREST) { this.terrain[i] = GRASS; this.wood.delete(i); }
  }
  this.adj.get(a).add(b); this.adj.get(b).add(a);
  this.graphChanged();
  return cost;
};
P.removeRoadTile = function (i) {
  const a = this.adj.get(i);
  if (!a) return false;
  for (const j of a) {
    const o = this.adj.get(j);
    o.delete(i);
    this.dropLane(i, j); this.dropLane(j, i);
    if (!o.size) { this.adj.delete(j); this.roads += this.terrain[j] === WATER ? BRIDGE_COST : ROAD_COST; this.dropRoundabout(j); }
  }
  this.adj.delete(i);
  this.dropRoundabout(i);
  this.roads += this.terrain[i] === WATER ? BRIDGE_COST : ROAD_COST;
  this.graphChanged();
  return true;
};
P.dropLane = function (a, b) {
  const lane = this.lanes.get(ekey(a, b));
  if (!lane) return;
  for (const v of [...lane]) this.sendHome(v);
  this.lanes.delete(ekey(a, b));
};
P.graphChanged = function () {
  this.graphV++;
  this.distCache.clear();
  for (const b of this.buildings.values()) this.findDoor(b);
};
// A building's driveway: the road beside it the player chose, or else the
// first road beside it.
P.findDoor = function (b) {
  const [x, y] = xy(b.tile);
  if (b.doorPref >= 0 && this.adj.has(b.doorPref)) { b.door = b.doorPref; return; }
  let door = -1;
  for (const [dx, dy] of STEPS4) {
    const j = at(x + dx, y + dy);
    if (j >= 0 && this.adj.has(j)) { door = j; break; }
  }
  b.door = door;
};
P.setDoor = function (id, j) {
  const b = this.B(id);
  if (!b || !this.adj.has(j) || !STEPS4.some(([dx, dy]) => { const [x, y] = xy(b.tile); return at(x + dx, y + dy) === j; })) return false;
  if (b.door === j) return true;
  b.doorPref = j; b.door = j;
  this.distCache.clear();
  this.emit({ type: 'door', tile: b.tile });
  return true;
};
P.addRoundabout = function (i) {
  if (!this.tokens.roundabout || !this.isJunction(i) || this.roundabouts.has(i)) return false;
  this.tokens.roundabout--;
  this.roundabouts.add(i);
  return true;
};
P.dropRoundabout = function (i) {
  if (this.roundabouts.delete(i)) this.tokens.roundabout++;
};
P.lockCap = function (i) { return this.roundabouts.has(i) ? 3 : 1; };

// Shortest road distances from a tile, cached until the roads change.
P.dist = function (from) {
  let d = this.distCache.get(from);
  if (d) return d;
  d = new Map([[from, 0]]);
  const prev = new Map();
  const open = [[0, from]];
  while (open.length) {
    let bi = 0;
    for (let k = 1; k < open.length; k++) if (open[k][0] < open[bi][0]) bi = k;
    const [dd, n] = open[bi];
    open[bi] = open[open.length - 1]; open.pop();
    if (dd > d.get(n)) continue;
    for (const m of this.adj.get(n) || []) {
      const nd = dd + edgeLen(n, m) + (this.isJunction(m) ? 0.3 : 0);
      if (nd < (d.get(m) ?? Infinity)) { d.set(m, nd); prev.set(m, n); open.push([nd, m]); }
    }
  }
  d.prev = prev;
  this.distCache.set(from, d);
  return d;
};
P.route = function (from, to) {
  if (from === to) return [from];
  const d = this.dist(to);          // walk back along the tree rooted at the goal
  if (!d.has(from)) return null;
  const path = [from];
  let n = from;
  while (n !== to) { n = d.prev.get(n); path.push(n); }
  return path;
};

// ---- buildings ----------------------------------------------------------------

P.canPlace = function (kind, i) {
  if (i < 0 || !this.inBounds(i) || this.tileB.has(i) || this.adj.has(i)) return false;
  const k = KINDS[kind], t = this.terrain[i];
  if (t === WATER) return false;
  if (k.on !== undefined) return t === k.on;
  if (k.near !== undefined) {
    const [x, y] = xy(i);
    return STEPS8.some(([dx, dy]) => this.terrain[at(x + dx, y + dy)] === k.near);
  }
  return true;
};
P.place = function (kind, i, free) {
  if (!this.canPlace(kind, i)) return null;
  const k = KINDS[kind];
  if (!free) { if (!this.tokens[kind]) return null; this.tokens[kind]--; }
  const b = { id: this.nextId++, kind, tile: i, door: -1, out: 0, inBuf: {}, prog: 0, trucks: [], born: this.time, free };
  for (const g in k.needs || {}) b.inBuf[g] = 0;
  if (this.terrain[i] === FOREST) { this.terrain[i] = GRASS; this.wood.delete(i); }   // built over: cleared
  if (k.shop) { b.stock = {}; b.sells = new Set(); b.shelf = {}; }
  if (k.depot) { b.yard = {}; b.carries = new Set(); }
  this.buildings.set(b.id, b); this.tileB.set(i, b.id);
  this.findDoor(b);
  // lorries to fetch with; raw makers wait to be fetched from
  for (let n = 0; n < (k.shop ? SHOP_LORRIES : k.needs || k.depot ? 1 : 0); n++) this.addTruck(b);
  this.unlocked.add(kind);
  this.release();
  this.first('built:' + kind);
  this.emit({ type: 'place', id: b.id, tile: i });
  return b;
};
P.removeBuilding = function (id) {
  const b = this.B(id);
  if (!b) return false;
  // the building comes back to hand
  if (!b.house && !b.free) this.tokens[b.kind] = (this.tokens[b.kind] || 0) + 1;
  for (const v of this.vehicles.filter(v => v.dest === id && v.home !== id && v.state === 'wait')) this.goHome(v, b.door);
  for (const v of this.vehicles.filter(v => v.home === id)) this.dropVehicle(v);
  for (const p of this.pins.filter(p => p.at === id)) this.killPin(p);
  this.buildings.delete(id); this.tileB.delete(b.tile);
  this.emit({ type: 'remove', tile: b.tile });
  // a family whose house came down moves to a cottage nearby, if there's room;
  // what the house had grown into is lost
  if (b.house) {
    const [x, y] = xy(b.tile);
    let best = -1, bd = Infinity;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const i = at(x + dx, y + dy), d = Math.max(Math.abs(dx), Math.abs(dy));
      if (d < 2 || !this.homeOk(i)) continue;
      const score = d + this.r() - (STEPS4.some(([ex, ey]) => this.adj.has(at(x + dx + ex, y + dy + ey))) ? 1 : 0);
      if (score < bd) { bd = score; best = i; }
    }
    if (best >= 0) this.addHouse(best, true);
    else this.emit({ type: 'leave', tile: b.tile, gone: true, level: b.level, good: Object.keys(LEVELS[b.level].wants)[0] });
  }
  return true;
};

// ---- houses -------------------------------------------------------------------

P.addHouse = function (i, first) {
  const h = { id: this.nextId++, house: true, tile: i, door: -1, level: 1, happy: 0, timers: {}, born: this.time };
  for (const g in LEVELS[1].wants) h.timers[g] = first ? 3 : 4 + this.r() * 10;
  this.buildings.set(h.id, h); this.tileB.set(i, h.id);
  this.findDoor(h);
  this.addCar(h);
  if (!first) { this.roads += HOUSE_ROADS; this.arrived += LEVELS[1].people; }
  this.emit({ type: 'spawn', id: h.id, tile: i });
  return h;
};
P.homeOk = function (i) {
  return i >= 0 && this.inBounds(i) && this.terrain[i] === GRASS && !this.tileB.has(i) && !this.adj.has(i) && !this.loudNear(i);
};
P.spawnSpot = function () {
  const houses = [...this.buildings.values()].filter(b => b.house);
  const ok = i => this.homeOk(i);
  this.spawned++;
  const hamlet = this.spawned >= 8 && this.spawned % 7 === 1;
  if (!hamlet && houses.length) {
    for (let tries = 0; tries < 60; tries++) {
      const h = houses[(this.r() * houses.length) | 0];
      const [x, y] = xy(h.tile);
      const i = at(x + Math.round((this.r() - 0.5) * 5), y + Math.round((this.r() - 0.5) * 5));
      if (!ok(i)) continue;
      // tiles beside a road are likelier: the town grows along its streets
      const [ix, iy] = xy(i);
      const byRoad = STEPS4.some(([dx, dy]) => this.adj.has(at(ix + dx, iy + dy)));
      if (byRoad || this.r() < 0.35) return i;
    }
  }
  // a new hamlet: somewhere open, away from everyone
  const b = this.bounds;
  let best = -1, bestD = -1;
  for (let tries = 0; tries < 80; tries++) {
    const i = at(b.x0 + 1 + ((this.r() * (b.x1 - b.x0 - 1)) | 0), b.y0 + 1 + ((this.r() * (b.y1 - b.y0 - 1)) | 0));
    if (!ok(i)) continue;
    const d = Math.min(99, ...houses.map(h => cheb(h.tile, i)), ...[...this.buildings.values()].filter(x => !x.house).map(x => cheb(x.tile, i) + 2));
    if (d >= 5 && d <= 9 && d > bestD) { best = i; bestD = d; }
  }
  return best;
};
P.addPin = function (atId, good, kind) {
  const p = { id: this.nextId++, at: atId, good, kind, born: this.time, by: -1, dead: false };
  this.pins.push(p);
  this.unlock(MAKER[good]);
  return p;
};
// A chain arrives from its raw end: what feeds a maker comes to hand first,
// and the maker itself once its supply is down on the map.
P.unlock = function (kind) {
  if (this.unlocked.has(kind)) return;
  this.unlocked.add(kind);
  this.waiting.add(kind);
  for (const g in KINDS[kind].needs || {}) this.unlock(MAKER[g]);
  this.release();
};
P.release = function () {
  const down = k => [...this.buildings.values()].some(b => b.kind === k);
  for (const kind of [...this.waiting]) {
    if (!Object.keys(KINDS[kind].needs || {}).every(g => down(MAKER[g]))) continue;
    this.waiting.delete(kind);
    this.tokens[kind] = (this.tokens[kind] || 0) + 1;
    this.first('unlock:' + kind);
    const next = [...this.waiting].find(k => KINDS[k].needs && KINDS[k].needs[KINDS[kind].out]);
    this.emit({ type: 'unlock', kind, why: next ? `${KINDS[next].why.split('. ')[0]}. First, ${KINDS[kind].why[0].toLowerCase()}${KINDS[kind].why.slice(1)} Once it's down, the ${KINDS[next].name.toLowerCase()} comes.` : KINDS[kind].why });
  }
};
P.killPin = function (p) {
  p.dead = true;
  this.pins.splice(this.pins.indexOf(p), 1);
};
P.levelDown = function (h, good) {
  for (const p of this.pins.filter(p => p.at === h.id)) this.killPin(p);
  this.stats.left++;
  this.leftThisWeek++;
  this.first('left');
  h.happy = 0;
  if (h.level === 1) {
    for (const v of this.vehicles.filter(v => v.home === h.id)) { this.sendHome(v); this.dropVehicle(v); }
    this.buildings.delete(h.id); this.tileB.delete(h.tile);
    this.emit({ type: 'leave', tile: h.tile, good, gone: true });
  } else {
    h.level--;
    this.fitCars(h);
    h.timers = {};
    for (const g in LEVELS[h.level].wants) h.timers[g] = 8 + this.r() * 8;
    this.emit({ type: 'leave', tile: h.tile, good, gone: false, id: h.id });
  }
};
// How dark it is, 0 by day to 1 at night. Makers and lorries work through
// the night; residents mostly stay in, so the roads clear and lorries catch up.
P.dark = function () {
  const ph = (this.time / DAY) % 1;
  return ph < 0.68 ? 0 : ph < 0.74 ? (ph - 0.68) / 0.06 : ph < 0.94 ? 1 : (1 - ph) / 0.06;
};
// Shops sell by day; at night their shutters are down and they only take in stock.
P.open = function () { return this.dark() < 0.5; };
P.tickHouse = function (h, dt) {
  const L = LEVELS[h.level];
  // nothing is used while everyone's at work; less at night, when the shops are shut
  const home = this.vehicles.some(v => v.car && v.home === h.id && v.state !== 'work' && !v.commuting);
  const busy = home ? 1 - 0.7 * this.dark() : 0;
  for (const g in L.wants) {
    if (this.pins.some(p => p.at === h.id && p.good === g)) continue;
    h.timers[g] -= dt * busy;
    if (h.timers[g] <= 0) { this.addPin(h.id, g, 'want'); this.stats.wanted[g] = (this.stats.wanted[g] || 0) + 1; h.timers[g] = L.wants[g] * (0.85 + this.r() * 0.3); }
  }
  for (const p of this.pins) {
    if (p.at !== h.id || p.kind !== 'want') continue;
    p.age = (p.age || 0) + dt * busy;
    if (p.age > PATIENCE) { this.levelDown(h, p.good); return; }
  }
  h.quiet = this.loudNear(h.tile);
  const building = this.pins.some(p => p.at === h.id && p.kind === 'build');
  if (L.grow && !building && h.happy >= L.after && !h.quiet) {
    for (const g in L.grow) for (let n = 0; n < L.grow[g]; n++) this.addPin(h.id, g, 'build');
    this.first('grow:' + h.level);
  }
};

// What a shop sells is what the houses that shop there want; it keeps a few of
// each on its shelves, and pins for more when they run low.
P.tickShop = function (b) {
  for (const g of b.sells) {
    let have = (b.stock[g] || 0) + this.pins.filter(p => p.at === b.id && p.good === g).length;
    while (have < (b.shelf[g] || SHELF)) { this.addPin(b.id, g, 'input'); have++; }
  }
  const empty = [...b.sells].some(g => !(b.stock[g] > 0));
  b.idle = !b.sells.size ? 'quiet' : empty ? 'starved' : '';
};
// Every shop stocks what the houses within its reach want, building materials
// too; a house within reach of two shops counts half at each, so a second shop
// beside a busy one takes half the work. A house's own shop is its nearest.
P.catchment = function () {
  const shops = [...this.buildings.values()].filter(b => b.stock && b.door >= 0);
  const share = new Map(shops.map(sh => [sh, {}]));
  for (const sh of shops) sh.sells = new Set();
  for (const h of this.buildings.values()) {
    if (!h.house) continue;
    h.shop = this.nearestShop(h);
    if (h.door < 0) continue;
    const near = shops.filter(sh => { const d = this.dist(sh.door).get(h.door); return d !== undefined && d <= REACH; });
    const goods = new Set([...Object.keys(LEVELS[h.level].wants), ...this.pins.filter(p => p.at === h.id && p.kind === 'build').map(p => p.good)]);
    for (const sh of near) for (const g of goods) { sh.sells.add(g); share.get(sh)[g] = (share.get(sh)[g] || 0) + 1 / near.length; }
  }
  for (const sh of shops) { sh.shelf = {}; for (const g in share.get(sh)) sh.shelf[g] = Math.min(SHELF_MAX, SHELF + Math.ceil(DAY_NEED * share.get(sh)[g])); }
};
// A depot keeps a yard of what the buildings round it use, and pins for more.
P.tickDepot = function (b) {
  if (this.tick % 60 === 1 || !b.carries.size) {
    b.carries = new Set();
    const d = b.door >= 0 ? this.dist(b.door) : new Map();
    for (const o of this.buildings.values()) {
      if (o.house || o === b || o.yard || o.door < 0 || (d.get(o.door) ?? Infinity) > DEPOT_REACH) continue;
      for (const g of o.stock ? o.sells : Object.keys(KINDS[o.kind].needs || {})) b.carries.add(g);
    }
  }
  for (const g of b.carries) {
    let have = (b.yard[g] || 0) + this.pins.filter(p => p.at === b.id && p.good === g).length;
    while (have < DEPOT_YARD) { this.addPin(b.id, g, 'input'); have++; }
  }
  b.idle = b.carries.size ? '' : 'quiet';
};
// A shop out of something with every lorry out fetching: it can't keep up.
P.swamped = function (b) {
  return !!b.stock && b.idle === 'starved' && b.trucks.every(id => this.vehicles.find(u => u.id === id)?.state !== 'in');
};
P.nearestShop = function (h) {
  if (h.door < 0) return null;
  let best = null, bd = Infinity;
  for (const sh of this.buildings.values()) {
    if (!sh.stock || sh.door < 0) continue;
    const d = this.dist(sh.door).get(h.door);
    if (d !== undefined && d <= REACH && d < bd) { bd = d; best = sh.id; }
  }
  return best;
};
P.tickProducer = function (b, dt) {
  if (b.stock) return this.tickShop(b);
  if (b.yard) return this.tickDepot(b);
  const k = KINDS[b.kind];
  // input pins: keep two loads' worth on hand or on the way
  for (const g in k.needs || {}) {
    const want = k.needs[g] * 2;
    let have = b.inBuf[g] + this.pins.filter(p => p.at === b.id && p.good === g).length;
    while (have < want) { this.addPin(b.id, g, 'input'); have++; }
  }
  const fed = Object.entries(k.needs || {}).every(([g, n]) => b.inBuf[g] >= n);
  const tree = k.near === FOREST ? this.nearestWood(b.tile) : 0;
  b.idle = b.out >= OUT_CAP ? 'full' : !fed ? 'starved' : tree < 0 ? 'cleared' : '';
  if (!b.idle) {
    b.prog += dt / k.time * (0.25 + 0.75 * Math.min(1, b.crew / SEATS));
    if (b.prog >= 1) {
      b.prog = 0;
      for (const g in k.needs || {}) b.inBuf[g] -= k.needs[g];
      if (tree > 0) this.fell(tree);
      b.out++; this.stats.made[k.out] = (this.stats.made[k.out] || 0) + 1;
      this.first('made:' + k.out);
    }
  }
};

// A woodcutter fells the forest round it, two tiles each way, until it's bare.
// How much forest a woodcutter at i would have to itself: each forest tile in
// its reach counts, shared evenly with the other woodcutters that reach it.
// It never runs dry at WOOD_NEED or more.
P.forestShare = function (i, self) {
  const [x, y] = xy(i);
  const cutters = [...this.buildings.values()].filter(b => b.kind === 'woodcutter' && b.id !== self);
  let share = 0;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const j = at(x + dx, y + dy);
    if (j < 0 || j === i || this.terrain[j] !== FOREST) continue;
    const [jx, jy] = xy(j);
    share += 1 / (1 + cutters.filter(b => { const [bx, by] = xy(b.tile); return Math.abs(bx - jx) <= 2 && Math.abs(by - jy) <= 2; }).length);
  }
  return share;
};
P.nearestWood = function (i) {
  const [x, y] = xy(i);
  let best = -1, bd = 99;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const j = at(x + dx, y + dy);
    if (j >= 0 && this.wood.get(j) > 0) { const d = Math.max(Math.abs(dx), Math.abs(dy)); if (d < bd) { bd = d; best = j; } }
  }
  return best;
};
// Felling takes a log from a tile; trees grow back a log at a time, so a
// woodcutter with enough forest round it never runs dry.
P.fell = function (j) {
  this.wood.set(j, this.wood.get(j) - 1);
  if (this.wood.get(j) === 0) { this.first('felled'); this.emit({ type: 'felled', tile: j }); }
};
P.regrow = function (dt) {
  this.growT = (this.growT || 0) + dt;
  if (this.growT < REGROW) return;
  this.growT -= REGROW;
  for (const [j, n] of this.wood) if (n < WOOD && this.terrain[j] === FOREST) this.wood.set(j, n + 1);
};

// ---- fetching -----------------------------------------------------------------
// Pull: whoever needs something goes and gets it. A house's car drives to a
// shop, a shop's or a workshop's lorry to whoever makes what it lacks. Makers of
// raw goods have no lorry; they stack their yard and wait to be fetched from.

const LOAD = 3, SHOP_LOAD = 10, DEPOT_LOAD = 20;
const DEPOT_REACH = 14, DEPOT_YARD = 12;   // a depot stocks what buildings this far by road use, this many of each   // crates a lorry carries; a shop's are bigger
const SPOTS = 2, SHOP_SPOTS = 4;   // vehicles that can wait beside a building
const SHOP_LORRIES = 2;   // a busier town needs more shops, not bigger ones

// What a building has of a good for whoever comes for it.
P.avail = function (b, g) {
  if (!b) return 0;
  if (b.stock) return b.stock[g] || 0;
  if (b.yard) return b.yard[g] || 0;
  return KINDS[b.kind].out === g ? b.out : 0;
};
P.take = function (b, g) {
  if (b.stock) b.stock[g]--; else if (b.yard) b.yard[g]--; else b.out--;
};
// What a vehicle has on board, by good.
P.cargo = function (v) { return v.claims.filter(q => v.bag.includes(q.id)).map(q => q.good); };
P.waitingAt = function (b) {
  let n = 0;
  for (const v of this.vehicles) if (!(v.car && v.dest === v.job) && v.dest === b.id && v.dest !== v.home && (v.state === 'wait' || v.state === 'drive' || v.state === 'leave')) n++;
  return n;
};
P.spots = function (b) { return b.stock ? SHOP_SPOTS : SPOTS; };
// The nearest place a vehicle from home can get g: one that has it, else one
// that makes or sells it with room to wait.
P.source = function (home, g, car) {
  let best = null, bd = Infinity, wait = null, wd = Infinity;
  for (const b of this.buildings.values()) {
    if (b.door < 0 || b === home) continue;
    // a lorry fetches from whoever makes it, or from a depot that has it in
    if (b.house || (car ? !b.stock : !(KINDS[b.kind].out === g || (b.yard && !home.yard && this.avail(b, g) > 0)))) continue;
    if (car && (!b.sells.has(g) || !this.open())) continue;
    const d = this.dist(b.door).get(home.door);
    if (d === undefined || (car && d > REACH)) continue;
    if (this.avail(b, g) > 0) { if (d < bd) { bd = d; best = b; } }
    else if (this.waitingAt(b) < this.spots(b) && d < wd) { wd = d; wait = b; }
  }
  return best || wait;
};

P.addCar = function (h) {
  const v = { id: this.nextId++, car: true, home: h.id, job: -1, rest: this.r() * REST, commuting: false, cap: LOAD + 1, state: 'in', claims: [], bag: [], route: null, seg: 0, d: 0, wait: 0, ghost: 0, lock: -1, dest: -1, hop: 0 };
  this.vehicles.push(v);
  return v;
};
// Every house's car is also its worker's: it drives to a job at the nearest
// maker with a seat free and keeps it, each house on its own hours. It shops
// only when off shift, on the way home from work if something is wanted.
P.findJob = function (home) {
  const taken = new Map();
  for (const v of this.vehicles) if (v.car && v.job >= 0) taken.set(v.job, (taken.get(v.job) || 0) + 1);
  const d = this.dist(home.door);
  let best = null, bd = Infinity;
  for (const b of this.buildings.values()) {
    if (b.house || b.stock || b.yard || b.door < 0 || (taken.get(b.id) || 0) >= JOBS) continue;
    const dd = d.get(b.door) ?? Infinity;
    if (dd < bd) { bd = dd; best = b; }
  }
  return best;
};
P.commute = function (v, dt, home) {
  if (v.state === 'work') {
    v.wait += dt;
    const job = this.B(v.job);
    if (v.wait < SHIFT && job) return;
    v.commuting = true;
    if (job) this.errand(v, home, job.door);
    if (v.state === 'work') this.goHome(v, job ? job.door : -1);
    return;
  }
  if (home.door < 0) return;
  if ((v.rest -= dt) <= 0) {
    if (!this.B(v.job)) v.job = this.findJob(home)?.id ?? -1;
    if (v.job >= 0 && this.depart(v, home.door, v.job)) { v.state = 'leave'; v.commuting = true; return; }
    v.rest = 5;
  }
  this.errand(v, home, home.door);
};
// A cottage has one car, and a house or bigger two: two workers, two errands.
P.fitCars = function (h) {
  const cars = this.vehicles.filter(v => v.car && v.home === h.id), want = h.level >= 2 ? 2 : 1;
  for (let n = cars.length; n < want; n++) this.addCar(h);
  for (const v of cars.slice(want)) this.dropVehicle(v);
};
P.addTruck = function (b) {
  const v = { id: this.nextId++, home: b.id, cap: b.stock ? SHOP_LOAD : b.yard ? DEPOT_LOAD : LOAD, state: 'in', claims: [], bag: [], route: null, seg: 0, d: 0, wait: 0, ghost: 0, lock: -1, dest: -1, hop: 0 };
  b.trucks.push(v.id);
  this.vehicles.push(v);
  return true;
};

// Set off for what home lacks, the oldest need first.
P.errand = function (v, home, from = home.door) {
  if (from < 0) return;
  // wants first (a family waits on them), then the oldest
  const open = this.pins.filter(p => p.at === home.id && p.by < 0).sort((a, b) => (a.kind === 'want' ? 0 : 1) - (b.kind === 'want' ? 0 : 1) || a.born - b.born);
  // what's ready somewhere first; only if nothing is, go and wait for it
  const tries = [];
  for (const p of open) { const src = this.source(home, p.good, v.car); if (src) tries.push([p, src]); }
  tries.sort((a, b) => (this.avail(b[1], b[0].good) > 0) - (this.avail(a[1], a[0].good) > 0));
  for (const [p, src] of tries) {
    if (!this.depart(v, from, src.id)) continue;
    // a car buys everything the house wants that this shop sells; a lorry
    // fills up with the one good
    v.claims = (v.car ? open.filter(q => src.sells.has(q.good)) : open.filter(q => q.good === p.good)).slice(0, v.cap);
    for (const q of v.claims) q.by = v.id;
    v.bag = [];
    // what's there now is set aside for it
    for (const q of v.claims) if (this.avail(src, q.good) > 0) { this.take(src, q.good); v.bag.push(q.id); }
    v.state = 'leave';
    return;
  }
};
// Waiting beside a building: take each crate as it comes, first come first
// served; go home once everything is in, or with what's in once it's slow.
P.load = function (v, dt) {
  const src = this.B(v.dest);
  if (!src) return this.goHome(v, this.B(v.home)?.door);
  if (v.car && !this.open()) return this.goHome(v, src.door);
  v.claims = v.claims.filter(q => !q.dead || v.bag.includes(q.id));
  // what home has come to need meanwhile, if it's here, comes along too
  for (const q of this.pins) if (q.at === v.home && q.by < 0 && v.claims.length < v.cap && this.avail(src, q.good) > 0 && (v.car ? src.sells.has(q.good) : true)) { q.by = v.id; v.claims.push(q); }
  for (const q of v.claims) if (!v.bag.includes(q.id) && this.avail(src, q.good) > 0) { this.take(src, q.good); v.bag.push(q.id); v.waited = 0; }
  v.waited = (v.waited || 0) + dt;
  const done = v.claims.every(q => v.bag.includes(q.id));
  // home once it has it all; with what it has once it's slow; empty-handed
  // once it's clear nothing is coming
  if (done || (v.bag.length && v.waited > 6) || v.waited > 25 || !v.claims.length) this.goHome(v, src.door);
};
P.goHome = function (v, node) {
  for (const q of v.claims) if (!v.bag.includes(q.id)) q.by = -1;
  v.claims = v.claims.filter(q => v.bag.includes(q.id));
  if (node !== undefined && node >= 0 && this.depart(v, node, v.home)) { v.state = 'leave'; return; }
  this.sendHome(v);
};
// Home with the load: every need it answers is met.
P.unpack = function (v) {
  const b = this.B(v.home);
  for (const q of v.claims) {
    if (q.dead || !v.bag.includes(q.id)) continue;
    this.killPin(q);
    this.stats.delivered++;
    if (!b) continue;
    if (b.house) {
      if (q.kind === 'want') { b.happy++; this.first('fed'); }
      this.emit({ type: 'deliver', tile: b.tile, good: q.good, pay: GOODS[q.good].pay });
      if (q.kind === 'build' && !this.pins.some(r => r.at === b.id && r.kind === 'build')) {
        b.level++;
        this.fitCars(b);
        b.happy = 0;
        for (const g in LEVELS[b.level].wants) if (b.timers[g] === undefined) b.timers[g] = 6 + this.r() * 6;
        this.first('level:' + b.level);
        this.arrived += LEVELS[b.level].people - LEVELS[b.level - 1].people;
        this.emit({ type: 'grow', id: b.id, tile: b.tile, level: b.level });
      }
    } else {
      if (b.stock) b.stock[q.good] = (b.stock[q.good] || 0) + 1;
      else if (b.yard) b.yard[q.good] = (b.yard[q.good] || 0) + 1;
      else b.inBuf[q.good] = (b.inBuf[q.good] || 0) + 1;
      this.emit({ type: 'deliver', tile: b.tile, good: q.good, pay: 0 });
    }
  }
  for (const q of v.claims) if (!q.dead) q.by = -1;
  v.claims = []; v.bag = [];
};
// Pulled off the road: back inside; what it carried is lost, what it asked
// for is open again.
P.sendHome = function (v) {
  const lane = this.laneOf(v);
  if (lane) lane.splice(lane.indexOf(v), 1);
  this.releaseLock(v);
  for (const q of v.claims) if (!q.dead) q.by = -1;
  Object.assign(v, { state: 'in', claims: [], bag: [], route: null, dest: -1, wait: 0, ghost: 0 });
};
P.dropVehicle = function (v) {
  this.sendHome(v);
  this.vehicles.splice(this.vehicles.indexOf(v), 1);
};

// ---- traffic -----------------------------------------------------------------

P.laneOf = function (v) {
  if (v.state !== 'drive' || !v.route || v.seg >= v.route.length - 1) return null;
  return this.lanes.get(ekey(v.route[v.seg], v.route[v.seg + 1])) || null;
};
P.releaseLock = function (v) {
  if (v.lock < 0) return;
  const l = this.locks.get(v.lock);
  if (l) { l.delete(v); if (!l.size) this.locks.delete(v.lock); }
  v.lock = -1;
};
P.tryLock = function (v, node) {
  if (!this.isJunction(node)) return true;
  if (v.lock === node) return true;
  const l = this.locks.get(node) || new Set();
  if (l.size >= this.lockCap(node) && !v.ghost) return false;
  this.releaseLock(v);
  l.add(v); this.locks.set(node, l); v.lock = node;
  return true;
};
P.roomAt = function (a, b) {
  const lane = this.lanes.get(ekey(a, b));
  return !lane || !lane.length || lane[lane.length - 1].d >= GAP;
};
P.enter = function (v, a, b) {
  const k = ekey(a, b);
  if (!this.lanes.has(k)) this.lanes.set(k, []);
  this.lanes.get(k).push(v);
};

// Set a truck off from where it stands (its current node) to a building.
P.depart = function (v, node, destId) {
  const dest = this.B(destId);
  if (!dest || dest.door < 0) return false;
  const route = this.route(node, dest.door);
  if (!route) return false;
  Object.assign(v, { route, seg: 0, d: 0, dest: destId, wait: 0 });
  return true;
};

P.tickVehicleIdle = function (v, dt) {
  const home = this.B(v.home);
  if (!home) return;
  if (v.car && v.state !== 'wait') return this.commute(v, dt, home);
  if (v.state === 'in') this.errand(v, home);
  else if (v.state === 'wait') this.load(v, dt);
};
P.step = function (dt) {
  const s = this;
  if (s.offer) return;          // the pick waits for the player
  s.weekT = (s.arrived - s.pickFrom) / PICK_STEP;   // people who moved in or up, not who stayed
  if (s.weekT >= 1) { s.pickFrom += PICK_STEP; s.week++; s.offer = s.makeOffer(); s.emit({ type: 'week', week: s.week }); return; }
  s.time += dt;
  s.tick = (s.tick || 0) + 1;
  // dawn: the day that ended, and a streak of days nobody left
  const day = Math.floor(s.time / DAY) + 1;
  if (day > s.day) {
    const moved = s.arrived - s.dayFrom.arrived, left = s.stats.left - s.dayFrom.left;
    s.streak = left ? 0 : s.streak + 1;
    if (!left) s.roads += CLEAN_DAY_ROADS;
    s.emit({ type: 'day', day, moved, left, streak: s.streak, roads: left ? 0 : CLEAN_DAY_ROADS });
    s.day = day; s.dayFrom = { arrived: s.arrived, left: s.stats.left };
  }
  s.regrow(dt);

  // spawning
  s.nextSpawn -= dt;
  if (s.nextSpawn <= 0) {
    const i = s.spawnSpot();
    if (i >= 0) s.addHouse(i, false);
    const houses = [...s.buildings.values()].filter(b => b.house);
    const strained = houses.length ? houses.filter(h => s.pins.some(p => p.at === h.id && p.kind === 'want' && s.time - p.born > PATIENCE * 0.5)).length / houses.length : 0;
    const early = [25, 20];
    s.nextSpawn = (s.spawned <= early.length ? early[s.spawned - 1] : Math.max(6, 24 - s.time / 40)) * (1 + 0.8 * strained);
  }

  if (s.tick % 60 === 1) s.catchment();
  for (const b of s.buildings.values()) b.crew = 0;
  for (const v of s.vehicles) if (v.car && v.job >= 0 && !v.commuting) { const b = s.B(v.job); if (b) b.crew++; }
  for (const b of [...s.buildings.values()]) {
    if (!s.buildings.has(b.id)) continue;
    if (b.house) s.tickHouse(b, dt); else s.tickProducer(b, dt);
  }

  // status and the map growing with it
  const pop = s.people();
  let st = 0;
  while (st + 1 < STATUSES.length && pop >= STATUSES[st + 1].at) st++;
  if (st > s.status) { s.status = st; if (st >= 2) s.unlock('depot'); s.computeBounds(); s.first('status:' + st); s.emit({ type: 'status', name: STATUSES[st].name }); }
  s.best = Math.max(s.best || 0, pop);

  // trucks parked or at a door
  for (const v of [...s.vehicles]) {
    if (v.state === 'in' || v.state === 'wait' || v.state === 'work') s.tickVehicleIdle(v, dt);
  }
  // trucks waiting to pull out onto the road
  for (const v of s.vehicles) {
    if (v.state !== 'leave') continue;
    if (v.route.length === 1) { s.arrive(v); continue; }
    const [a, b] = v.route;
    if (!s.adj.get(a)?.has(b)) { s.reroute(v, a); continue; }
    if (s.roomAt(v.route[0], v.route[1]) && s.tryLock(v, v.route[0])) {
      v.state = 'drive'; v.d = 0; v.seg = 0; v.hop = 0.25;
      s.enter(v, v.route[0], v.route[1]);
    }
  }
  s.moveTraffic(dt);
};

P.arrive = function (v) {
  // off the road, into the building at the end of the route
  this.releaseLock(v);
  v.route = null;
  // a car's trip to work ends at work; its trip from work at the shop or home
  const toWork = v.car && v.commuting && v.dest === v.job;
  v.commuting = false;
  if (v.dest === v.home) {
    this.unpack(v); v.state = 'in'; v.dest = -1;
    if (v.shiftDone) { v.shiftDone = false; v.rest = REST * (0.7 + 0.6 * this.r()); }
    return;
  }
  if (toWork) { v.state = 'work'; v.wait = 0; v.shiftDone = true; return; }
  v.state = 'wait'; v.waited = 0;
};
// Off the road at a node, the way ahead gone: find another, or give up and go in.
P.reroute = function (v, node) {
  this.releaseLock(v);
  v.d = 0;
  if (this.depart(v, node, v.dest)) { v.state = 'leave'; return; }
  if (v.dest !== v.home) { this.goHome(v, node); return; }
  this.sendHome(v);
};

P.moveTraffic = function (dt) {
  const s = this;
  const step = SPEED * dt;
  for (const [key, lane] of [...s.lanes]) {
    for (let i = 0; i < lane.length; i++) {
      const v = lane[i];
      if (v.moved === s.tick) continue;
      v.moved = s.tick;
      if (v.hop > 0) v.hop = Math.max(0, v.hop - dt);
      const a = v.route[v.seg], b = v.route[v.seg + 1];
      const len = edgeLen(a, b);
      const last = v.seg + 1 === v.route.length - 1;
      if (v.ghost > 0) v.ghost = Math.max(0, v.ghost - dt);
      let limit = len;
      if (i > 0 && !v.ghost) limit = Math.min(limit, lane[i - 1].d - GAP);
      // release the junction behind once clear of it
      if (v.lock === a && v.d >= STOP) s.releaseLock(v);
      let blocked = false;
      if (last) {
        limit = Math.min(limit, len - 0.3);
      } else if (s.isJunction(b) && v.lock !== b) {
        if (v.d + step >= len - STOP) {
          const c = v.route[v.seg + 2];
          if (s.adj.get(b)?.has(c) && (s.roomAt(b, c) || v.ghost) && s.tryLock(v, b)) { /* through */ }
          else { limit = Math.min(limit, len - STOP); blocked = true; }
        }
      }
      const before = v.d;
      v.d = Math.max(v.d, Math.min(v.d + step, limit));
      if (last && v.d >= len - 0.3 - 1e-6) {
        lane.splice(i, 1); i--;
        s.arrive(v);
        continue;
      }
      if (!last && v.d >= len - 1e-6) {
        const c = v.route[v.seg + 2];
        if (!s.adj.get(b)?.has(c) || !s.buildings.has(v.dest)) {
          // the road ahead went, or where it was going did: think again from this corner
          lane.splice(i, 1); i--;
          s.reroute(v, b);
          continue;
        }
        if (s.roomAt(b, c) || v.ghost) {
          lane.splice(i, 1); i--;
          v.d -= len; v.seg++;
          s.enter(v, b, c);
        } else {
          v.d = len; blocked = true;
        }
      }
      if (v.d - before < step * 0.25) {
        v.wait += dt;
        if (blocked && s.isJunction(b) && v.wait > 3) {
          s.jamAt = b;
          if (!s.tools.has('roundabout')) { s.tools.add('roundabout'); s.tokens.roundabout++; s.first('jam'); s.emit({ type: 'jam', tile: b }); }
        }
        if (v.wait > GHOST) { v.ghost = 2.5; v.wait = 0; }
      } else v.wait = 0;
    }
    if (!lane.length) s.lanes.delete(key);
  }
};

// ---- the week's pick ---------------------------------------------------------------

P.backlog = function (good) {
  return this.pins.filter(p => p.good === good && p.by < 0 && this.time - p.born > 8 && !this.B(p.at)?.yard).length;
};
// Where a shortage of a good really comes from: its makers waiting on an input
// (follow that input), or too few makers.
P.rootOf = function (good, depth = 0) {
  const kind = MAKER[good];
  const makers = [...this.buildings.values()].filter(b => b.kind === kind && b.door >= 0);
  if (!makers.length || depth > 4) return this.tokens[kind] ? null : 'kind:' + kind;
  const starved = makers.find(b => b.idle === 'starved');
  if (starved) for (const g in KINDS[kind].needs) if (starved.inBuf[g] < KINDS[kind].needs[g]) return this.rootOf(g, depth + 1);
  return 'kind:' + kind;
};
P.makeOffer = function () {
  const s = this;
  const cands = [];
  // each good that's short counts toward what would really fix it
  const weight = {};
  // (a want that sends a family away counts thrice a crate a building waits for)
  for (const k of s.unlocked) {
    const g = KINDS[k].out, n = s.pins.filter(p => p.good === g && p.by < 0 && s.time - p.born > 8 && !s.B(p.at)?.yard).reduce((a, p) => a + (p.kind === 'want' ? 3 : 1), 0);
    const r = n && s.rootOf(g); if (r) weight[r] = (weight[r] || 0) + n;
  }
  // houses with no shop in reach want one
  weight['kind:shop'] = [...s.buildings.values()].filter(h => h.house && h.door >= 0 && h.shop == null).length * 1.5
    + [...s.buildings.values()].filter(sh => s.swamped(sh)).length * 6;
  for (const k of s.unlocked) cands.push({ type: 'kind', kind: k, n: 1, w: 1 + (weight['kind:' + k] || 0) * 2 });
  cands.push({ type: 'roads', n: 15, w: s.roads < 10 ? 6 : 2 });
  if (s.tools.has('roundabout')) cands.push({ type: 'roundabout', n: 2, w: 2 });
  const want = s.leftThisWeek === 0 ? 3 : 2;   // a week nobody left earns a wider choice
  const out = [];
  // the most needed thing is always on the table; the rest is luck, weighted
  cands.sort((a, b) => b.w - a.w);
  out.push(cands.shift());
  while (out.length < want && cands.length) {
    const tot = cands.reduce((a, c) => a + c.w, 0);
    let r = s.r() * tot, k = 0;
    while (r > cands[k].w) { r -= cands[k].w; k++; }
    out.push(cands.splice(k, 1)[0]);
  }
  return out;
};
P.pick = function (n) {
  const o = this.offer && this.offer[n];
  if (!o) return false;
  if (o.type === 'kind') this.tokens[o.kind] = (this.tokens[o.kind] || 0) + o.n;
  else if (o.type === 'roads') this.roads += o.n;
  else if (o.type === 'roundabout') this.tokens.roundabout += o.n;
  this.offer = null;
  this.leftThisWeek = 0;
  return true;
};

// ---- read-outs for the screen and the bot -----------------------------------------

// Where a truck is on the map, in tile units, smoothed round corners.
P.vehiclePose = function (v) {
  if (v.state !== 'drive') return null;
  const r = v.route, a = r[v.seg], b = r[v.seg + 1];
  const [ax, ay] = xy(a), [bx, by] = xy(b);
  const len = edgeLen(a, b);
  const ux = (bx - ax) / len, uy = (by - ay) / len;
  const R = 0.35;
  let x = ax + ux * v.d, y = ay + uy * v.d, hx = ux, hy = uy;
  const corner = (px, py, qx, qy, cx, cy, t) => {
    const mt = 1 - t;
    return [mt * mt * px + 2 * mt * t * cx + t * t * qx, mt * mt * py + 2 * mt * t * cy + t * t * qy,
            2 * mt * (cx - px) + 2 * t * (qx - cx), 2 * mt * (cy - py) + 2 * t * (qy - cy)];
  };
  if (v.d < R && v.seg > 0) {
    const p = r[v.seg - 1], [px, py] = xy(p), pl = edgeLen(p, a);
    const vx = (ax - px) / pl, vy = (ay - py) / pl;
    if (vx !== ux || vy !== uy) {
      const t = 0.5 + v.d / (2 * R);
      [x, y, hx, hy] = corner(ax - vx * R, ay - vy * R, ax + ux * R, ay + uy * R, ax, ay, t);
    }
  } else if (v.d > len - R && v.seg + 2 < r.length) {
    const c = r[v.seg + 2], [cx, cy] = xy(c), cl = edgeLen(b, c);
    const wx = (cx - bx) / cl, wy = (cy - by) / cl;
    if (wx !== ux || wy !== uy) {
      const t = (v.d - (len - R)) / (2 * R);
      [x, y, hx, hy] = corner(bx - ux * R, by - uy * R, bx + wx * R, by + wy * R, bx, by, t);
    }
  }
  const hl = Math.hypot(hx, hy) || 1;
  hx /= hl; hy /= hl;
  // keep right: two lanes on every road
  const off = 0.13;
  return { x: x - hy * off, y: y + hx * off, hx, hy, ghost: v.ghost > 0 };
};

root.SprawlPinned = { Sim, W, H, GRASS, FOREST, WATER, MEADOW, CLAY, SAND, WOOD, GOODS, KINDS, MAKER, LEVELS, STATUSES, PATIENCE, DAY, CLEAN_DAY_ROADS, SEATS, JOBS, REACH, SHELF, WOOD_NEED, SPOTS, SHOP_SPOTS, DEPOT_REACH, DEPOT_YARD,
  OUT_CAP, ROAD_COST, BRIDGE_COST, PICK_STEP, HOUSE_ROADS, xy, at, cheb, edgeLen, STEPS4, STEPS8 };
})(typeof window !== 'undefined' ? window : globalThis);
