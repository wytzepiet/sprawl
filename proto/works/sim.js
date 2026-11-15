// Sprawl, works: a factory game whose long haul is the road.
// Machines and belts stand on a half grid and pass things to whatever they
// touch. A dock is where lorries stop: they bring what the machines beside it
// need and take away what piles up. The town builds itself along your roads,
// drives to the shop, and grows while it is fed. Nothing here knows the
// screen: index.html draws it, bot.js plays it.

(function (root) {

const W = 44, H = 28, SW = W * 2, SH = H * 2, N = W * H;
const GRASS = 0, MEADOW = 1, FOREST = 2, WATER = 3;
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

const GOODS = {
  wheat:     { name: 'Wheat',     col: '#e6c53f' },
  flour:     { name: 'Flour',     col: '#f4efe2' },
  bread:     { name: 'Bread',     col: '#d8813a' },
  log:       { name: 'Logs',      col: '#8a5a33' },
  plank:     { name: 'Planks',    col: '#e8b96a' },
  furniture: { name: 'Furniture', col: '#2fa39a' },
  fish:      { name: 'Fish',      col: '#4c95d6' },
};

const KINDS = {
  harvester:  { name: 'Harvester',  out: 'wheat', time: 4, on: MEADOW, say: 'Cuts wheat. Stands on a meadow.' },
  mill:       { name: 'Mill',       ins: ['wheat'], out: 'flour', time: 1.2, say: 'Grinds wheat into flour.' },
  oven:       { name: 'Oven',       ins: ['flour', 'log'], out: 'bread', time: 2, say: 'Bakes flour into bread over a log fire.' },
  woodcutter: { name: 'Woodcutter', out: 'log', time: 4, near: FOREST, say: 'Cuts logs. Stands beside a forest.' },
  sawmill:    { name: 'Sawmill',    ins: ['log'], out: 'plank', time: 2, lock: 'wood', say: 'Saws logs into planks.' },
  workshop:   { name: 'Workshop',   ins: ['plank'], out: 'furniture', time: 5, lock: 'wood', say: 'Builds furniture from planks.' },
  fishery:    { name: 'Fishery',    out: 'fish', time: 3.5, near: WATER, lock: 'fish', say: 'Catches fish. Stands beside water.' },
  dock:       { name: 'Dock',       dock: true, say: 'Where lorries stop. Needs a road beside it.' },
  shop:       { name: 'Shop',       dock: true, shop: true, say: 'The town drives here to buy. Its lorry fetches from docks.' },
  belt:       { name: 'Belt',       say: 'Carries one thing at a time. Cars cannot cross it.' },
};

const PICKS = {
  wood:  { name: 'Woodworks',      say: 'Sawmill and workshop. Houses grow with furniture.' },
  fish:  { name: 'Fishery',        say: 'Fish from the water. Bigger houses want it.' },
  lorry: { name: 'Second lorry',   say: 'Every dock and shop gets one more lorry.' },
  big:   { name: 'Bigger lorries', say: 'A lorry carries twice as much.' },
  fast:  { name: 'Fast belts',     say: 'Belts run twice as fast.' },
  shelf: { name: 'Bigger shops',   say: 'A shop holds twice as much.' },
};
const MILESTONES = [10, 22, 38, 60, 90, 130, 180];

const GAP = 0.45, STOPLINE = 0.55, LANE = 0.17, ACC = 7;
const CAR_SPEED = 3.0, LORRY_SPEED = 2.5;
const VISIT = 28, GROW = 9, REACH = 14, QUIET = 2;
const DOCK_CAP = 8, IN_CAP = 3, OUT_CAP = 2;
const PEOPLE = [0, 2, 4, 7];

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

function Sim(seed = 7) {
  this.rnd = rng(seed * 2654435761);
  this.time = 0;
  this.ver = 1;
  this.terrain = new Uint8Array(N);
  this.road = new Uint8Array(N);
  this.deg = new Uint8Array(N);
  this.hold = new Array(N).fill(null);
  this.houseAt = new Array(N).fill(null);
  this.cell = new Array(SW * SH).fill(null);
  this.parts = [];
  this.belts = [];
  this.houses = [];
  this.vehicles = [];
  this.edges = new Map();
  this.events = [];
  this.unlocked = {};
  this.took = {};
  this.lorries = 1; this.load = 6; this.beltSpeed = 2; this.shelf = 12;
  this.milestone = 0;
  this.offer = null;
  this.pop = 0;
  this.stats = { sold: 0, hauled: 0, ghosts: 0 };
  this.growAt = GROW;
  this.nextId = 1;
  this.makeTerrain();
  this.start();
}
const P = Sim.prototype;

P.makeTerrain = function () {
  const r = this.rnd;
  const blobs = [
    [MEADOW, 9, 8, 4.6], [MEADOW, 36, 22, 3.6], [MEADOW, 30, 13, 2.2],
    [FOREST, 35, 5, 5], [FOREST, 7, 22, 3.8], [FOREST, 19, 3, 2.4],
    [WATER, 23, 25, 3.4], [WATER, 3, 14, 2.6], [WATER, 42, 13, 2.8],
  ];
  const wob = blobs.map(() => [r() * 6.28, r() * 6.28, 0.5 + r() * 0.5]);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let t = GRASS;
    blobs.forEach(([k, cx, cy, rad], i) => {
      const a = Math.atan2(y - cy, x - cx), d = Math.hypot(x - cx, y - cy);
      const rr = rad * (1 + 0.22 * Math.sin(a * 3 + wob[i][0]) * wob[i][2] + 0.12 * Math.sin(a * 5 + wob[i][1]));
      if (d < rr) t = k;
    });
    if (Math.abs(x - 22) < 6 && Math.abs(y - 14) < 4) t = GRASS;
    this.terrain[y * W + x] = t;
  }
};

P.start = function () {
  for (let x = 19; x <= 25; x++) this.setRoad(x, 14);
  this.place('shop', 44, 26);
  for (const [x, y] of [[20, 13], [24, 13], [21, 15], [23, 15]]) this.addHouse(x, y);
  this.events.length = 0;
};

// ---- the map ----------------------------------------------------------

P.tileOf = (sx, sy) => (sy >> 1) * W + (sx >> 1);
P.inside = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
P.partAt = function (sx, sy) { return sx < 0 || sy < 0 || sx >= SW || sy >= SH ? null : this.cell[sy * SW + sx]; };

P.tileFree = function (t) {
  if (this.road[t] || this.houseAt[t]) return false;
  const x = (t % W) * 2, y = ((t / W) | 0) * 2;
  return !this.partAt(x, y) && !this.partAt(x + 1, y) && !this.partAt(x, y + 1) && !this.partAt(x + 1, y + 1);
};

P.changed = function () {
  this.ver++;
  for (let t = 0; t < N; t++) {
    if (!this.road[t]) { this.deg[t] = 0; continue; }
    let d = 0; const x = t % W, y = (t / W) | 0;
    for (const [dx, dy] of DIRS) if (this.inside(x + dx, y + dy) && this.road[t + dx + dy * W]) d++;
    this.deg[t] = d;
  }
  for (const p of this.parts) if (KINDS[p.kind].dock) p.door = this.doorOf(this.tilesOf(p));
  for (const h of this.houses) h.door = this.doorOf([h.t]);
};

P.tilesOf = function (p) {
  const s = new Set();
  for (let dy = 0; dy < p.size; dy++) for (let dx = 0; dx < p.size; dx++) s.add(this.tileOf(p.sx + dx, p.sy + dy));
  return [...s];
};

P.doorOf = function (tiles) {
  for (const t of tiles) {
    const x = t % W, y = (t / W) | 0;
    for (const [dx, dy] of DIRS) if (this.inside(x + dx, y + dy) && this.road[t + dx + dy * W]) return t + dx + dy * W;
  }
  return -1;
};

P.canRoad = function (x, y) {
  if (!this.inside(x, y)) return false;
  const t = y * W + x;
  return !this.road[t] && this.terrain[t] <= MEADOW && this.tileFree(t);
};
P.setRoad = function (x, y) {
  if (!this.canRoad(x, y)) return false;
  this.road[y * W + x] = 1; this.changed(); return true;
};

P.why = function (kind, sx, sy) {
  const K = KINDS[kind], size = kind === 'belt' ? 1 : 2;
  if (K.lock && !this.unlocked[K.lock]) return 'Not unlocked yet';
  if (sx < 0 || sy < 0 || sx + size > SW || sy + size > SH) return 'Off the map';
  const tiles = new Set();
  for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) {
    const q = this.partAt(sx + dx, sy + dy);
    if (q && !(kind === 'belt' && q.kind === 'belt')) return 'Something stands here';
    tiles.add(this.tileOf(sx + dx, sy + dy));
  }
  let touch = false;
  for (const t of tiles) {
    if (this.road[t]) return 'A road runs here';
    if (this.houseAt[t]) return 'A house stands here';
    if (this.terrain[t] > MEADOW) return this.terrain[t] === WATER ? 'Water' : 'Forest';
    if (K.on !== undefined && this.terrain[t] !== K.on) return 'Stands on a meadow';
    const x = t % W, y = (t / W) | 0;
    for (const [dx, dy] of DIRS) if (this.inside(x + dx, y + dy) && this.terrain[t + dx + dy * W] === K.near) touch = true;
  }
  if (K.near !== undefined && !touch) return K.near === FOREST ? 'Stands beside a forest' : 'Stands beside water';
  return null;
};

