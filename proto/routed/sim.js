// Sprawl, routed: the town builds itself. Houses spring up and want things,
// and when nobody makes a thing, someone opens a place that does, wherever the
// land allows: a fishery on the far shore, a sawmill that needs logs from the
// forest. You build nothing but the routes that join them, and the week hands
// you the trucks, routes and bridges to do it with.
// The sim knows nothing of the screen: index.html draws it, bot.js plays it.

(function (root) {

const W = 44, H = 30;
const GRASS = 0, FOREST = 1, WATER = 2, MEADOW = 3, BRIDGE = 4;
const STEPS8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

const SPEED = 2.6;       // tiles a second
const DWELL = 0.5;       // seconds at a stop
const CAP = 4;           // crates a truck carries
const PATIENCE = 55;     // seconds a house waits for a want
const OUT_CAP = 6;       // crates a producer keeps before it stops
const IN_CAP = 4;
const DEPOT_CAP = 12;
const WEEK = 60;
const CENTRE = [22, 14];

const GOODS = {
  fish:      { name: 'Fish',      col: '#3d8fd1' },
  bread:     { name: 'Bread',     col: '#d9823b' },
  wheat:     { name: 'Wheat',     col: '#d9c24a' },
  log:       { name: 'Logs',      col: '#8b5e34' },
  plank:     { name: 'Planks',    col: '#e0a640' },
  furniture: { name: 'Furniture', col: '#2f9c8f' },
  wool:      { name: 'Wool',      col: '#b9a7d6' },
  clothes:   { name: 'Clothes',   col: '#8a62c7' },
};

// Each place makes one good; a place with needs makes it from those.
const KINDS = {
  fishery:    { name: 'Fishery',    out: 'fish',      time: 3.0, shore: true },
  farm:       { name: 'Farm',       out: 'wheat',     time: 3.0, on: MEADOW },
  bakery:     { name: 'Bakery',     out: 'bread',     time: 3.0, needs: 'wheat' },
  woodcutter: { name: 'Woodcutter', out: 'log',       time: 2.6, by: FOREST },
  sawmill:    { name: 'Sawmill',    out: 'plank',     time: 3.0, needs: 'log' },
  workshop:   { name: 'Workshop',   out: 'furniture', time: 3.6, needs: 'plank' },
  sheep:      { name: 'Sheep farm', out: 'wool',      time: 3.4, on: MEADOW },
  tailor:     { name: 'Tailor',     out: 'clothes',   time: 3.4, needs: 'wool' },
};
const MAKER = {};
for (const k in KINDS) MAKER[KINDS[k].out] = k;

// A house grows on deliveries and wants one thing more each time it does.
const LEVELS = [
  { name: 'Cottage',   people: 2,  wants: ['fish'],                              every: 24, grow: 3 },
  { name: 'House',     people: 5,  wants: ['fish', 'bread'],                     every: 30, grow: 8 },
  { name: 'Townhouse', people: 10, wants: ['fish', 'bread', 'furniture'],        every: 34, grow: 12 },
  { name: 'Mansion',   people: 18, wants: ['fish', 'bread', 'furniture', 'clothes'], every: 38 },
];

const STATUSES = [
  { name: 'Hamlet',     at: 0,   size: [18, 12] },
  { name: 'Village',    at: 16,  size: [26, 17] },
  { name: 'Town',       at: 50,  size: [32, 22] },
  { name: 'City',       at: 140, size: [38, 26] },
  { name: 'Metropolis', at: 300, size: [44, 30] },
];

const PICKS = {
  truck:  { name: 'Truck',   sub: 'Add to any route' },
  route:  { name: 'Route',   sub: 'A new colour' },
  bridge: { name: '2 bridges', sub: 'Cross the water' },
  depot:  { name: 'Depot',   sub: 'Where routes swap crates' },
  big:    { name: 'Big truck', sub: 'Carries twice as much' },
};
const COLOURS = ['#e8504a', '#3f7fe0', '#2fae6a', '#f0a92e', '#9b5fd6', '#e2689f', '#37b5c4', '#7a8a2e'];

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
const dist = (a, b) => { const [ax, ay] = xy(a), [bx, by] = xy(b); return Math.hypot(ax - bx, ay - by); };

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
  // a river from the north bends past the town and out to a lake in the south-east
  const river = [[15, -1], [17, 6], [16, 11], [19, 17], [27, 19], [34, 21], [37, 30]];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let k = GRASS;
    if (distToPolyline(x, y, river) < 0.7 + 0.3 * Math.sin(x * 0.8 + y * 0.6)) k = WATER;
    if (Math.hypot((x - 40) / 1.3, y - 24) < 4.5 + Math.sin(y + x) * 0.6) k = WATER;
    if (Math.hypot(x - 4, (y - 5) * 1.2) < 3 + Math.sin(x * 2) * 0.4) k = WATER;
    t[y * W + x] = k;
  }
  const blob = (cx, cy, rad, k) => {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (t[i] === WATER) continue;
      if (Math.hypot(x - cx, y - cy) + (r() - 0.5) * 1.6 < rad) t[i] = k;
    }
  };
  blob(10, 13, 3.2, FOREST); blob(28, 6, 3, FOREST); blob(6, 24, 3.6, FOREST); blob(36, 12, 2.4, FOREST); blob(22, 26, 2.2, FOREST);
  blob(29, 9, 2.2, MEADOW); blob(9, 19, 2.4, MEADOW); blob(31, 26, 2.6, MEADOW); blob(38, 4, 2.4, MEADOW);
  return t;
}

