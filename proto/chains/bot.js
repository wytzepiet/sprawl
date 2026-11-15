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
const md = (t, u) => Math.abs(t % W - u % W) + Math.abs(((t / W) | 0) - ((u / W) | 0));

function Bot(s, mode = 'clever') {
  this.s = s; this.mode = mode;
  this.a = 4; this.b = 0;          // the street grid's half width and height
  this.last = {}; this.log = []; this.actAt = 0;
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
    const open = s.nextTo(t).filter(n => s.free(n) && !loud[n] && !this.planned(n)).length;
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
  return s.place(kind, best % W, (best / W) | 0);
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
B.takers = function (g) {
  const s = this.s;
  return s.parts.filter(b => (b.K.ins && b.K.ins[g]) || (b.K.shop && s.shopGoods().includes(g)) || (b.K.builder && s.buildGoods().includes(g)));
};
B.makers = function (g) { return this.s.parts.filter(b => (b.K.out && b.K.out[g]) || (b.K.brings && b.K.brings[g])); };

B.score = function (kind, t) {
  const s = this.s, K = s.kinds[kind], home = cy * W + cx;
  if (this.mode === 'naive') return K.near ? md(t, home) : md(t, home) + (s.doorOf(t) < 0 ? 3 : 0);
  // crates a minute times the tiles they travel; touching is free
  let sum = 0;
  const leg = (list, rate) => {
    if (!list.length) { sum += rate * md(t, home) * 0.7; return; }
    let d = 1e9; for (const b of list) d = Math.min(d, md(t, b.t));
    sum += rate * (d <= 1 ? 0 : d);
  };
  for (const g in K.ins || {}) leg(this.makers(g), K.ins[g] / K.time * 60);
  for (const g in K.out || {}) leg(this.takers(g), K.out[g] / K.time * 60);
  return sum + (s.doorOf(t) < 0 ? 4 : 0);
};

B.placeWorks = function (kind) {
  const s = this.s;
  if (!kind || s.parts.some(b => b.site && b.kind === kind)) return false;
  if (s.time - (this.last[kind] || -99) < 25) return false;
  let best = -1, bs = 1e12;
  const quiet = s.kinds[kind].quiet && this.mode === 'clever';
  for (let t = 0; t < N; t++) {
    if (s.why(kind, t % W, (t / W) | 0) || (quiet ? this.planned(t) : this.inTown(t))) continue;
    const sc = this.score(kind, t) + s.rnd() * 0.5;
    if (sc < bs) { bs = sc; best = t; }
  }
  if (best < 0) return false;
  const b = s.place(kind, best % W, (best / W) | 0);
  if (b.door < 0 && !this.join(b)) { s.erase(b.x, b.y); return false; }
  this.last[kind] = s.time; this.note(kind);
  return true;
};

// a road over free land from beside a building to the nearest road
B.join = function (b) {
  const s = this.s, starts = s.nextTo(b.t).filter(t => s.canRoad(t % W, (t / W) | 0));
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
  if (d.kind === 'build' || d.kind === 'more') return this.placeWorks(d.what);
  if (d.kind !== 'haul') return false;
  // crates wait at their makers: the one that should fetch them cannot keep up
  const g = d.g, last = d.chain[d.chain.length - 2];
  let who = g === d.want ? [d.at] : s.parts.filter(b => !b.site && b.K.ins && b.K.ins[g] && (!last || (b.K.out && b.K.out[last])));
  who = who.sort((p, q) => (q.s.lack[g] || q.s.empty[g] || 0) - (p.s.lack[g] || p.s.empty[g] || 0));
  const c = who[0];
  if (!c) return false;
  if (c.door < 0) return this.join(c);
  if (c.s.away > 0.6 && this.garage(c)) return true;
  if (c.s.away > 0.6 && c.K.shop && s.time - (this.last.shop2 || -99) > 60 && !s.parts.some(b => b.K.shop && b.site)) { this.last.shop2 = s.time; return !!this.townPart('shop', c.t); }
  if (c.s.away > 0.6 && c.K.time) return this.placeWorks(c.kind);
  return false;
};

B.step = function () {
  const s = this.s;
  this.town();
  if (s.time < this.actAt) return;
  const d = s.diagnose();
  this.problem = d;
  if (d && this.fix(d)) this.actAt = s.time + 6;
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