P.place = function (kind, sx, sy, dir = 0) {
  if (this.why(kind, sx, sy)) return null;
  if (kind === 'belt') {
    let b = this.partAt(sx, sy);
    if (b) { b.dir = dir; this.changed(); return b; }
    b = { id: this.nextId++, kind, sx, sy, size: 1, dir, item: null };
    this.cell[sy * SW + sx] = b; this.belts.push(b); this.changed(); return b;
  }
  const p = { id: this.nextId++, kind, sx, sy, size: 2, inBuf: {}, lack: null, out: 0, prog: 0, rr: 0, busy: false, state: '' };
  if (KINDS[kind].dock) Object.assign(p, { pile: {}, res: {}, inc: {}, fed: {}, wants: [], needs: [], door: -1, fleet: [], think: 0 });
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) this.cell[(sy + dy) * SW + sx + dx] = p;
  this.parts.push(p);
  this.changed();
  return p;
};

P.erase = function (sx, sy) {
  const p = this.partAt(sx, sy);
  if (p) {
    if (p.kind === 'shop' && this.parts.filter(q => q.kind === 'shop').length < 2) return false;
    for (let dy = 0; dy < p.size; dy++) for (let dx = 0; dx < p.size; dx++) this.cell[(p.sy + dy) * SW + p.sx + dx] = null;
    if (p.kind === 'belt') this.belts.splice(this.belts.indexOf(p), 1);
    else this.parts.splice(this.parts.indexOf(p), 1);
    p.dead = true;
    if (p.fleet) for (const v of [...p.fleet]) this.remove(v);
    for (const v of [...this.vehicles]) if (v.to === p) this.bail(v);
    this.changed();
    return true;
  }
  const t = this.tileOf(sx, sy);
  if (this.road[t]) { this.road[t] = 0; this.changed(); return true; }
  return false;
};

