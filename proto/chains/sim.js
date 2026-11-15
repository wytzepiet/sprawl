// Sprawl, chains: the town is the factory. Every building stands on one
// tile, makes one thing from what it holds, and owns a lorry that fetches
// what it lacks from the nearest place that has it. Buildings that touch
// pass goods across without a lorry. Nothing here knows the goods: tree.js
// says what is made of what, and what homes want. index.html draws it,
// bot.js plays it and measures.

(function (root) {

const W = 64, H = 40, N = W * H;
const GROUND = ['grass', 'field', 'forest', 'water', 'clay', 'ore', 'coal', 'oil'];
const GR = Object.fromEntries(GROUND.map((k, i) => [k, i]));
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const DT = 0.05, GAP = 0.45, STOPLINE = 0.55, LANE = 0.17, ACC = 7;

const TUNE = {
  load: 4,            // crates a lorry carries
  lorrySpeed: 2.2, carSpeed: 3,   // tiles a second
  loadTime: 1.2, dropTime: 1,
  yard: 2,            // lorry loads a maker keeps before it stops
  shelf: 12, stock: 12, quay: 16,   // a shop's shelf, a builder's stock, a harbour's quay, per good
  pantry: 80,         // seconds of eating a full pantry holds
  grow: 8, reach: 14, quiet: 2,   // a new home this often, this far from a shop, not this near industry
  hand: 0.3,          // seconds between crates passed by touch
  ship: 90, shipLoad: 24,
  staff: false,       // homes send a worker to every building
  shift: 40,          // seconds a worker stays
};

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const add = (o, k, n) => { o[k] = (o[k] || 0) + n; };

function Sim(seed = 7, tree, opts) {
  this.tree = tree;
  this.T = Object.assign({}, TUNE, tree.tune, opts);
  this.kinds = JSON.parse(JSON.stringify(tree.kinds));
  this.rnd = rng(seed * 2654435761);
  this.time = 0; this.ver = 1;
  this.terrain = new Uint8Array(N);
  this.road = new Uint8Array(N);
  this.deg = new Uint8Array(N);
  this.hold = new Array(N).fill(null);
  this.at = new Array(N).fill(null);      // the building or home on a tile
  this.parts = []; this.houses = []; this.vehicles = [];
  this.edges = new Map(); this.floods = new Map();
  this.events = [];
  this.tier = 0; this.ver2 = 0; this.sgv = -1; this.bgv = -1; this.pop = 0; this.took = {}; this.offer = null; this.pickN = 0;
  this.stats = { made: {}, used: {}, sold: {}, touch: {}, trips: {}, tiles: {}, shipped: {}, ghosts: 0, waitCar: 0, waitLorry: 0, driveCar: 0, driveLorry: 0, built: 0, grown: 0 };
  this.flow = new Map(); this.wait = new Float32Array(N);
  this.growAt = this.T.grow; this.second = 1; this.shipAt = this.T.ship;
  this.nextId = 1;
  this.makeTerrain();
  this.start();
}
const P = Sim.prototype;

// ---- the land ----------------------------------------------------------

P.makeTerrain = function () {
  const r = this.rnd, cx = W / 2, cy = H / 2, placed = [];
  for (let y = H - 3; y < H; y++) for (let x = 0; x < W; x++) this.terrain[y * W + x] = GR.water;
  for (const [kind, dist, rad, side] of this.tree.land) {
    for (let tries = 0; tries < 400; tries++) {
      const a = r() * 6.283, d = dist + (r() - 0.5) * 3 + tries * 0.01;
      const x = cx + Math.cos(a) * d * 1.25, y = cy + Math.sin(a) * d * 0.8;
      if (side && Math.sign(x - cx) !== side) continue;
      if (x < rad + 1 || y < rad + 1 || x > W - rad - 2 || y > H - rad - 5) continue;
      if (placed.some(p => Math.hypot(p[0] - x, p[1] - y) < p[2] + rad + 3)) continue;
      placed.push([x, y, rad, kind, r() * 6.28, r() * 6.28]);
      break;
    }
  }
  for (let y = 0; y < H - 3; y++) for (let x = 0; x < W; x++) {
    if (Math.abs(x - cx) < 7 && Math.abs(y - cy) < 5) continue;
    for (const [px, py, rad, kind, w0, w1] of placed) {
      const a = Math.atan2(y - py, x - px), d = Math.hypot(x - px, y - py);
      if (d < rad * (1 + 0.2 * Math.sin(a * 3 + w0) + 0.1 * Math.sin(a * 5 + w1))) this.terrain[y * W + x] = GR[kind];
    }
  }
};

P.start = function () {
  const cx = W / 2, cy = H / 2;
  for (let x = cx - 4; x <= cx + 4; x++) this.setRoad(x, cy);
  for (const [k, dx, dy] of this.tree.start.parts) this.place(k, cx + dx, cy + dy, true);
  for (const [dx, dy] of this.tree.start.homes) this.addHouse(cx + dx, cy + dy);
  for (const b of this.parts) if (b.K.builder) Object.assign(b.have, this.tree.start.stock);
  this.events.length = 0;
};

// ---- the map -----------------------------------------------------------

P.inside = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
P.free = function (t) { return !this.road[t] && !this.at[t] && this.terrain[t] === GR.grass; };

P.changed = function () {
  this.ver++; this.floods = new Map();
  for (let t = 0; t < N; t++) {
    if (!this.road[t]) { this.deg[t] = 0; continue; }
    let d = 0; const x = t % W, y = (t / W) | 0;
    for (const [dx, dy] of DIRS) if (this.inside(x + dx, y + dy) && this.road[t + dx + dy * W]) d++;
    this.deg[t] = d;
  }
  for (const b of this.parts) {
    b.door = this.doorOf(b.t);
    b.near = this.nextTo(b.t).map(t => this.at[t]).filter(q => q && q.K);
    b.garages = b.near.filter(q => q.K.garage && !q.site).length;
  }
  for (const h of this.houses) h.door = this.doorOf(h.t);
};

P.nextTo = function (t) {
  const x = t % W, y = (t / W) | 0, out = [];
  for (const [dx, dy] of DIRS) if (this.inside(x + dx, y + dy)) out.push(t + dx + dy * W);
  return out;
};
P.doorOf = function (t) { for (const n of this.nextTo(t)) if (this.road[n]) return n; return -1; };

P.canRoad = function (x, y) { return this.inside(x, y) && this.free(y * W + x); };
P.setRoad = function (x, y) {
  if (!this.canRoad(x, y)) return false;
  this.road[y * W + x] = 1; this.changed(); return true;
};

P.open = function (kind) { return (this.kinds[kind].tier || 0) <= this.tier; };
P.why = function (kind, x, y) {
  const K = this.kinds[kind];
  if (!this.open(kind)) return 'Not unlocked yet';
  if (!this.inside(x, y)) return 'Off the map';
  const t = y * W + x;
  if (this.road[t]) return 'A road runs here';
  if (this.at[t]) return 'Something stands here';
  if (this.terrain[t] !== GR.grass) return 'Only on open grass';
  if (K.near && !this.nextTo(t).some(n => this.terrain[n] === GR[K.near])) return 'Stands beside ' + K.near;
  return null;
};

P.place = function (kind, x, y, free) {
  if (this.why(kind, x, y)) return null;
  const K = this.kinds[kind], t = y * W + x;
  const b = { id: this.nextId++, kind, K, x, y, t, have: {}, made: {}, inc: {}, res: {}, fed: {}, prog: 0, boost: 0, state: '', lack: null, door: -1, near: [], garages: 0, fleet: [], think: 0, handAt: 0, rr: 0, staff: 0, born: this.time,
    s: { busy: 0, full: 0, away: 0, lack: {}, empty: {} }, site: null };
  if (!free && K.cost && Object.keys(K.cost).length) b.site = { need: { ...K.cost }, inc: {}, since: this.time };
  if (K.need) b.need = { ...K.need };
  this.at[t] = b; this.parts.push(b); this.changed();
  return b;
};

P.erase = function (x, y) {
  if (!this.inside(x, y)) return false;
  const t = y * W + x, b = this.at[t];
  if (b && b.K) {
    if (b.K.shop && this.parts.filter(q => q.K.shop).length < 2) return false;
    this.at[t] = null; this.parts.splice(this.parts.indexOf(b), 1); b.dead = true;
    for (const v of [...b.fleet]) this.remove(v);
    for (const v of [...this.vehicles]) if (v.to === b || (v.job && (v.job.from === b || v.job.site === b))) this.bail(v);
    this.changed(); return true;
  }
  if (this.road[t]) { this.road[t] = 0; this.changed(); return true; }
  return false;
};

P.addHouse = function (x, y) {
  const h = { id: this.nextId++, t: y * W + x, x, y, level: 0, pantry: {}, sat: {}, next: this.time + 2 + this.rnd() * 20, car: null, door: -1, born: this.time, grew: this.time, site: null, hungry: false, shop: null, job: null, rest: 0 };
  for (const g in this.tree.homes[0].eat) { h.pantry[g] = this.pantryCap(0, g); h.sat[g] = 1; }
  this.at[h.t] = h; this.houses.push(h); this.changed();
  this.events.push({ type: 'house', x, y });
  return h;
};
P.pantryCap = function (level, g) { return this.tree.homes[level].eat[g] * this.T.pantry / 60; };

// ---- what a building takes, and how much -------------------------------

// every good homes eat at a level some home has reached, or the next one
P.shopGoods = function () {
  if (this.sgv === this.ver2) return this.sg;
  let top = 0; for (const h of this.houses) top = Math.max(top, h.level);
  const s = new Set();
  this.tree.homes.forEach((L, i) => { if (i <= top + 1 && (L.tier || 0) <= this.tier) for (const g in L.eat) s.add(g); });
  this.sgv = this.ver2; return this.sg = [...s];
};
// every good a building site or a growing home may ask for
P.buildGoods = function () {
  if (this.bgv === this.tier) return this.bg;
  const s = new Set();
  for (const k in this.kinds) if (this.open(k)) for (const g in this.kinds[k].cost || {}) s.add(g);
  this.tree.homes.forEach((L, i) => { const nx = this.tree.homes[i + 1]; if (nx && (nx.tier || 0) <= this.tier) for (const g in L.grow || {}) s.add(g); });
  this.bgv = this.tier; return this.bg = [...s];
};

P.wants = function (b) {
  const K = b.K;
  if (b.site) return [];
  if (K.shop) return this.shopGoods();
  if (K.builder) return this.buildGoods();
  if (K.harbour) return (this.tree.exports || []).filter(g => this.goodOpen(g));
  if (b.need) return Object.keys(b.need).filter(g => b.need[g] > 0);
  const w = K.ins ? Object.keys(K.ins) : [];
  const B = this.tree.boost;
  if (B && K.time && K.boost !== false && this.goodOpen(B.good) && !(K.out && K.out[B.good]) && !(K.ins && K.ins[B.good])) w.push(B.good);
  return w;
};
P.goodOpen = function (g) {
  if (!this.gov || this.gov.tier !== this.tier) {
    const s = new Set();
    for (const k in this.kinds) if (this.open(k)) { for (const o in this.kinds[k].out || {}) s.add(o); for (const o in this.kinds[k].brings || {}) s.add(o); }
    this.gov = { tier: this.tier, s };
  }
  return this.gov.s.has(g);
};
P.cap = function (b, g) {
  const K = b.K, T = this.T;
  if (K.shop) return T.shelf;
  if (K.builder) return T.stock;
  if (K.harbour) return T.quay;
  if (b.need) return b.need[g] || 0;
  if (K.ins && K.ins[g]) return K.ins[g] * 2 + T.load;
  return 2;   // the boost
};
P.room = function (b, g) { return this.cap(b, g) - (b.have[g] || 0) - (b.inc[g] || 0); };

// a crate made here goes to a neighbour that takes it
P.hand = function (b, g) {
  const near = b.near;
  for (let i = 0; i < near.length; i++) {
    const q = near[(b.rr + i) % near.length];
    if (q.site || q.dead || !this.wants(q).includes(g) || this.cap(q, g) - (q.have[g] || 0) < 1) continue;
    b.made[g]--; add(q.have, g, 1); q.fed[g] = this.time; add(this.stats.touch, g, 1);
    if (q.need) this.given(q, g, 1);
    b.rr = (b.rr + i + 1) % near.length;
    return true;
  }
  return false;
};
P.given = function (b, g, n) {   // a great work takes what it is given for good
  b.need[g] -= n; b.have[g] -= n;
  if (!Object.values(b.need).some(v => v > 0) && !b.done) { b.done = true; this.events.push({ type: 'done', x: b.x, y: b.y }); }
};

P.speed = function (b) {
  let s = 1;
  if (b.boost > 0) s *= this.tree.boost.speed;
  if (this.T.staff && b.K.time) s *= b.staff > 0 ? 1 : 0.5;
  return s;
};

P.stepParts = function (dt) {
  const B = this.tree.boost;
  for (const b of this.parts) {
    if (b.site) continue;
    const K = b.K;
    if (this.time >= b.handAt) for (const g in b.made) if (b.made[g] > 0 && this.hand(b, g)) { b.handAt = this.time + this.T.hand; break; }
    if (!K.time) continue;
    if (b.prog === 0) {
      b.state = ''; b.lack = null;
      if (K.out && Object.keys(K.out).some(g => (b.made[g] || 0) + K.out[g] > this.T.yard * this.T.load)) b.state = 'full';
      else if (K.ins && (b.lack = Object.keys(K.ins).find(g => (b.have[g] || 0) < K.ins[g]) || null)) b.state = 'lack';
      else {
        for (const g in K.ins || {}) { b.have[g] -= K.ins[g]; add(this.stats.used, g, K.ins[g]); }
        if (B && b.boost <= 0 && b.have[B.good] > 0) { b.have[B.good]--; b.boost = B.cycles; add(this.stats.used, B.good, 1); }
        b.prog = 1e-9;
      }
    }
    if (b.prog > 0) {
      b.prog += dt * this.speed(b) / K.time;
      if (b.prog >= 1) {
        b.prog = 0; if (b.boost > 0) b.boost--;
        for (const g in K.out || {}) { add(b.made, g, K.out[g]); add(this.stats.made, g, K.out[g]); }
        if (K.power) b.lit = this.time + K.time * 1.5;
      }
    }
  }
};

// ---- roads and what drives on them -------------------------------------

P.flood = function (start) {
  let f = this.floods.get(start);
  if (f) return f;
  const dist = new Int16Array(N).fill(-1), from = new Int32Array(N).fill(-1), q = [start];
  dist[start] = 0;
  for (let i = 0; i < q.length; i++) {
    const t = q[i];
    for (const n of this.nextTo(t)) if (this.road[n] && dist[n] < 0) { dist[n] = dist[t] + 1; from[n] = t; q.push(n); }
  }
  this.floods.set(start, f = { dist, from });
  return f;
};
P.path = function (a, b) {   // over the roads from a to b, or null
  if (a < 0 || b < 0) return null;
  const f = this.flood(a);
  if (f.dist[b] < 0) return null;
  const path = [];
  for (let c = b; c >= 0; c = f.from[c]) path.push(c);
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
P.dropJob = function (v) {
  const j = v.job; if (!j) return;
  if (j.type === 'fetch') { if (!v.load) add(j.from.res, j.g, -j.n); add(v.home.inc, j.g, -j.n); }
  else {
    for (const g in j.load) { if (j.site.site) add(j.site.site.inc, g, -j.load[g]); if (v.load) add(v.home.have, g, j.load[g]); }
  }
  v.job = null; v.load = null;
};
P.remove = function (v) {
  this.offRoad(v); this.dropJob(v);
  this.vehicles.splice(this.vehicles.indexOf(v), 1);
  if (v.kind === 'lorry') v.home.fleet.splice(v.home.fleet.indexOf(v), 1); else v.home.car = null;
};
// the road went from under it: home at once, the errand off
P.bail = function (v) {
  this.offRoad(v);
  if (v.kind === 'car') { if (v.at) { v.at.staff--; v.at = null; } v.home.next = this.time + 10; v.state = 'home'; v.to = null; return; }
  this.dropJob(v); v.state = 'home'; v.to = null;
};

P.arrive = function (v) {
  this.offRoad(v);
  if (v.state === 'back') { if (v.kind === 'car') { v.state = 'home'; v.to = null; } else { v.state = 'unloading'; v.wait = v.load ? this.T.dropTime : 0; } return; }
  if (v.kind === 'car') {
    if (v.errand === 'work') { v.state = 'working'; v.wait = this.T.shift; v.at = v.to; v.to.staff++; }
    else { v.state = 'shopping'; v.wait = 1.2; }
  } else { v.state = v.job.type === 'fetch' ? 'loading' : 'dropping'; v.wait = v.job.type === 'fetch' ? this.T.loadTime : this.T.dropTime; }
};

P.stepVehicle = function (v, dt) {
  if (v.state === 'home') return;
  if (v.state !== 'out' && v.state !== 'back') {
    v.wait -= dt;
    if (v.wait <= 0) this.done(v);
    return;
  }
  const car = v.kind === 'car';
  add(this.stats, car ? 'driveCar' : 'driveLorry', dt);
  const a = v.path[v.i], b = v.path[v.i + 1];
  if (!this.road[a] || !this.road[b]) return this.bail(v);
  if (!v.on) {
    if (!this.clear(a, b, v) && v.stuck < 8) { v.stuck += dt; return; }
    this.edge(a, b).push(v); v.on = true; v.stuck = 0;
  }
  if (v.held != null && a === v.held) { if (this.hold[v.held] === v) this.hold[v.held] = null; v.held = null; }
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
    if (!clear) {
      lim = Math.min(lim, junc ? STOPLINE : 0.999);
      if (junc && this.hold[b] === v && v.t <= STOPLINE) { this.hold[b] = null; v.held = null; }   // no way out yet: let the others cross
    }
  }
  if (ghost) lim = 2;
  const top = car ? this.T.carSpeed : this.T.lorrySpeed;
  v.v = Math.min(top, v.v + ACC * dt, Math.max(0, (lim - v.t) * 7 + 0.15));
  let nt = Math.min(v.t + v.v * dt, lim);
  if (nt <= v.t + 1e-5) { nt = v.t; v.v = 0; v.stuck += dt; this.wait[b] += dt; add(this.stats, car ? 'waitCar' : 'waitLorry', dt); }
  else { if (ghost) this.stats.ghosts++; v.stuck = 0; }
  v.t = nt;
  if (v.t >= 1) {
    if (this.deg[b] >= 3) { let f = this.flow.get(b); if (!f) this.flow.set(b, f = {}); add(f, v.tag, 1); }
    if (last) return this.arrive(v);
    const e = this.edge(a, b); e.splice(e.indexOf(v), 1);
    v.i++; v.t = Math.min(v.t - 1, 0.3);
    this.edge(b, v.path[v.i + 1]).push(v);
  }
};

P.goHome = function (v, from) {
  const p = this.path(from, v.home.door);
  if (!p) return this.bail(v);
  this.send(v, p, 'back');
};

P.done = function (v) {
  if (v.kind === 'car') {
    const h = v.home, s = v.to;
    if (v.state === 'working') { s.staff--; v.at = null; h.rest = this.time + this.T.shift * 0.5; }
    else if (!s.dead) {
      let got = 0;
      for (const g in h.pantry) {
        const n = Math.min(this.pantryCap(h.level, g) - h.pantry[g], s.have[g] || 0);
        if (n > 0) { s.have[g] -= n; h.pantry[g] += n; got += n; add(this.stats.sold, g, n); }
      }
      h.shop = s;
      if (got) this.events.push({ type: 'buy', x: s.x + 0.5, y: s.y + 0.5 });
    }
    return this.goHome(v, s.door);
  }
  const j = v.job, home = v.home;
  if (v.state === 'loading') {
    const n = j.from.dead ? 0 : Math.min(j.n, j.from.made[j.g] || 0);
    if (!j.from.dead) { j.from.made[j.g] -= n; add(j.from.res, j.g, -j.n); }
    v.load = { [j.g]: n };
    return this.goHome(v, j.from.door);
  }
  if (v.state === 'dropping') {
    const s = j.site, open = s.site;
    for (const g in j.load) {
      if (open) { add(open.inc, g, -j.load[g]); open.need[g] -= j.load[g]; } else add(home.have, g, j.load[g]);
    }
    if (open) { this.events.push({ type: 'drop', x: s.x + 0.5, y: s.y + 0.5 }); this.built(s); }
    v.load = null; v.job = null;
    return this.goHome(v, s.door);
  }
  // unloading at home
  if (j) {
    const n = v.load[j.g];
    add(home.have, j.g, n); add(home.inc, j.g, -j.n);
    if (home.need && n) this.given(home, j.g, n);
    if (n) this.events.push({ type: 'drop', x: home.x + 0.5, y: home.y + 0.5, g: j.g });
  }
  v.load = null; v.job = null; v.to = null; v.state = 'home';
};

P.built = function (s) {
  if (Object.values(s.site.need).some(n => n > 0)) return;
  s.site = null;
  if (s.K) { this.stats.built++; this.events.push({ type: 'built', x: s.x, y: s.y }); this.changed(); }
  else {
    s.level++; s.grew = this.time; this.stats.grown++; this.ver2 = this.time;
    for (const g in this.tree.homes[s.level].eat) if (!(g in s.pantry)) { s.pantry[g] = 0; s.sat[g] = 1; }
    this.events.push({ type: 'grow', x: s.x, y: s.y });
  }
};

// ---- lorries: each building fetches what it lacks ----------------------

P.lorriesOf = function (b) { return (b.K.lorries ?? 1) + b.garages + (this.took.fleet && (b.K.shop || b.K.builder) ? 1 : 0); };

// the nearest place with a load of g to spare, by road from a door
P.source = function (b, g, least) {
  const f = this.flood(b.door);
  let best = null, bd = 1e9;
  for (const s of this.parts) {
    if (s === b || s.site || s.door < 0 || !(s.made[g] > 0)) continue;
    const avail = s.made[g] - (s.res[g] || 0), d = f.dist[s.door];
    if (avail < least || d < 0 || d >= bd) continue;
    bd = d; best = s;
  }
  return best;
};

P.dispatch = function (b) {
  const T = this.T, idle = b.fleet.find(v => v.state === 'home');
  if (!idle) return;
  // a builder first takes what a site is waiting for
  if (b.K.builder) {
    let best = null, bl = null, bd = 1e9;
    const f = this.flood(b.door);
    for (const s of this.sites()) {
      if (s.door < 0 || f.dist[s.door] < 0) continue;
      let left = T.load, load = null;
      for (const g in s.site.need) {
        const n = Math.min(left, s.site.need[g] - (s.site.inc[g] || 0), b.have[g] || 0);
        if (n > 0) { (load = load || {})[g] = n; left -= n; }
      }
      const d = s.site.since + f.dist[s.door] * 0.5;   // the oldest first, the near a little sooner
      if (load && d < bd) { bd = d; best = s; bl = load; }
    }
    if (best) {
      for (const g in bl) { b.have[g] -= bl[g]; add(best.site.inc, g, bl[g]); }
      idle.job = { type: 'deliver', site: best, load: bl }; idle.load = { ...bl }; idle.to = best; idle.tag = 'build';
      const p = this.path(b.door, best.door);
      add(this.stats.trips, 'build', 1); add(this.stats.tiles, 'build', p.length * 2);
      return this.send(idle, p, 'out');
    }
  }
  const B = this.tree.boost;
  const list = this.wants(b).map(g => ({ g, fill: ((b.have[g] || 0) + (b.inc[g] || 0)) / this.cap(b, g) + (B && g === B.good ? 1 : 0) })).sort((p, q) => p.fill - q.fill);
  for (const { g } of list) {
    const room = this.room(b, g);
    if (room < 1) continue;
    const src = this.source(b, g, Math.min(room, T.load));   // a full load or none: a lorry never leaves for a crate
    if (!src) continue;
    const n = Math.min(T.load, room, src.made[g] - (src.res[g] || 0));
    add(src.res, g, n); add(b.inc, g, n);
    idle.job = { type: 'fetch', g, n, from: src }; idle.to = src; idle.tag = g;
    const p = this.path(b.door, src.door);
    add(this.stats.trips, g, 1); add(this.stats.tiles, g, p.length * 2);
    return this.send(idle, p, 'out');
  }
};

P.sites = function () {
  const out = [];
  for (const b of this.parts) if (b.site) out.push(b);
  for (const h of this.houses) if (h.site) out.push(h);
  return out;
};

P.stepFleets = function (dt) {
  for (const b of this.parts) {
    if (b.site) continue;
    if (!b.K.builder && !this.wants(b).length) continue;
    const n = this.lorriesOf(b);
    while (b.fleet.length < n) {
      const v = { id: this.nextId++, kind: 'lorry', home: b, state: 'home', path: [], i: 0, t: 0, v: 0, on: false, stuck: 0, held: null, load: null, job: null, to: null, tag: '' };
      b.fleet.push(v); this.vehicles.push(v);
    }
    b.think -= dt;
    if (b.think > 0 || b.door < 0) continue;
    b.think = 0.5;
    this.dispatch(b);
  }
};

// ---- the harbour -------------------------------------------------------

P.stepShip = function () {
  if (this.time < this.shipAt) return;
  this.shipAt = this.time + this.T.ship;
  for (const b of this.parts) {
    if (!b.K.harbour || b.site) continue;
    let left = this.T.shipLoad;
    for (const g of this.wants(b)) { const n = Math.min(left, b.have[g] || 0); if (n) { b.have[g] -= n; left -= n; add(this.stats.shipped, g, n); } }
    for (const g in b.K.brings || {}) b.made[g] = Math.min(this.T.quay, (b.made[g] || 0) + b.K.brings[g]);
    this.events.push({ type: 'ship', x: b.x, y: b.y });
  }
};

// ---- the town ----------------------------------------------------------

P.stepHouses = function (dt) {
  const homes = this.tree.homes;
  for (const h of this.houses) {
    const L = homes[h.level];
    for (const g in L.eat) h.pantry[g] = Math.max(0, h.pantry[g] - L.eat[g] * dt / 60);
    if (!h.car) { h.car = { id: this.nextId++, kind: 'car', home: h, state: 'home', path: [], i: 0, t: 0, v: 0, on: false, stuck: 0, held: null, to: null, tag: 'car', hue: (h.id * 47) % 360 }; this.vehicles.push(h.car); }
    if (h.car.state !== 'home' || this.time < h.next || h.door < 0) continue;
    const low = Object.keys(L.eat).filter(g => h.pantry[g] < this.pantryCap(h.level, g) * 0.5);
    if (low.length) {
      const f = this.flood(h.door);
      let best = null, bd = 1e9;
      for (const s of this.parts) if (s.K.shop && !s.site && s.door >= 0 && f.dist[s.door] >= 0 && f.dist[s.door] < bd && low.some(g => s.have[g] > 0.05)) { bd = f.dist[s.door]; best = s; }
      if (best) { h.car.to = best; h.car.errand = 'shop'; h.car.tag = 'car'; this.send(h.car, this.path(h.door, best.door), 'out'); h.next = this.time + 4; continue; }
      h.next = this.time + 5;
    }
    if (this.T.staff && this.time >= h.rest) {
      const f = this.flood(h.door);
      let best = null, bd = 1e9;
      for (const b of this.parts) {
        if (!b.K.time || b.site || b.door < 0 || f.dist[b.door] < 0) continue;
        const d = f.dist[b.door] + b.staff * 30;   // an empty floor first, then the near one
        if (d < bd) { bd = d; best = b; }
      }
      if (best) { h.car.to = best; h.car.errand = 'work'; h.car.tag = 'work'; this.send(h.car, this.path(h.door, best.door), 'out'); h.rest = this.time + 5; }
    }
  }
};

// once a second: how each home and building has been doing lately
P.stepSecond = function () {
  const homes = this.tree.homes, k = 0.04, goods = this.shopGoods(), mats = this.buildGoods();
  const asked = {};
  for (const s of this.sites()) for (const g in s.site.need) if (s.site.need[g] - (s.site.inc[g] || 0) > 0) asked[g] = true;
  for (const h of this.houses) {
    const L = homes[h.level], nx = homes[h.level + 1];
    let ok = true;
    for (const g in L.eat) { h.sat[g] += ((h.pantry[g] > 0 ? 1 : 0) - h.sat[g]) * k; if (h.sat[g] < 0.6) ok = false; }
    h.hungry = !ok;
    if (ok && nx && !h.site && (nx.tier || 0) <= this.tier && this.time - h.grew > 25 && h.shop && !h.shop.dead
      && Object.keys(L.eat).every(g => h.sat[g] > 0.8) && Object.keys(nx.eat).every(g => g in L.eat || h.shop.have[g] > 0.05) && this.rnd() < 0.08)
      h.site = { need: { ...L.grow }, inc: {}, since: this.time };
  }
  for (const b of this.parts) {
    if (b.site) continue;
    const s = b.s, K = b.K;
    if (K.time) {
      s.busy += ((b.prog > 0 ? 1 : 0) - s.busy) * k; s.full += ((b.state === 'full' ? 1 : 0) - s.full) * k;
      for (const g in K.ins || {}) s.lack[g] = (s.lack[g] || 0) + ((b.state === 'lack' && b.lack === g ? 1 : 0) - (s.lack[g] || 0)) * k;
    }
    if (b.fleet.length) s.away += (b.fleet.filter(v => v.state !== 'home').length / b.fleet.length - s.away) * k;
    if (K.shop) for (const g of goods) s.empty[g] = (s.empty[g] || 0) + ((b.have[g] > 0.05 ? 0 : 1) - (s.empty[g] || 0)) * k;
    if (K.builder) for (const g of mats) s.empty[g] = (s.empty[g] || 0) + ((asked[g] && !(b.have[g] >= 1) ? 1 : 0) - (s.empty[g] || 0)) * k;
  }
};

// tiles too near industry for a home
P.loud = function () {
  const loud = new Uint8Array(N), Q = this.T.quiet;
  for (const p of this.parts) if ((p.K.time || p.K.loud) && !p.K.quiet) {
    for (let dy = -Q; dy <= Q; dy++) for (let dx = -Q; dx <= Q; dx++) if (this.inside(p.x + dx, p.y + dy)) loud[p.t + dx + dy * W] = 1;
  }
  return loud;
};

P.grow = function () {
  if (!this.houses.length || this.houses.length >= 400) return;
  const hungry = this.houses.filter(h => h.hungry).length;
  if (hungry > this.houses.length * 0.15) return;
  const shops = this.parts.filter(s => s.K.shop && !s.site && s.door >= 0);
  const loud = this.loud();
  let best = -1, bs = 1e9;
  for (const s of shops) {
    const f = this.flood(s.door);
    for (let t = 0; t < N; t++) {
      if (!this.road[t] || f.dist[t] < 0 || f.dist[t] > this.T.reach) continue;
      for (const n of this.nextTo(t)) {
        if (loud[n] || !this.free(n)) continue;
        const score = f.dist[t] + this.rnd() * 5;
        if (score < bs) { bs = score; best = n; }
      }
    }
  }
  if (best >= 0) this.addHouse(best % W, (best / W) | 0);
};

P.count = function () {
  let n = 0;
  for (const h of this.houses) n += this.tree.homes[h.level].people;
  this.pop = n;
  const tiers = this.tree.tiers;
  const reached = t => t.pop != null ? n >= t.pop : this.houses.filter(h => h.level >= t.level).length >= t.homes;
  while (this.tier + 1 < tiers.length && reached(tiers[this.tier + 1])) { this.tier++; this.ver2 = this.time; this.changed(); this.events.push({ type: 'tier', tier: this.tier }); }
  const at = this.tree.pickAt || [];
  if (!this.offer && this.pickN < at.length && n >= at[this.pickN]) {
    const left = Object.keys(this.tree.picks).filter(k => !this.took[k] && (this.tree.picks[k].tier || 0) <= this.tier);
    this.offer = left.sort(() => this.rnd() - 0.5).slice(0, 3);
    this.pickN++;
    if (this.offer.length) this.events.push({ type: 'offer' }); else this.offer = null;
  }
};

P.pick = function (i) {
  if (!this.offer || !this.offer[i]) return false;
  const k = this.offer[i], p = this.tree.picks[k];
  this.took[k] = 1;
  for (const key in p.tune || {}) this.T[key] = typeof p.tune[key] === 'string' ? this.T[key] * +p.tune[key].slice(1) : p.tune[key];
  for (const kind in p.kinds || {}) Object.assign(this.kinds[kind], p.kinds[kind]);
  this.offer = null; this.changed();
  this.events.push({ type: 'pick', k });
  return true;
};

// ---- what is wrong, if anything ----------------------------------------

// follows a shortage up its chain to the one thing that holds it back
P.trace = function (g, seen = []) {
  if (seen.includes(g)) return { g, kind: 'loop', chain: seen };
  seen = seen.concat(g);
  const makers = this.parts.filter(b => !b.site && ((b.K.out && b.K.out[g]) || (b.K.brings && b.K.brings[g])));
  const what = Object.keys(this.kinds).find(k => this.open(k) && ((this.kinds[k].out || {})[g] || (this.kinds[k].brings || {})[g]));
  if (!makers.length) {
    const site = this.parts.find(b => b.site && b.kind === what);
    if (!site) return { g, kind: 'build', what, chain: seen };
    const m = Object.keys(site.site.need).find(m => site.site.need[m] > 0 && !this.parts.some(b => b.K.builder && b.have[m] >= 1));
    return m ? this.trace(m, seen) : { g, kind: 'site', what, chain: seen };
  }
  const avg = f => makers.reduce((n, b) => n + f(b), 0) / makers.length;
  if (makers.some(b => (b.made[g] || 0) - (b.res[g] || 0) >= this.T.load) || avg(b => b.s.full) > 0.3) return { g, kind: 'haul', chain: seen };
  let worst = null, wl = 0.3;
  for (const i in makers[0].K.ins || {}) { const l = avg(b => b.s.lack[i] || 0); if (l > wl) { wl = l; worst = i; } }
  if (worst) return this.trace(worst, seen);
  return { g, kind: avg(b => b.s.busy) > 0.7 ? 'more' : 'wait', what, chain: seen };
};

// the town's worst shortage and where it comes from
P.diagnose = function () {
  let worst = null, ws = 0.25;
  const look = (b, g, need) => { const e = b.s.empty[g] || 0; if (e > ws) { ws = e; worst = { g, at: b, need }; } };
  for (const b of this.parts) {
    if (b.site) continue;
    if (b.K.shop) for (const g of this.shopGoods()) look(b, g, 'shop');
    if (b.K.builder) for (const g of this.buildGoods()) look(b, g, 'builder');
  }
  if (!worst) return null;
  return Object.assign(this.trace(worst.g), { want: worst.g, at: worst.at, share: ws, need: worst.need });
};

// ---- time --------------------------------------------------------------

P.tick = function () {
  this.time += DT;
  this.stepParts(DT);
  this.stepFleets(DT);
  this.stepHouses(DT);
  for (const v of [...this.vehicles]) this.stepVehicle(v, DT);
  this.stepShip();
  if (this.time >= this.second) { this.second += 1; this.stepSecond(); }
  if (this.time >= this.growAt) { this.growAt = this.time + this.T.grow; this.grow(); this.count(); }
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

Object.assign(Sim, { W, H, N, GROUND, GR, DIRS, DT, TUNE });
if (typeof module !== 'undefined') module.exports = Sim; else root.Sim = Sim;

})(this);