function Sim(seed = 7) {
  const s = this;
  s.seed = seed;
  s.r = rng(seed * 31 + 5);
  s.terrain = makeTerrain(seed);
  s.places = new Map();          // id -> house, producer or depot
  s.tileP = new Map();           // tile -> place id
  s.routes = [];                 // { id, col, stops: [place id], path: [tile], legs: [index into path per stop], trucks }
  s.trucks = [];
  s.nextId = 1;
  s.time = 0;
  s.week = 1; s.weekT = 0;
  s.hand = { truck: 0, route: 2, bridge: 0, depot: 0, big: 0 };
  s.offer = null;
  s.events = [];
  s.status = 0;
  s.spawned = 0;
  s.nextSpawn = 8;
  s.leftThisWeek = 0;
  s.stats = { delivered: 0, left: 0, firsts: {} };
  s.best = 0;
  s.bridgeStock = 0;
  s.computeBounds(true);
  const [cx, cy] = CENTRE;
  s.addHouse(at(cx, cy));
  s.addHouse(at(cx + 2, cy + 1));
}

const P = Sim.prototype;

P.emit = function (type, o = {}) { this.events.push(Object.assign({ type, t: this.time }, o)); };
P.first = function (k) { if (!(k in this.stats.firsts)) this.stats.firsts[k] = this.time; };
P.P = function (id) { return this.places.get(id); };
P.people = function () { let n = 0; for (const p of this.places.values()) if (p.house && !p.vacant) n += LEVELS[p.level].people; return n; };

P.computeBounds = function (force) {
  const [w, h] = STATUSES[this.status].size;
  const [cx, cy] = CENTRE;
  const x0 = Math.max(0, Math.min(W - w, cx - (w >> 1))), y0 = Math.max(0, Math.min(H - h, cy - (h >> 1)));
  this.bounds = { x0, y0, x1: x0 + w - 1, y1: y0 + h - 1 };
};
P.inBounds = function (i) { const [x, y] = xy(i), b = this.bounds; return x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1; };
P.free = function (i) { return i >= 0 && this.inBounds(i) && !this.tileP.has(i) && this.terrain[i] !== WATER && this.terrain[i] !== BRIDGE && !this.onRoute(i); };
P.onRoute = function (i) { return this.roadTiles().has(i); };

P.addPlace = function (o, tile) {
  o.id = this.nextId++; o.tile = tile; o.born = this.time;
  this.places.set(o.id, o); this.tileP.set(tile, o.id);
  this.dirty = true;
  return o;
};

// ---------- houses ----------

P.addHouse = function (tile) {
  const h = this.addPlace({ house: true, level: 0, fed: 0, wants: {} }, tile);
  this.moveIn(h);
  return h;
};
P.moveIn = function (h) {
  h.vacant = false; h.level = 0; h.fed = 0; h.born = this.time; h.wants = {};
  // each want comes round on its own clock; a new house is hungry soon
  for (const g of LEVELS[0].wants) h.wants[g] = { due: this.time + 4 + this.r() * 5, since: -1, coming: 0 };
  this.emit('spawn', { tile: h.tile });
};