P.addHouse = function (x, y) {
  const h = { id: this.nextId++, t: y * W + x, x, y, level: 1, next: this.time + 3 + this.rnd() * VISIT, hungry: false, furn: 0, fish: 0, car: null, door: -1, born: this.time };
  this.houseAt[h.t] = h; this.houses.push(h); this.changed();
  this.events.push({ type: 'house', x, y });
  return h;
};

// ---- things passing hand to hand --------------------------------------

P.shopWants = function () {
  const w = ['bread'];
  if (this.unlocked.wood) w.push('furniture');
  if (this.unlocked.fish) w.push('fish');
  return w;
};

// what waits at the end of a belt: a list of goods, or null for anything
P.leads = function (b) {
  if (b.lv === this.ver) return b.lead;
  let q = b, lead = [];
  for (let i = 0; i < 400; i++) {
    const [dx, dy] = DIRS[q.dir], n = this.partAt(q.sx + dx, q.sy + dy);
    if (!n) break;
    if (n.kind === 'belt') { if ((n.dir + 2) % 4 === q.dir) break; q = n; continue; }
    if (n.kind === 'shop') lead = this.shopWants();
    else if (n.kind === 'dock') lead = null;
    else if (KINDS[n.kind].ins) lead = KINDS[n.kind].ins;
    break;
  }
  b.lv = this.ver; b.lead = lead;
  return lead;
};

