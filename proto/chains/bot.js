// A player made of rules, to measure a tree by. It lays streets for the
// town, and every few seconds asks the game what is short and does the one
// obvious thing about it. `naive` puts a works near town; `clever` puts it
// where its heaviest crates travel least, touching what it can.
//   node bot.js [minutes] [seed] [naive|clever] [key=value …]
(function (root) {

const node = typeof module !== 'undefined';
const Sim = node ? require('./sim.js') : root.Sim;
const { W, H, N, GR, DIRS } = Sim;
const cx = W / 2, cy = H / 2;
const env = typeof process !== 'undefined' ? process.env : {};
const PACE = +env.PACE || 6;   // seconds between two moves on industry
const PATIENCE = +env.PATIENCE || 45;   // seconds a new works is watched before the same is built again
const md = (t, u) => Math.abs(t % W - u % W) + Math.abs(((t / W) | 0) - ((u / W) | 0));

function Bot(s, mode = 'clever') {
  this.s = s; this.mode = mode;
  this.a = 4; this.b = 0;          // the street grid's half width and height
  this.last = {}; this.log = []; this.actAt = 0; this.bad = new Set();
}
const B = Bot.prototype;

B.note = function (what) { this.log.push({ t: Math.round(this.s.time), pop: this.s.pop, what }); };

// ---- the town: streets, shops, builders --------------------------------

B.inTown = function (t, pad = 2) { return Math.abs(t % W - cx) <= this.a + pad && Math.abs(((t / W) | 0) - cy) <= this.b + pad; };

B.streets = function () {
  const s = this.s;
  if (this.a <= this.b * 2 + 4) this.a += 4; else this.b += 3;
  for (let again = true; again;) {
    again = false;
    for (let y = cy - this.b; y <= cy + this.b; y++) for (let x = cx - this.a; x <= cx + this.a; x++) {
      if ((y - cy) % 3 && (x - cx) % 8) continue;
      if (!s.canRoad(x, y) || !s.nextTo(y * W + x).some(n => s.road[n])) continue;
      s.setRoad(x, y); again = true;
    }
  }
  this.note('streets');
};

// free tiles where a home could come, and road tiles no shop reaches
B.spots = function () {
  const s = this.s, reach = new Uint8Array(N);
  for (const b of s.parts) if (b.K.shop && b.door >= 0) { const f = s.flood(b.door); for (let t = 0; t < N; t++) if (f.dist[t] >= 0 && f.dist[t] <= s.T.reach) reach[t] = 1; }
  let free = 0; const beyond = [], loud = s.loud();
  for (let t = 0; t < N; t++) {
    if (!s.road[t] || !this.inTown(t, 0)) continue;
    const open = s.nextTo(t).filter(n => s.free(n) && !loud[n] && !this.planned(n) && !s.road[2 * t - n]).length;
    if (reach[t]) free += open; else if (open) beyond.push(t);
  }
  return { free, beyond };
};
B.planned = function (t) { const x = t % W, y = (t / W) | 0; return this.inTown(t, 0) && (!((y - cy) % 3) || !((x - cx) % 8)); };

B.townPart = function (kind, near) {
  const s = this.s;
  let best = -1, bd = 1e9;
  for (let t = 0; t < N; t++) {
    if (s.why(kind, t % W, (t / W) | 0) || this.planned(t) || s.doorOf(t) < 0) continue;
    const d = md(t, near) + s.rnd();
    if (d < bd) { bd = d; best = t; }
  }
  if (best < 0) return null;
  this.note(kind);
  const b = s.place(kind, best % W, (best / W) | 0);
  // clever: a new shop gets beside it, in the same move, what may be made in town
  if (b && b.K.shop && this.mode === 'clever') for (const k in s.kinds) if (s.kinds[k].quiet && s.open(k) && Object.keys(s.kinds[k].out || {}).some(g => s.shopGoods().includes(g))) this.placeWorks(k, true);
  return b;
};

B.town = function () {
  const s = this.s;
  if (s.offer) { this.note('pick ' + s.offer[0]); s.pick(0); }
  const { free, beyond } = this.spots();
  if (free < 4 && s.time - (this.last.town || -99) > 12) {
    this.last.town = s.time;
    const shopSite = s.parts.some(b => b.K.shop && b.site);
    if (beyond.length && !shopSite) { beyond.sort((p, q) => md(p, cy * W + cx) - md(q, cy * W + cx)); this.townPart('shop', beyond[Math.min(beyond.length - 1, 6)]); }
    else if (!beyond.length) this.streets();
  }
  // a shop for every fourteen homes, where the others are far
  const shops = s.parts.filter(b => b.K.shop);
  if (s.houses.length > shops.length * 14 && !shops.some(b => b.site) && s.time - (this.last.shop || -99) > 30) {
    this.last.shop = s.time;
    let best = -1, bd = -1;
    for (const h of s.houses) { const d = Math.min(...shops.map(b => md(b.t, h.t))); if (d > bd) { bd = d; best = h.t; } }
    this.townPart('shop', best);
  }
  // a builder that cannot keep up gets a neighbour
  const builders = s.parts.filter(b => b.K.builder && !b.site), waiting = s.sites().filter(x => s.time - x.site.since > 40).length;
  if (waiting > 5 && builders.every(b => b.s.away > 0.8) && !s.parts.some(b => b.K.builder && b.site) && s.time - (this.last.builder || -99) > 60) {
    this.last.builder = s.time;
    const far = s.sites().sort((p, q) => p.site.since - q.site.since)[0];
    this.townPart('builder', far.t);
  }
};

// ---- industry: one answer to the worst shortage ------------------------

// who would take a crate of g, and who has one
B.takers = function (g) { return this.s.parts.filter(b => this.takes(b, g)); };
B.makers = function (g) { return this.s.parts.filter(b => (b.K.out && b.K.out[g]) || (b.K.brings && b.K.brings[g])); };

// crates a minute a works of kind K takes in or gives out of g; a shop or a builder is taken to want 15
const rate = (K, io, g) => K.time && (K[io] || {})[g] ? K[io][g] / K.time * 60 : 15;
const makes = (b, g) => (b.K.out && b.K.out[g]) || (b.K.brings && b.K.brings[g]);
B.boosts = function (b, g) { const Bo = this.s.tree.boost; return Bo && Bo.good === g && b.K.time && b.K.boost !== false && !makes(b, g) && !(b.K.ins && b.K.ins[g]); };
B.takes = function (b, g) { const s = this.s; return (b.K.ins && b.K.ins[g]) || (b.K.shop && s.shopGoods().includes(g)) || (b.K.builder && s.buildGoods().includes(g)) || ((b.K.harbour || b.need) && !b.site && s.wants(b).includes(g)) || this.boosts(b, g); };
B.wants = function (b, g) { const Bo = this.s.tree.boost; return this.boosts(b, g) ? 60 * Bo.speed / (Bo.cycles * b.K.time) : rate(b.K, 'ins', g); };
// what a maker has left for one more neighbour, and what a taker still lacks, counting only what touches
B.spare = function (m, g) {
  let r = rate(m.K, 'out', g);
  for (const q of m.near) if (this.takes(q, g)) r -= this.wants(q, g) / q.near.filter(x => makes(x, g)).length;
  return Math.max(0, r);
};
B.unmet = function (k, g) {
  let r = this.wants(k, g);
  for (const q of k.near) if (makes(q, g)) r -= rate(q.K, 'out', g) / q.near.filter(x => this.takes(x, g)).length;
  return Math.max(0, r);
};
// the ground a good comes out of, when nothing makes it yet
B.ground = function (g) {
  const s = this.s, k = Object.keys(s.kinds).find(k => s.kinds[k].near && (s.kinds[k].out || {})[g]);
  if (!k) return null;
  const key = 'ground' + g;
  if (!this[key]) { this[key] = []; for (let t = 0; t < N; t++) if (s.terrain[t] === GR[s.kinds[k].near]) this[key].push(t); }
  return this[key];
};

// the kind that digs g out of the ground, if one does
B.rawKind = function (g) { const s = this.s; return Object.keys(s.kinds).find(k => s.kinds[k].near && !s.kinds[k].ins && (s.kinds[k].out || {})[g]); };

B.score = function (kind, t) {
  const s = this.s, K = s.kinds[kind], home = cy * W + cx;
  if (this.mode === 'naive') return K.near ? md(t, home) : md(t, home) + (s.doorOf(t) < 0 ? 3 : 0);
  // crates a minute times the tiles they travel. What touches travels none,
  // as far as the neighbour has it to spare or still wants it; and a works
  // beside its ground can have its own diggers put against it.
  const near = s.nextTo(t).map(n => s.at[n]).filter(q => q && q.K);
  const free = s.nextTo(t).filter(n => s.free(n)), used = new Set();
  let slots = free.length - (s.doorOf(t) < 0 ? 1 : 0), sum = 0;
  for (const g in K.ins || {}) {
    let r = rate(K, 'ins', g), d = 1e9;
    const list = this.makers(g);
    for (const b of list) if (near.includes(b)) r -= this.spare(b, g); else d = Math.min(d, md(t, b.t) + (b.site || this.spare(b, g) > 0 ? 0 : 6));
    const k = this.rawKind(g);
    if (k) for (const n of free) if (r > 0 && slots > 0 && !used.has(n) && !s.why(k, n % W, (n / W) | 0)) { r -= rate(s.kinds[k], 'out', g); used.add(n); slots--; sum += 2; }
    if (r <= 0) continue;
    const gr = this.ground(g);
    if (gr) for (const u of gr) d = Math.min(d, md(t, u) + 4);   // a works half fed by touch takes its neighbours' crates by lorry
    sum += r * (d === 1e9 ? md(t, home) * 0.7 : d);
  }
  for (const g in K.out || {}) {
    let r = rate(K, 'out', g), w = 0, wd = 0;
    for (const b of this.takers(g)) {
      const u = this.unmet(b, g), mine = !this.forKinds || this.forKinds.includes(b.kind);
      if (near.includes(b)) { if (mine) r -= u; else if (u > 0) sum += 200; }   // a neighbour it was not meant for would take the lot
      else if (mine) { w += u + 0.1; wd += (u + 0.1) * md(t, b.t); }
    }
    if (r > 0) sum += r * (w ? wd / w : md(t, home) * 0.7);
  }
  // a harbour near what it ships, a great work near what it is built of
  const far = (g, w) => { let d = 1e9; for (const b of this.makers(g)) d = Math.min(d, md(t, b.t)); sum += w * (d === 1e9 ? md(t, home) : d); };
  if (K.harbour) for (const g of s.tree.exports || []) far(g, 8);
  for (const g in K.need || {}) far(g, K.need[g] / 10);
  if (K.near && near.some(b => b.kind === kind)) sum += 12;   // leave a gap between two of a kind for the works they feed
  return sum + (s.doorOf(t) < 0 && free.length < 1 ? 50 : 0);
};

B.placeWorks = function (kind, now, forKinds) {
  const s = this.s;
  this.forKinds = forKinds;   // who is short of what this makes, when the game said
  if (!kind || !now && s.parts.some(b => b.site && b.kind === kind)) return false;
  if (!now && s.time - (this.last[kind] || -99) < 25) return false;
  let best = -1, bs = 1e12;
  const quiet = s.kinds[kind].quiet && this.mode === 'clever';
  for (let t = 0; t < N; t++) {
    if (s.why(kind, t % W, (t / W) | 0) || (quiet ? this.planned(t) : this.inTown(t)) || this.bad.has(t)) continue;
    const sc = this.score(kind, t) + s.rnd() * 0.5;
    if (sc < bs) { bs = sc; best = t; }
  }
  if (best < 0) return false;
  const b = this.put(kind, best);
  if (!b) return false;
  this.last[kind] = s.time; this.note(kind);
  if (this.mode === 'clever') this.block(b);
  return true;
};

// a building and its road; a tile that cannot be reached is not tried again
B.put = function (kind, t) {
  const s = this.s, b = s.place(kind, t % W, (t / W) | 0);
  if (b.door < 0 && !this.join(b)) { s.erase(b.x, b.y); this.bad.add(t); return null; }
  return b;
};

// clever: the diggers a works wants, against it, in the same move
B.block = function (b) {
  const s = this.s;
  for (const g in b.K.ins || {}) {
    const k = this.rawKind(g);
    if (!k || !s.open(k)) continue;
    for (const n of s.nextTo(b.t)) {
      if (this.unmet(b, g) < rate(s.kinds[k], 'out', g) * 0.4) break;
      if (!s.why(k, n % W, (n / W) | 0) && this.put(k, n)) this.note(k + ' at ' + b.kind);
    }
  }
};

// a road over free land from beside a building to the nearest road
B.join = function (b) {
  const s = this.s;
  let starts = s.nextTo(b.t).filter(t => s.canRoad(t % W, (t / W) | 0));
  if (this.mode === 'clever') {   // not over the ground's edge, where the next works wants to stand
    const raw = Object.keys(s.kinds).filter(k => s.kinds[k].near);
    const off = starts.filter(t => !raw.some(k => !s.why(k, t % W, (t / W) | 0)));
    if (off.length) starts = off;
  }
  const from = new Map(starts.map(t => [t, -1])), q = [...starts];
  for (let i = 0; i < q.length; i++) {
    const t = q[i];
    for (const n of s.nextTo(t)) {
      if (from.has(n)) continue;
      if (s.road[n]) { for (let c = t; c >= 0; c = from.get(c)) s.setRoad(c % W, (c / W) | 0); return true; }
      if (s.canRoad(n % W, (n / W) | 0)) { from.set(n, t); q.push(n); }
    }
  }
  return false;
};

B.garage = function (b) {
  const s = this.s;
  if (!s.open('garage') || b.garages >= 2 || s.time - (this.last['g' + b.id] || -99) < 40) return false;
  const t = s.nextTo(b.t).find(n => !s.why('garage', n % W, (n / W) | 0) && !(s.doorOf(b.t) === n));
  if (t == null) return false;
  s.place('garage', t % W, (t / W) | 0);
  this.last['g' + b.id] = s.time; this.note('garage at ' + b.kind);
  return true;
};

B.fix = function (d) {
  const s = this.s;
  if (d.kind === 'build' || d.kind === 'more') {
    const up = d.chain[d.chain.length - 2];
    return this.placeWorks(d.what, false, up ? Object.keys(s.kinds).filter(k => (s.kinds[k].out || {})[up] && (s.kinds[k].ins || {})[d.g]) : [d.at.kind]);
  }
  if (d.kind !== 'haul') return false;
  // crates wait at their makers: the one that should fetch them cannot keep up
  const g = d.g, last = d.chain[d.chain.length - 2];
  let who = g === d.want ? [d.at] : s.parts.filter(b => !b.site && b.K.ins && b.K.ins[g] && (!last || (b.K.out && b.K.out[last])));
  who = who.sort((p, q) => (q.s.lack[g] || q.s.empty[g] || 0) - (p.s.lack[g] || p.s.empty[g] || 0));
  const c = who[0];
  if (!c) return false;
  if (c.door < 0) return this.join(c);
  // clever: what may stand in town goes beside the shop that is short of it
  const mk = Object.keys(s.kinds).find(k => s.kinds[k].quiet && (s.kinds[k].out || {})[g]);
  if (this.mode === 'clever' && c.K.shop && mk && !c.near.some(b => makes(b, g)) && this.placeWorks(mk)) return true;
  if (c.s.away > 0.6 && this.garage(c)) return true;
  if (c.s.away > 0.6 && c.K.shop && s.time - (this.last.shop2 || -99) > 60 && !s.parts.some(b => b.K.shop && b.site)) { this.last.shop2 = s.time; return !!this.townPart('shop', c.t); }
  if (c.s.away > 0.6 && c.K.time) return this.placeWorks(c.kind);
  // a builder that cannot fetch what waits for it gets a second one: in town, or (clever) against the yard that is full
  if (c.s.away > 0.6 && c.K.builder && s.time - (this.last.builder2 || -99) > 45 && !s.parts.some(b => b.K.builder && b.site)) {
    this.last.builder2 = s.time;
    return this.mode === 'clever' && this.beside('builder', g) || !!this.townPart('builder', c.t);
  }
  return false;
};

// against a maker of g that has it to spare, the fullest yard first
B.beside = function (kind, g) {
  const s = this.s;
  for (const m of this.makers(g).filter(m => !m.site && this.spare(m, g) > 0).sort((p, q) => q.s.full - p.s.full)) {
    for (const n of s.nextTo(m.t)) if (!s.why(kind, n % W, (n / W) | 0) && !this.bad.has(n) && this.put(kind, n)) { this.note(kind + ' at ' + m.kind); return true; }
  }
  return false;
};

// tools: a first works for them once there is iron, and another when most works run dry
B.tools = function () {
  const s = this.s, Bo = s.tree.boost;
  if (!Bo) return false;
  const kind = Object.keys(s.kinds).find(k => (s.kinds[k].out || {})[Bo.good]);
  if (!kind || !s.open(kind)) return false;
  const works = s.parts.filter(b => b.kind === kind);
  if (works.some(b => b.site)) return false;
  if (!works.length) return Object.keys(s.kinds[kind].ins).every(g => s.stats.made[g] > 0) && this.placeWorks(kind);
  const users = s.parts.filter(b => !b.site && b.door >= 0 && this.boosts(b, Bo.good));
  if (users.filter(b => b.boost <= 0).length <= users.length * 0.5) return false;
  const d = s.trace(Bo.good);   // most works run dry: more of whatever holds it back
  return (d.kind === 'more' || d.kind === 'build') && this.placeWorks(d.what);
};

// the things no shortage asks for: a harbour, and one great work at a time
B.empire = function () {
  const s = this.s;
  if (s.time - (this.last.empire || -99) < 10) return;
  this.last.empire = s.time;
  for (const g of s.tree.exports || []) {
    if (!s.goodOpen(g) || this.makers(g).length) continue;
    if (this.placeWorks(Object.keys(s.kinds).find(k => s.open(k) && (s.kinds[k].out || {})[g]))) return;
  }
  for (const kind in s.kinds) {
    const K = s.kinds[kind];
    if (!s.open(kind) || s.parts.some(b => b.kind === kind)) continue;
    if (K.harbour && this.placeWorks(kind)) return;
    if (K.need && !s.parts.some(b => b.need && !b.done) && this.placeWorks(kind)) return;
  }
};

B.step = function () {
  const s = this.s;
  this.town();
  this.empire();
  if (s.time < this.actAt) return;
  if (this.tools()) { this.actAt = s.time + PACE; return; }
  this.problem = s.diagnose();
  // the worst shortage first, and when nothing can be done about it, the next
  for (const d of this.shortages()) if (this.fix(d)) { this.actAt = s.time + PACE; break; }
};

// every shortage the game shows, the worst first, each traced to its cause
B.shortages = function () {
  const s = this.s, out = [];
  for (const b of s.parts) {
    if (b.site || !(b.K.shop || b.K.builder)) continue;
    for (const g of b.K.shop ? s.shopGoods() : s.buildGoods()) if ((b.s.empty[g] || 0) > 0.25) out.push({ g, at: b, share: b.s.empty[g] });
  }
  return out.sort((p, q) => q.share - p.share).map(w => Object.assign(s.trace(w.g), { want: w.g, at: w.at, share: w.share }));
};

// ---- a run, and what it measured ---------------------------------------

function run({ minutes = 20, seed = 7, mode = 'clever', tree = node ? require('./tree.js') : root.Tree, opts = {}, each } = {}) {
  const s = new Sim(seed, tree, opts), bot = new Bot(s, mode);
  const rows = [], tierAt = [0];
  let prev = JSON.parse(JSON.stringify(s.stats));
  for (let m = 1; m <= minutes; m++) {
    const kinds = {};
    for (let k = 0; k < 20; k++) {
      s.run(3); bot.step();
      const d = bot.problem; if (d) { const key = d.kind + ':' + d.g; kinds[key] = (kinds[key] || 0) + 1; }
    }
    while (tierAt.length <= s.tier) tierAt.push(m);
    const st = s.stats, sum = o => Object.values(o).reduce((a, b) => a + b, 0);
    const trips = sum(st.trips) - sum(prev.trips), tiles = sum(st.tiles) - sum(prev.tiles);
    const levels = s.tree.homes.map((_, i) => s.houses.filter(h => h.level === i).length);
    const top = Object.entries(kinds).sort((a, b) => b[1] - a[1])[0];
    rows.push({
      m, pop: s.pop, homes: levels, hungry: s.houses.filter(h => h.hungry).length, tier: s.tier, parts: s.parts.length, sites: s.sites().length,
      trips, tripLen: trips ? tiles / trips / 2 : 0,
      touch: sum(st.touch) - sum(prev.touch),
      waitCar: (st.waitCar - prev.waitCar) / Math.max(1, st.driveCar - prev.driveCar),
      waitLorry: (st.waitLorry - prev.waitLorry) / Math.max(1, st.driveLorry - prev.driveLorry),
      ghosts: st.ghosts - prev.ghosts,
      problem: top ? top[0] : '-', share: top ? top[1] / 20 : 0,
    });
    prev = JSON.parse(JSON.stringify(st));
    if (each) each(s, bot, rows[rows.length - 1]);
  }
  return { s, bot, rows, tierAt };
}

// the junctions that carry most, and what crosses there
function junctions(s, n = 5) {
  const out = [];
  for (const [t, f] of s.flow) {
    const total = Object.values(f).reduce((a, b) => a + b, 0), cars = (f.car || 0) + (f.work || 0);
    out.push({ x: t % W, y: (t / W) | 0, total, cars, lorries: total - cars, goods: Object.keys(f).filter(k => k !== 'car' && k !== 'work' && f[k] > total * 0.03).length, wait: Math.round(s.wait[t]), f });
  }
  return out.sort((a, b) => b.total - a.total).slice(0, n);
}

Object.assign(Bot, { run, junctions });
if (node) module.exports = { Bot, run, junctions }; else root.Bot = Bot;

if (node && require.main === module) {
  const [mins, seed, mode, ...rest] = process.argv.slice(2);
  const opts = Object.fromEntries(rest.map(kv => { const [k, v] = kv.split('='); return [k, isNaN(+v) ? v === 'true' : +v]; }));
  const { s, bot, rows, tierAt } = run({ minutes: +mins || 20, seed: +seed || 7, mode: mode || 'clever', opts });
  for (const r of rows) console.log(`${String(r.m).padStart(2)}m pop ${String(r.pop).padStart(4)} homes ${r.homes.join('/')} hungry ${r.hungry} tier ${r.tier} parts ${r.parts} sites ${r.sites} | trips ${r.trips} x${r.tripLen.toFixed(1)} touch ${r.touch} | wait car ${(r.waitCar * 100).toFixed(0)}% lorry ${(r.waitLorry * 100).toFixed(0)}% ghosts ${r.ghosts} | ${r.problem} ${(r.share * 100).toFixed(0)}%`);
  console.log('tiers reached at minute', tierAt.join(', '));
  console.log('acts:', bot.log.map(a => `${a.t}s ${a.what}`).join(' · '));
  const st = s.stats;
  console.log('good        made   trips  tiles/trip  by touch');
  for (const g in s.tree.goods) if (st.made[g]) console.log(g.padEnd(10), String(st.made[g]).padStart(6), String(st.trips[g] || 0).padStart(6), ((st.tiles[g] || 0) / (st.trips[g] || 1) / 2).toFixed(1).padStart(8), String(st.touch[g] || 0).padStart(10));
  console.log('build trips', st.trips.build, 'built', st.built, 'grown', st.grown, 'shipped', JSON.stringify(st.shipped));
  console.log('kind         n  busy full away  waits for');
  const by = {};
  for (const p of s.parts) if (!p.site) (by[p.kind] = by[p.kind] || []).push(p);
  for (const k in by) { const l = by[k], a = f => (l.reduce((n, p) => n + f(p), 0) / l.length * 100).toFixed(0).padStart(4); const lk = {}; for (const p of l) for (const g in { ...p.s.lack, ...p.s.empty }) lk[g] = (lk[g] || 0) + (p.s.lack[g] || p.s.empty[g] || 0) / l.length; console.log(k.padEnd(11), String(l.length).padStart(2), a(p => p.s.busy), a(p => p.s.full), a(p => p.s.away), ' ' + Object.entries(lk).filter(e => e[1] > 0.05).map(e => `${e[0]} ${(e[1] * 100).toFixed(0)}%`).join(', ')); }
  for (const j of junctions(s)) console.log(`junction ${j.x},${j.y}: ${j.total} passes, ${j.lorries} lorries of ${j.goods} goods, waited ${j.wait}s`, JSON.stringify(j.f));
}

})(this);