// Houses come in clusters round the town; every so often a new hamlet starts
// out where no route goes yet.
P.spawnSpot = function () {
  const houses = [...this.places.values()].filter(p => p.house);
  const far = this.spawned >= 5 && this.spawned % 6 === 5;
  const road = this.roadTiles();
  let best = -1, bestScore = -Infinity;
  for (let k = 0; k < 200; k++) {
    const b = this.bounds;
    const x = b.x0 + 1 + Math.floor(this.r() * (b.x1 - b.x0 - 1)), y = b.y0 + 1 + Math.floor(this.r() * (b.y1 - b.y0 - 1));
    const i = at(x, y);
    if (!this.free(i) || this.terrain[i] === FOREST) continue;
    let near = Infinity, crowd = 0, street = 0;
    for (const h of houses) { const d = dist(i, h.tile); near = Math.min(near, d); if (d < 1.5) crowd++; }
    for (const p of this.places.values()) if (!p.house && dist(i, p.tile) < 2.5) crowd += 3;
    for (const [dx, dy] of STEPS8) if (road.has(at(x + dx, y + dy))) street = 1;
    // a far hamlet starts where nothing is; otherwise houses fill in along the streets
    const score = far ? Math.min(near, 10) - street * 4 - crowd * 3 : -Math.abs(near - 1.5) * 1.5 + street * 2.5 - Math.max(0, crowd - 2) * 2 + this.r() * 2;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
};

P.tickHouse = function (h) {
  if (h.vacant) return;
  const L = LEVELS[h.level];
  for (const g of L.wants) {
    const w = h.wants[g];
    if (w.since < 0 && this.time >= w.due) { w.since = this.time; this.emit('want', { tile: h.tile, good: g }); this.first('want:' + g); this.supply(g); }
    if (w.since >= 0 && this.time - w.since > PATIENCE) { this.shrink(h, g); return; }
  }
};

P.shrink = function (h, good) {
  this.stats.left++; this.leftThisWeek++;
  this.emit('leave', { tile: h.tile, good, gone: h.level === 0 });
  this.first('left');
  // an empty cottage stays an empty lot, still on its routes, for the next family
  if (h.level === 0) { h.born = this.time; h.vacant = true; h.wants = {}; h.fed = 0; return; }
  h.level--; h.fed = 0;
  for (const g in h.wants) if (!LEVELS[h.level].wants.includes(g)) delete h.wants[g];
  for (const g of LEVELS[h.level].wants) { const w = h.wants[g]; w.since = -1; w.due = this.time + 10; }
};

P.feed = function (h, g) {
  const w = h.wants[g];
  w.since = -1; w.coming = Math.max(0, w.coming - 1);
  w.due = this.time + LEVELS[h.level].every * (0.85 + this.r() * 0.3);
  this.stats.delivered++;
  this.first('fed:' + g);
  this.emit('deliver', { tile: h.tile, good: g });
  const L = LEVELS[h.level];
  if (L.grow && ++h.fed >= L.grow) {
    h.level++; h.fed = 0;
    for (const g2 of LEVELS[h.level].wants) if (!h.wants[g2]) h.wants[g2] = { due: this.time + 3 + this.r() * 4, since: -1, coming: 0 };
    this.emit('grow', { tile: h.tile, level: h.level });
    this.first('level:' + h.level);
  }
};

// ---------- producers open where the land lets them ----------

// When a good is wanted and nobody makes it, someone opens a place that does.
// When the wanting outruns the making, a second one opens.
// What grows or is dug opens where the land has it, by itself; what is made
// from something comes to the player's hand, to put where routes can feed it.
P.supply = function (good) {
  const kind = MAKER[good];
  const makers = [...this.places.values()].filter(p => p.kind === kind);
  if (makers.length || this.hand[kind]) return;
  this.more(kind);
};
P.more = function (kind) {
  const K = KINDS[kind];
  if (!K.needs) return this.open(kind);
  this.hand[kind] = (this.hand[kind] || 0) + 1;
  this.emit('token', { kind });
  this.first('token:' + kind);
  this.supply(K.needs);
};
P.placeMaker = function (kind, tile) {
  if (!this.hand[kind] || !this.free(tile) || this.terrain[tile] === FOREST) return null;
  this.hand[kind]--;
  const p = this.addPlace({ kind, out: 0, inBuf: 0, prog: 0, coming: 0 }, tile);
  this.emit('open', { tile, kind, placed: true });
  this.first('open:' + kind);
  return p;
};

P.open = function (kind) {
  const K = KINDS[kind];
  const site = this.site(kind);
  if (site < 0) return null;
  const p = this.addPlace({ kind, out: 0, inBuf: 0, prog: 0, coming: 0 }, site);
  this.emit('open', { tile: site, kind });
  this.first('open:' + kind);
  return p;
};

P.site = function (kind) {
  const K = KINDS[kind];
  const houses = [...this.places.values()].filter(p => p.house);
  const [cx, cy] = houses.reduce((a, h) => { const [x, y] = xy(h.tile); return [a[0] + x / houses.length, a[1] + y / houses.length]; }, [0, 0]);
  const c = at(Math.round(cx), Math.round(cy));
  // the land you can reach from town without a new bridge; early on, makers
  // open there, later the far shore is fair game now and then
  const land = new Set([c]), stack = [c];
  while (stack.length) { const j = stack.pop(), [x, y] = xy(j); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const k = at(x + dx, y + dy); if (k >= 0 && !land.has(k) && this.terrain[k] !== WATER) { land.add(k); stack.push(k); } } }
  const across = this.week >= 3 && this.r() < 0.35;
  let best = -1, bestScore = -Infinity;
  for (let i = 0; i < W * H; i++) {
    if (!this.free(i) || (!across && !land.has(i))) continue;
    const t = this.terrain[i];
    const [x, y] = xy(i);
    const near = k => STEPS8.some(([dx, dy]) => { const j = at(x + dx, y + dy); return j >= 0 && this.terrain[j] === k; });
    if (K.on !== undefined && t !== K.on) continue;
    if (K.by !== undefined && !(t === GRASS && near(K.by))) continue;
    if (K.shore && !(t === GRASS && near(WATER))) continue;
    if (K.on === undefined && t !== GRASS) continue;
    if (STEPS8.some(([dx, dy]) => this.tileP.has(at(x + dx, y + dy)))) continue;
    const d = dist(i, c);
    // raw goods out where the land is; workshops a short way out of town
    const want = 9;
    const score = -Math.abs(d - want) + this.r() * 3;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
};

P.tickProducer = function (p) {
  const K = KINDS[p.kind];
  p.dry = p.out === 0 && p.idle !== 'starved' ? (p.dry || 0) + 1 / 30 : 0;
  if (p.out >= OUT_CAP) { p.idle = 'full'; return; }
  if (K.needs && p.inBuf <= 0 && p.prog === 0) { p.idle = 'starved'; return; }
  p.idle = null;
  if (p.prog === 0 && K.needs) p.inBuf--;
  p.prog += 1 / 30 / K.time;
  if (p.prog >= 1) { p.prog = 0; p.out++; this.first('made:' + K.out); this.emit('made', { tile: p.tile, good: K.out }); }
};

// ---------- routes ----------

// A route is a line the player draws, tile to tile. Trucks run it end to end
// and back, and serve whatever stands beside it: a route is a street.
// Paths go eight ways over land and over bridges; open water only while there
// are bridges in hand to put down, one for each stretch of water crossed.
P.path = function (a, b, bridges) {
  const g = new Float64Array(W * H).fill(Infinity), prev = new Int32Array(W * H).fill(-1), used = new Int16Array(W * H);
  const open = [[0, a]];
  g[a] = 0;
  const [bx, by] = xy(b);
  const road = this.roadTiles();
  while (open.length) {
    let k = 0;
    for (let j = 1; j < open.length; j++) if (open[j][0] < open[k][0]) k = j;
    const [, i] = open[k]; open[k] = open[open.length - 1]; open.pop();
    if (i === b) break;
    const [x, y] = xy(i);
    for (const [dx, dy] of STEPS8) {
      const j = at(x + dx, y + dy);
      if (j < 0) continue;
      const tj = this.terrain[j];
      let u = used[i];
      if (tj === WATER) { if (this.terrain[i] !== WATER) u++; if (u > bridges) continue; }
      if (dx && dy) {   // never cut a corner over water, never bridge on the slant
        const c1 = this.terrain[at(x + dx, y)], c2 = this.terrain[at(x, y + dy)];
        if (c1 === WATER || c2 === WATER || tj === WATER || c1 === BRIDGE || c2 === BRIDGE) continue;
      }
      // places are in the way, unless it is where we start or end
      if (j !== b && this.tileP.has(j) && !this.placeAt(j).depot) continue;
      const cost = (dx && dy ? 1.414 : 1) * (road.has(j) ? 0.8 : tj === FOREST ? 1.4 : tj === WATER ? 1.8 : 1);
      const ng = g[i] + cost;
      if (ng < g[j]) { g[j] = ng; prev[j] = i; used[j] = u; const [jx, jy] = xy(j); open.push([ng + Math.hypot(jx - bx, jy - by) * 0.8, j]); }
    }
  }
  if (g[b] === Infinity) return null;
  const out = [b];
  for (let i = b; i !== a; i = prev[i]) out.push(prev[i]);
  out.reverse();
  return { tiles: out, bridges: used[b], len: g[b] };
};

P.roadTiles = function () { const s = new Set(); for (const r of this.routes) for (const t of r.path) s.add(t); return s; };
P.placeAt = function (tile) { const id = this.tileP.get(tile); return id === undefined ? null : this.places.get(id); };
P.canEnd = function (tile) { return tile >= 0 && this.inBounds(tile) && this.terrain[tile] !== WATER; };

P.newRoute = function (a, b) {
  if (this.hand.route <= 0 || a === b || !this.canEnd(a) || !this.canEnd(b)) return null;
  const leg = this.path(a, b, this.hand.bridge);
  if (!leg) return null;
  this.hand.route--;
  const used = new Set(this.routes.map(r => r.col));
  const r = { id: this.nextId++, col: COLOURS.find(c => !used.has(c)) || COLOURS[this.routes.length % COLOURS.length], stops: [a, b], path: leg.tiles, legs: [0, leg.tiles.length - 1] };
  this.routes.push(r);
  this.laid(leg);
  this.addTruck(r, true);
  this.first('route');
  this.emit('route', { route: r.id });
  return r;
};

P.laid = function (leg) {
  for (const t of leg.tiles) if (this.terrain[t] === WATER) this.terrain[t] = BRIDGE;
  this.hand.bridge = this.bridgeStock - this.bridgesUsed();
  this.reachAll();
};

// Extend a route from one of its ends (0 the first, 1 the last) to a tile.
P.extend = function (r, end, to) {
  if (!this.canEnd(to)) return false;
  const from = end === 0 ? r.stops[0] : r.stops[r.stops.length - 1];
  if (from === to) return false;
  const leg = this.path(from, to, this.hand.bridge);
  if (!leg) return false;
  // a route may not fold back over itself
  const mine = new Set(r.path);
  if (leg.tiles.slice(1).some(t => mine.has(t))) return false;
  if (end === 1) {
    r.path.push(...leg.tiles.slice(1));
    r.stops.push(to); r.legs.push(r.path.length - 1);
  } else {
    const add = leg.tiles.slice(1).reverse();
    r.path.unshift(...add);
    r.legs = [0, ...r.legs.map(v => v + add.length)];
    r.stops.unshift(to);
    for (const t of this.trucks) if (t.route === r) t.pos += add.length;
  }
  this.laid(leg);
  this.emit('extend', { route: r.id });
  return true;
};

// Cut a route back by its first or last leg. A route of one leg goes whole,
// and its trucks and its colour come back to hand.
P.trim = function (r, end) {
  if (r.stops.length <= 2) return this.removeRoute(r);
  if (end === 0) {
    const cut = r.legs[1];
    r.path.splice(0, cut); r.stops.shift(); r.legs.shift(); r.legs = r.legs.map(v => v - cut);
    for (const t of this.trucks) if (t.route === r) { t.pos = Math.max(0, t.pos - cut); if (t.pos === 0) t.dir = 1; }
  } else {
    r.stops.pop(); r.legs.pop(); r.path.length = r.legs[r.legs.length - 1] + 1;
    const last = r.path.length - 1;
    for (const t of this.trucks) if (t.route === r) { t.pos = Math.min(last, t.pos); if (t.pos === last) t.dir = -1; }
  }
  this.dropBridges();
  this.reachAll();
  return true;
};

P.removeRoute = function (r) {
  const mine = this.trucks.filter(t => t.route === r);
  for (const t of mine) { this.unclaim(t); this.hand[t.big ? 'big' : 'truck']++; }
  this.hand.truck--;     // the truck that came with the route goes with it
  this.trucks = this.trucks.filter(t => t.route !== r);
  this.routes = this.routes.filter(q => q !== r);
  this.hand.route++;
  this.dropBridges();
  this.reachAll();
  return true;
};

// A bridge nobody drives over is pulled up and comes back to hand.
P.dropBridges = function () {
  const used = this.roadTiles();
  for (let i = 0; i < W * H; i++) if (this.terrain[i] === BRIDGE && !used.has(i)) this.terrain[i] = WATER;
  this.hand.bridge = this.bridgeStock - this.bridgesUsed();
};
// one bridge is one stretch of bridged water, however many routes cross it
P.bridgesUsed = function () {
  const seen = new Set(); let n = 0;
  for (let i = 0; i < W * H; i++) {
    if (this.terrain[i] !== BRIDGE || seen.has(i)) continue;
    n++; const stack = [i]; seen.add(i);
    while (stack.length) { const j = stack.pop(), [x, y] = xy(j); for (const [dx, dy] of STEPS8) { const k = at(x + dx, y + dy); if (k >= 0 && !seen.has(k) && this.terrain[k] === BRIDGE) { seen.add(k); stack.push(k); } } }
  }
  return n;
};

// What stands beside each tile of each route, recomputed when either changes.
P.reachAll = function () {
  for (const r of this.routes) {
    r.reach = r.path.map(() => []);
    r.on = new Map();          // place id -> path index where it is served
    r.path.forEach((t, k) => {
      const [x, y] = xy(t);
      for (const [dx, dy] of [[0, 0], ...STEPS8]) {
        const p = this.placeAt(at(x + dx, y + dy));
        if (p && !r.on.has(p.id)) { r.on.set(p.id, k); r.reach[k].push(p.id); }
      }
    });
  }
  this.dirty = false;
};
// Can any route bring this good here: a route past it that also passes a
// maker, or a depot one swap away from one?
P.reachable = function (p, good) {
  const maker = q => q.kind === MAKER[good];
  for (const r of this.routes) {
    if (!r.on || !r.on.has(p.id)) continue;
    for (const id of r.on.keys()) {
      const q = this.P(id);
      if (!q) continue;
      if (maker(q)) return true;
      if (q.depot) for (const r2 of this.routes) if (r2 !== r && r2.on.has(id)) for (const id2 of r2.on.keys()) { const q2 = this.P(id2); if (q2 && maker(q2)) return true; }
    }
  }
  return false;
};
P.served = function (p) { return this.routes.some(r => r.on && r.on.has(p.id)); };

// ---------- trucks ----------

P.addTruck = function (r, free, big) {
  if (!free) { const k = big ? 'big' : 'truck'; if (this.hand[k] <= 0) return null; this.hand[k]--; }
  const n = this.trucks.filter(t => t.route === r).length;
  // new trucks start at alternate ends so they spread out
  const t = { id: this.nextId++, route: r, pos: n % 2 ? r.path.length - 1 : 0, dir: n % 2 ? -1 : 1, cargo: [], wait: 0.3, big: !!big };
  this.trucks.push(t);
  this.emit('truck', { route: r.id });
  return t;
};

P.cap = function (t) { return t.big ? CAP * 2 : CAP; };

// Does this place take this good now, counting what is already on its way?
P.takes = function (p, good, counting) {
  const c = counting ? 1 : 0;
  if (p.house) { const w = !p.vacant && p.wants[good]; return !!w && w.since >= 0 && w.coming < c + (counting ? 0 : 1); }
  if (p.kind) return KINDS[p.kind].needs === good && p.inBuf + (counting ? p.coming : 0) < IN_CAP;
  return false;
};

// Who beside this route (or a swap away, through a depot on it) waits for
// this good and has nothing on its way yet? Nearest ahead first.
P.wantsOn = function (r, good, t, except, viaDepot = true) {
  const out = [];
  for (const [id, k] of r.on) {
    if (id === except) continue;
    const p = this.P(id);
    if (!p) continue;
    if (p.house ? (!p.vacant && p.wants[good] && p.wants[good].since >= 0 && p.wants[good].coming === 0) : this.takes(p, good, true)) out.push([p, k]);
    else if (p.depot && viaDepot && p.store.length + p.coming < DEPOT_CAP) {
      for (const q of this.routes) if (q !== r && q.on.has(id) && this.wantsOn(q, good, null, id, false).length) { out.push([p, k]); break; }
    }
  }
  if (t) out.sort((a, b) => this.ahead(t, a[1]) - this.ahead(t, b[1]));
  return out.map(o => o[0]);
};

// path steps until the truck passes index k, going the way it goes
P.ahead = function (t, k) {
  const last = t.route.path.length - 1;
  return t.dir > 0 ? (k >= t.pos ? k - t.pos : 2 * last - t.pos - k) : (k <= t.pos ? t.pos - k : t.pos + k);
};

P.claim = function (p, good, n) {
  if (!p) return;
  if (p.house) { const w = p.wants[good]; if (w) w.coming = Math.max(0, w.coming + n); }
  else p.coming = Math.max(0, p.coming + n);
};
P.unclaim = function (t) { for (const c of t.cargo) if (c.to) this.claim(this.P(c.to), c.good, -1); };

// A truck at a tile of its route: hand over what the places beside it take,
// then load what someone further along waits for. True if it did anything.
P.service = function (t, k) {
  const r = t.route;
  let did = false;
  for (const id of r.reach[k]) {
    const p = this.P(id);
    for (let c = t.cargo.length - 1; c >= 0; c--) {
      const it = t.cargo[c];
      const mine = it.to === id;
      let take = false;
      if (p.house) take = !p.vacant && p.wants[it.good] && p.wants[it.good].since >= 0 && (mine || !it.to || p.wants[it.good].coming === 0);
      else if (p.kind) take = KINDS[p.kind].needs === it.good && p.inBuf < IN_CAP && (mine || !it.to);
      else if (p.depot) take = mine && p.store.length < DEPOT_CAP;
      if (take) {
        if (it.to) this.claim(this.P(it.to), it.good, -1);
        t.cargo.splice(c, 1);
        if (p.house) this.feed(p, it.good);
        else if (p.kind) { p.inBuf++; this.emit('drop', { tile: p.tile, good: it.good }); }
        else { p.store.push(it.good); this.emit('drop', { tile: p.tile, good: it.good }); }
        did = true;
      } else if (mine) {
        // it was meant for here and here no longer wants it: find it someone else
        this.claim(p, it.good, -1); it.to = 0;
      }
    }
  }
  // cargo with nobody to go to looks again
  for (const it of t.cargo) if (!it.to) { const who = this.wantsOn(r, it.good, t)[0]; if (who) { it.to = who.id; this.claim(who, it.good, 1); } }
  for (const id of r.reach[k]) {
    const p = this.P(id);
    const goods = p.kind ? [KINDS[p.kind].out] : p.depot ? [...new Set(p.store)] : [];
    for (const g of goods) {
      while (t.cargo.length < this.cap(t)) {
        const have = p.kind ? p.out : p.store.filter(x => x === g).length;
        if (have <= 0) break;
        const who = this.wantsOn(r, g, t, id)[0];
        if (!who) break;
        if (p.kind) p.out--; else p.store.splice(p.store.indexOf(g), 1);
        this.claim(who, g, 1);
        t.cargo.push({ good: g, to: who.id });
        this.emit('load', { tile: p.tile, good: g });
        did = true;
      }
    }
  }
  return did;
};

P.moveTruck = function (t, dt) {
  const r = t.route;
  if (t.wait > 0) { t.wait -= dt; return; }
  const last = r.path.length - 1;
  let left = SPEED * dt;
  while (left > 1e-9) {
    if (t.pos <= 0 && t.dir < 0) t.dir = 1;
    if (t.pos >= last && t.dir > 0) t.dir = -1;
    const from = Math.round(t.pos) === t.pos ? t.pos : (t.dir > 0 ? Math.floor(t.pos) : Math.ceil(t.pos));
    const to = from + t.dir;
    const [ax, ay] = xy(r.path[from]), [bx, by] = xy(r.path[to]);
    const len = Math.hypot(bx - ax, by - ay);
    const rest = Math.abs(to - t.pos);
    const go = Math.min(rest, left / len);
    t.pos += t.dir * go; left -= go * len;
    if (go >= rest - 1e-9) {
      t.pos = to;
      if (this.service(t, to)) { t.wait = DWELL; return; }
    }
  }
};

P.truckPose = function (t) {
  const r = t.route, i = Math.min(Math.floor(t.pos), r.path.length - 2), f = t.pos - i;
  const [ax, ay] = xy(r.path[i]), [bx, by] = xy(r.path[i + 1]);
  return [ax + (bx - ax) * f, ay + (by - ay) * f, Math.atan2(by - ay, bx - ax) + (t.dir < 0 ? Math.PI : 0)];
};

// ---------- depots ----------

P.placeDepot = function (tile) {
  // a depot may stand on a street: trucks drive through it
  if (this.hand.depot <= 0 || tile < 0 || !this.inBounds(tile) || this.tileP.has(tile) || this.terrain[tile] === WATER || this.terrain[tile] === BRIDGE) return null;
  this.hand.depot--;
  const d = this.addPlace({ depot: true, store: [], coming: 0 }, tile);
  this.emit('depot', { tile });
  return d;
};

// ---------- the week ----------

P.makeOffer = function () {
  const n = this.leftThisWeek ? 2 : 3;
  const pool = ['truck', 'truck', 'route', 'bridge', 'big'];
  if (this.week >= 3) pool.push('depot');
  if (this.routes.length >= 3) pool.push('depot');
  const out = [];
  while (out.length < n) {
    const k = pool[Math.floor(this.r() * pool.length)];
    if (!out.includes(k)) out.push(k);
  }
  this.offer = out;
};

P.pick = function (k) {
  if (!this.offer || !this.offer[k]) return false;
  const o = this.offer[k];
  if (o === 'bridge') { this.hand.bridge += 2; this.bridgeStock += 2; }
  else this.hand[o]++;
  this.offer = null;
  this.emit('picked', { pick: o });
  return true;
};

// ---------- the clock ----------

P.step = function (dt) {
  if (this.offer) return;
  this.time += dt;
  this.weekT += dt;
  if (this.weekT >= WEEK) {
    this.weekT -= WEEK; this.week++;
    // every week brings a truck; the pick is the one you choose
    this.hand.truck++;
    this.makeOffer();
    this.leftThisWeek = 0;
    this.emit('week', { week: this.week });
  }
  if (this.time >= this.nextSpawn) {
    const lot = [...this.places.values()].find(p => p.vacant && this.time - p.born > 20);
    if (lot) this.moveIn(lot);
    else { const i = this.spawnSpot(); if (i >= 0) this.addHouse(i); }
    this.spawned++;
    const strained = [...this.places.values()].filter(p => p.house && Object.values(p.wants).some(w => w.since >= 0 && this.time - w.since > PATIENCE / 2)).length;
    this.nextSpawn = this.time + Math.max(7, 17 - this.time / 60) * (1 + 0.4 * strained);
  }
  for (const p of [...this.places.values()]) {
    if (p.house) this.tickHouse(p);
    else if (p.kind) this.tickProducer(p);
  }
  // a busy good gets a second maker
  if (Math.floor(this.time / 2) !== Math.floor((this.time - dt) / 2)) this.demand();
  if (this.dirty) this.reachAll();
  for (const t of this.trucks) this.moveTruck(t, dt);
  const ppl = this.people();
  this.best = Math.max(this.best, ppl);
  while (this.status + 1 < STATUSES.length && ppl >= STATUSES[this.status + 1].at) {
    this.status++; this.computeBounds();
    this.emit('status', { name: STATUSES[this.status].name });
    this.first('status:' + this.status);
  }
};

// A good runs short when every place making it is served and its yard has
// stood empty a while with someone still waiting: then another opens.
// Makers nobody's route reaches don't count as short; join them first.
P.demand = function () {
  const waiting = new Set();
  for (const p of this.places.values()) {
    if (p.house && !p.vacant) for (const g of LEVELS[p.level].wants) { if (p.wants[g].since >= 0) waiting.add(g); }
    if (p.kind && p.idle === 'starved') waiting.add(KINDS[p.kind].needs);
  }
  for (const g of waiting) {
    const makers = [...this.places.values()].filter(p => p.kind === MAKER[g]);
    if (makers.length && makers.every(m => this.served(m) && m.dry > 25)) { if (!this.hand[MAKER[g]]) this.more(MAKER[g]); makers.forEach(m => m.dry = 0); }
  }
};

const api = { Sim, W, H, GRASS, FOREST, WATER, MEADOW, BRIDGE, GOODS, KINDS, MAKER, LEVELS, STATUSES, PICKS, PATIENCE, OUT_CAP, IN_CAP, DEPOT_CAP, CAP, WEEK, xy, at, dist, STEPS8 };
root.SprawlRouted = api;
})(typeof window !== 'undefined' ? window : globalThis);