P.around = function (p) {
  if (p.av === this.ver) return p.near;
  const out = [];
  for (let i = 0; i < p.size; i++) {
    out.push([p.sx + i, p.sy - 1, 3], [p.sx + p.size, p.sy + i, 0], [p.sx + i, p.sy + p.size, 1], [p.sx - 1, p.sy + i, 2]);
  }
  p.near = out.map(([x, y, d]) => ({ q: this.partAt(x, y), d })).filter(e => e.q && e.q !== p);
  p.av = this.ver;
  return p.near;
};

P.cap = function (p) { return p.kind === 'shop' ? this.shelf : DOCK_CAP; };
P.total = p => { let n = 0; for (const g in p.pile) n += p.pile[g]; return n; };

P.canTake = function (q, g, d, from) {
  if (q.kind === 'belt') {
    if (q.item || (q.dir + 2) % 4 === d) return false;
    if (from.pile) { const l = this.leads(q); return l !== null && l.includes(g); }
    return true;
  }
  if (q.kind === 'shop') return this.shopWants().includes(g) && (q.pile[g] || 0) < this.shelf;
  if (q.kind === 'dock') return !from.pile && this.total(q) < DOCK_CAP + 4;
  return !!KINDS[q.kind].ins && KINDS[q.kind].ins.includes(g) && (q.inBuf[g] || 0) < IN_CAP;
};

P.give = function (q, g, from) {
  if (q.kind === 'belt') {
    const s = from.size / 2;
    q.item = { g, p: 0, fx: from.sx + s, fy: from.sy + s };
    (q.seen = q.seen || {})[g] = this.time;
  } else if (q.pile) { q.pile[g] = (q.pile[g] || 0) + 1; q.fed[g] = this.time; }
  else q.inBuf[g] = (q.inBuf[g] || 0) + 1;
};

P.hand = function (p, g) {
  const near = this.around(p);
  for (let i = 0; i < near.length; i++) {
    const e = near[(p.rr + i) % near.length];
    if (this.canTake(e.q, g, e.d, p)) { this.give(e.q, g, p); p.rr = (p.rr + i + 1) % near.length; return true; }
  }
  return false;
};

P.stepBelts = function (dt) {
  for (const b of this.belts) {
    const it = b.item;
    if (!it) continue;
    it.p = Math.min(1, it.p + this.beltSpeed * dt);
    if (it.p < 1) continue;
    const [dx, dy] = DIRS[b.dir], q = this.partAt(b.sx + dx, b.sy + dy);
    if (q && this.canTake(q, it.g, b.dir, b)) { this.give(q, it.g, b); b.item = null; }
  }
};

P.stepMachines = function (dt) {
  for (const p of this.parts) {
    const K = KINDS[p.kind];
    if (K.dock) continue;
    p.busy = false;
    if (p.out < OUT_CAP) {
      if (K.ins && p.prog === 0) {
        p.lack = K.ins.find(g => !p.inBuf[g]) || null;
        if (!p.lack) { for (const g of K.ins) p.inBuf[g]--; p.prog = 1e-6; }
      }
      if (!K.ins || p.prog > 0) {
        p.prog += dt / K.time; p.busy = true;
        if (p.prog >= 1) { p.prog = 0; p.out++; }
      }
    }
    if (p.out > 0 && this.hand(p, K.out)) p.out--;
    p.state = p.out >= OUT_CAP ? 'full' : K.ins && !p.busy ? 'empty' : '';
  }
};

// ---- roads and what drives on them ------------------------------------

// distances over the roads from one tile; from[] leads back to it
P.flood = function (start) {
  const dist = new Int16Array(N).fill(-1), from = new Int32Array(N).fill(-1), q = [start];
  dist[start] = 0;
  for (let i = 0; i < q.length; i++) {
    const t = q[i], x = t % W, y = (t / W) | 0;
    for (const [dx, dy] of DIRS) {
      if (!this.inside(x + dx, y + dy)) continue;
      const n = t + dx + dy * W;
      if (this.road[n] && dist[n] < 0) { dist[n] = dist[t] + 1; from[n] = t; q.push(n); }
    }
  }
  return { dist, from };
};
P.pathTo = function (f, t) {   // from the flood's start to t
  const path = [];
  for (let c = t; c >= 0; c = f.from[c]) path.push(c);
  return path.reverse();
};

P.edge = function (a, b) {
  const k = a * N + b; let e = this.edges.get(k);
  if (!e) this.edges.set(k, e = []);
  return e;
};
P.clear = function (a, b, me) {
  for (const u of this.edge(a, b)) if (u !== me && u.t < GAP) return false;
  return true;
};

P.send = function (v, path, state) {
  v.path = path; v.i = 0; v.t = 0; v.v = 0; v.on = false; v.state = state; v.stuck = 0;
  if (path.length < 2) this.arrive(v);
};
P.offRoad = function (v) {
  if (v.on) { const e = this.edge(v.path[v.i], v.path[v.i + 1]); const k = e.indexOf(v); if (k >= 0) e.splice(k, 1); v.on = false; }
  if (v.held != null) { if (this.hold[v.held] === v) this.hold[v.held] = null; v.held = null; }
};
P.remove = function (v) {
  this.offRoad(v);
  if (v.job) { const j = v.job; if (!j.from.dead && !v.load) j.from.res[j.g] -= j.n; if (!j.to.dead) j.to.inc[j.g] -= j.n; v.job = null; }
  this.vehicles.splice(this.vehicles.indexOf(v), 1);
  if (v.home.fleet) v.home.fleet.splice(v.home.fleet.indexOf(v), 1); else v.home.car = null;
};
// the road went from under it: home at once, the errand off
P.bail = function (v) {
  this.offRoad(v);
  if (v.kind === 'car') { v.home.next = this.time + VISIT / 2; v.state = 'home'; v.to = null; return; }
  if (v.job) { const j = v.job; if (!j.from.dead && !v.load) j.from.res[j.g] -= j.n; if (!j.to.dead) j.to.inc[j.g] -= j.n; v.job = null; }
  v.load = null; v.state = 'home'; v.to = null;
};

P.arrive = function (v) {
  this.offRoad(v);
  if (v.kind === 'car') {
    if (v.state === 'out') { v.state = 'shopping'; v.wait = 1.2; }
    else { v.state = 'home'; this.cameHome(v.home, v); }
  } else {
    if (v.state === 'out') { v.state = 'loading'; v.wait = 1.2; }
    else { v.state = 'unloading'; v.wait = 1; }
  }
};

P.stepVehicle = function (v, dt) {
  if (v.state === 'home') return;
  if (v.state === 'shopping' || v.state === 'loading' || v.state === 'unloading') {
    v.wait -= dt;
    if (v.wait <= 0) this.done(v);
    return;
  }
  const a = v.path[v.i], b = v.path[v.i + 1];
  if (!this.road[a] || !this.road[b]) return this.bail(v);
  if (!v.on) {
    if (!this.clear(a, b, v) && v.stuck < 8) { v.stuck += dt; return; }
    this.edge(a, b).push(v); v.on = true; v.stuck = 0;
  }
  if (v.held != null && a === v.held && v.t >= 0.25) { if (this.hold[v.held] === v) this.hold[v.held] = null; v.held = null; }
  const ghost = v.stuck > 12;
  let lim = 2;
  for (const u of this.edge(a, b)) if (u !== v && u.t > v.t) lim = Math.min(lim, u.t - GAP);
  const last = v.i + 2 >= v.path.length;
  if (!last) {
    const c = v.path[v.i + 2];
    if (!this.road[c]) return this.bail(v);
    const clear = this.clear(b, c, v), junc = this.deg[b] >= 3;
    if (junc && this.hold[b] !== v) {
      if (this.hold[b] == null && clear && lim === 2 && v.t >= STOPLINE - 0.25) {
        if (v.held != null && this.hold[v.held] === v) this.hold[v.held] = null;
        this.hold[b] = v; v.held = b;
      }
      else lim = Math.min(lim, STOPLINE);
    }
    if (!clear) lim = Math.min(lim, junc ? STOPLINE : 0.999);
  }
  if (ghost) lim = 2;
  const top = v.kind === 'car' ? CAR_SPEED : LORRY_SPEED;
  v.v = Math.min(top, v.v + ACC * dt, Math.max(0, (lim - v.t) * 7 + 0.15));
  let nt = Math.min(v.t + v.v * dt, lim);
  if (nt <= v.t + 1e-5) { nt = v.t; v.v = 0; v.stuck += dt; }
  else { if (ghost) this.stats.ghosts++; v.stuck = 0; }
  v.t = nt;
  if (v.t >= 1) {
    if (last) return this.arrive(v);
    const e = this.edge(a, b); e.splice(e.indexOf(v), 1);
    v.i++; v.t = Math.min(v.t - 1, 0.3);
    this.edge(b, v.path[v.i + 1]).push(v);
  }
};

P.done = function (v) {
  if (v.kind === 'car') {
    const h = v.home, s = v.to;
    v.got = 0;
    if (!s.dead) {
      const take = (g, n) => { const k = Math.min(n, s.pile[g] || 0); if (k) s.pile[g] -= k; this.stats.sold += k; return k; };
      v.got = take('bread', h.level >= 2 ? 2 : 1);
      if (this.unlocked.fish) { const k = take('fish', 1); v.got += k; if (h.level === 2) h.fish += k; }
      if (this.unlocked.wood && h.level === 1) h.furn += take('furniture', 1);
      if (v.got) this.events.push({ type: 'buy', x: s.sx / 2 + 0.5, y: s.sy / 2 + 0.5 });
    }
    if (h.door < 0 || s.door < 0) return this.bail(v);
    const f = this.flood(s.door);
    if (f.dist[h.door] < 0) return this.bail(v);
    return this.send(v, this.pathTo(f, h.door), 'back');
  }
  const j = v.job;
  if (v.state === 'loading') {
    const n = j.from.dead ? 0 : Math.min(j.n, j.from.pile[j.g] || 0);
    if (!j.from.dead) { j.from.pile[j.g] -= n; j.from.res[j.g] -= j.n; }
    v.load = { g: j.g, n };
    const home = v.home;
    if (home.door < 0 || j.from.door < 0) return this.bail(v);
    const f = this.flood(j.from.door);
    if (f.dist[home.door] < 0) return this.bail(v);
    return this.send(v, this.pathTo(f, home.door), 'back');
  }
  const d = v.home;
  d.pile[j.g] = (d.pile[j.g] || 0) + v.load.n; d.inc[j.g] -= j.n;
  this.stats.hauled += v.load.n;
  if (v.load.n) this.events.push({ type: 'drop', x: d.sx / 2 + 0.5, y: d.sy / 2 + 0.5, g: j.g });
  v.load = null; v.job = null; v.to = null; v.state = 'home';
};

// ---- docks: what they ask for, and their lorries ----------------------

// a machine that a belt or its maker already feeds asks no lorry for anything
P.fedByHand = function (m, g) {
  return this.around(m).some(e => e.q.kind === 'belt'
    ? e.q.dir === (e.d + 2) % 4 && e.q.seen && this.time - (e.q.seen[g] ?? -99) < 60
    : KINDS[e.q.kind].out === g);
};

P.dockWants = function (d) {
  if (d.kind === 'shop') return this.shopWants();
  const w = [];
  for (const e of this.around(d)) {
    let l = [];
    if (e.q.kind === 'belt') { if ((e.q.dir + 2) % 4 !== e.d) l = this.leads(e.q) || []; }
    else if (KINDS[e.q.kind].ins) l = KINDS[e.q.kind].ins.filter(g => !this.fedByHand(e.q, g));
    for (const g of l) if (!w.includes(g)) w.push(g);
  }
  return w;
};

P.stepDocks = function (dt) {
  for (const d of this.parts) {
    if (!d.pile) continue;
    d.needs = this.dockWants(d);   // what the machines beside it take
    d.wants = d.kind === 'shop' ? d.needs : d.needs.filter(g => !(this.time - (d.fed[g] ?? -99) < 30));   // and what nobody here makes
    if (d.kind === 'dock') for (const g in d.pile) if (d.pile[g] > 0 && this.hand(d, g)) d.pile[g]--;
    while (d.fleet.length < this.lorries) {
      const v = { id: this.nextId++, kind: 'lorry', home: d, state: 'home', path: [], i: 0, t: 0, v: 0, on: false, stuck: 0, held: null, load: null, job: null, to: null };
      d.fleet.push(v); this.vehicles.push(v);
    }
    d.think -= dt;
    if (d.think > 0 || d.door < 0) continue;
    d.think = 0.5;
    const idle = d.fleet.find(v => v.state === 'home');
    if (!idle) continue;
    let f = null;
    for (const g of d.wants) {
      const have = (d.pile[g] || 0) + (d.inc[g] || 0), room = this.cap(d) - have;
      if (room < 1) continue;
      f = f || this.flood(d.door);
      let best = null, bd = 1e9;
      for (const s of this.parts) {
        if (!s.pile || s === d || s.door < 0 || s.needs.includes(g) || s.kind === 'shop') continue;
        const avail = (s.pile[g] || 0) - (s.res[g] || 0), dist = f.dist[s.door];
        if (avail < 1 || dist < 0) continue;
        if (avail < Math.min(this.load, room) && have > 0) continue;
        if (dist < bd) { bd = dist; best = s; }
      }
      if (!best) continue;
      const n = Math.min(this.load, room, (best.pile[g] || 0) - (best.res[g] || 0));
      best.res[g] = (best.res[g] || 0) + n; d.inc[g] = (d.inc[g] || 0) + n;
      idle.job = { g, n, from: best, to: d }; idle.to = best;
      this.send(idle, this.pathTo(f, best.door), 'out');
      break;
    }
  }
};

// ---- the town ---------------------------------------------------------

P.stepHouses = function () {
  for (const h of this.houses) {
    if (!h.car) { h.car = { id: this.nextId++, kind: 'car', home: h, state: 'home', path: [], i: 0, t: 0, v: 0, on: false, stuck: 0, held: null, to: null, got: 0, hue: (h.id * 47) % 360 }; this.vehicles.push(h.car); }
    if (h.car.state !== 'home' || this.time < h.next) continue;
    h.next = this.time + VISIT * (0.85 + 0.3 * this.rnd());
    if (h.door < 0) { h.hungry = true; continue; }
    const f = this.flood(h.door);
    let best = null, bd = 1e9;
    for (const s of this.parts) if (s.kind === 'shop' && s.door >= 0 && f.dist[s.door] >= 0 && f.dist[s.door] < bd) { bd = f.dist[s.door]; best = s; }
    if (!best) { h.hungry = true; continue; }
    h.car.to = best;
    this.send(h.car, this.pathTo(f, best.door), 'out');
  }
};

P.cameHome = function (h, car) {
  h.hungry = !car.got;
  car.to = null;
  if (h.level === 1 && h.furn >= 2) { h.level = 2; this.events.push({ type: 'grow', x: h.x, y: h.y }); }
  if (h.level === 2 && h.fish >= 4) { h.level = 3; this.events.push({ type: 'grow', x: h.x, y: h.y }); }
};

P.grow = function () {
  if (!this.houses.length || this.houses.length >= 160) return;
  const hungry = this.houses.filter(h => h.hungry).length;
  if (hungry > this.houses.length * 0.15) return;
  const shops = this.parts.filter(s => s.kind === 'shop' && s.door >= 0);
  if (!shops.some(s => (s.pile.bread || 0) > 0)) return;
  const loud = new Uint8Array(N);
  for (const p of this.parts) if (!p.pile) for (const t of this.tilesOf(p)) {
    const x = t % W, y = (t / W) | 0;
    for (let dy = -QUIET; dy <= QUIET; dy++) for (let dx = -QUIET; dx <= QUIET; dx++) if (this.inside(x + dx, y + dy)) loud[t + dx + dy * W] = 1;
  }
  let best = -1, bs = 1e9;
  for (const s of shops) {
    const f = this.flood(s.door);
    for (let t = 0; t < N; t++) {
      if (!this.road[t] || f.dist[t] < 0 || f.dist[t] > REACH) continue;
      const x = t % W, y = (t / W) | 0;
      for (const [dx, dy] of DIRS) {
        if (!this.inside(x + dx, y + dy)) continue;
        const n = t + dx + dy * W;
        if (this.terrain[n] !== GRASS || loud[n] || !this.tileFree(n)) continue;
        const score = f.dist[t] + this.rnd() * 5;
        if (score < bs) { bs = score; best = n; }
      }
    }
  }
  if (best >= 0) this.addHouse(best % W, (best / W) | 0);
};

P.count = function () {
  let n = 0;
  for (const h of this.houses) n += PEOPLE[h.level];
  this.pop = n;
  if (!this.offer && this.milestone < MILESTONES.length && n >= MILESTONES[this.milestone]) {
    const left = Object.keys(PICKS).filter(k => !this.took[k] || (k === 'lorry' && this.took[k] < 3));
    const must = !this.took.wood ? 'wood' : !this.took.fish && this.milestone >= 2 ? 'fish' : null;
    const rest = left.filter(k => k !== must).sort(() => this.rnd() - 0.5);
    this.offer = (must ? [must] : []).concat(rest).slice(0, 3);
    if (this.offer.length) this.events.push({ type: 'offer' }); else this.offer = null;
    this.milestone++;
  }
};

P.pick = function (i) {
  if (!this.offer || !this.offer[i]) return false;
  const k = this.offer[i];
  this.took[k] = (this.took[k] || 0) + 1;
  if (k === 'wood' || k === 'fish') this.unlocked[k] = true;
  if (k === 'lorry') this.lorries++;
  if (k === 'big') this.load *= 2;
  if (k === 'fast') this.beltSpeed *= 2;
  if (k === 'shelf') this.shelf *= 2;
  this.offer = null;
  this.changed();
  this.events.push({ type: 'pick', k });
  return true;
};

// ---- time -------------------------------------------------------------

const DT = 0.05;
P.tick = function () {
  this.time += DT;
  this.stepMachines(DT);
  this.stepBelts(DT);
  this.stepDocks(DT);
  this.stepHouses();
  for (const v of [...this.vehicles]) this.stepVehicle(v, DT);
  if (this.time >= this.growAt) { this.growAt = this.time + GROW; this.grow(); this.count(); }
};
P.run = function (seconds) { for (let n = Math.round(seconds / DT); n > 0; n--) this.tick(); };

// where a vehicle on the road is, in tiles, and which way it points
P.where = function (v) {
  const c = t => [t % W + 0.5, ((t / W) | 0) + 0.5];
  const a = v.path[v.i], b = v.path[v.i + 1];
  const A = c(a), B = c(b), d = [B[0] - A[0], B[1] - A[1]], o = [-d[1] * LANE, d[0] * LANE];
  const t = v.t;
  let pd = d, at = A;
  if (t < 0.5) { if (v.i > 0) { const Z = c(v.path[v.i - 1]); pd = [A[0] - Z[0], A[1] - Z[1]]; } }
  else if (v.i + 2 < v.path.length) { const C = c(v.path[v.i + 2]); pd = [C[0] - B[0], C[1] - B[1]]; at = B; }
  if (pd[0] === d[0] && pd[1] === d[1] || pd[0] === -d[0] && pd[1] === -d[1]) return { x: A[0] + o[0] + d[0] * t, y: A[1] + o[1] + d[1] * t, a: Math.atan2(d[1], d[0]) };
  const d0 = t < 0.5 ? pd : d, d1 = t < 0.5 ? d : pd, u = t < 0.5 ? t + 0.5 : t - 0.5;
  const o0 = [-d0[1] * LANE, d0[0] * LANE], o1 = [-d1[1] * LANE, d1[0] * LANE];
  const p0 = [at[0] - d0[0] * 0.5 + o0[0], at[1] - d0[1] * 0.5 + o0[1]];
  const p1 = [at[0] + o0[0] + o1[0], at[1] + o0[1] + o1[1]];
  const p2 = [at[0] + d1[0] * 0.5 + o1[0], at[1] + d1[1] * 0.5 + o1[1]];
  const w = 1 - u;
  return {
    x: w * w * p0[0] + 2 * w * u * p1[0] + u * u * p2[0],
    y: w * w * p0[1] + 2 * w * u * p1[1] + u * u * p2[1],
    a: Math.atan2(w * (p1[1] - p0[1]) + u * (p2[1] - p1[1]), w * (p1[0] - p0[0]) + u * (p2[0] - p1[0])),
  };
};

Object.assign(Sim, { W, H, SW, SH, GRASS, MEADOW, FOREST, WATER, DIRS, GOODS, KINDS, PICKS, PEOPLE, MILESTONES, DT });
if (typeof module !== 'undefined') module.exports = Sim; else root.Sim = Sim;

})(this);
