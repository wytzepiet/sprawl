// Play by hand, a few commands at a time; each call replays the log and adds to it.
//   node play.js <log> route 30,19 22,14   extend <n> <0|1> x,y   truck <n> [big]   trim <n> <0|1>
//                remove <n>   depot x,y   pick <k>   run <secs>   look   shot
const fs = require('fs'), path = require('path');
require('./sim.js');
const S = globalThis.SprawlRouted, { xy, at } = S;
const logFile = process.argv[2];
const cmds = process.argv.slice(3).join(' ').split(/\s*;\s*/).filter(Boolean);
const log = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, 'utf8')) : [];
const s = new S.Sim(+(process.env.SEED || 7));
const T = t => at(...t.split(',').map(Number));
const fmt = t => `${(t / 60) | 0}:${String(Math.round(t % 60)).padStart(2, '0')}`;
const notes = [];
function desc(e) {
  const p = e.tile !== undefined ? ' at ' + xy(e.tile) : '';
  if (e.type === 'open') return `OPEN ${e.kind}${p}`;
  if (e.type === 'grow') return `grew to ${S.LEVELS[e.level].name}${p}`;
  if (e.type === 'leave') return `LEFT (${e.good})${p}${e.gone ? ' empty' : ''}`;
  if (e.type === 'status') return `STATUS ${e.name}`;
  if (e.type === 'week') return `WEEK ${e.week} offer ${s.offer}`;
  if (e.type === 'spawn') return `house${p}`;
  return null;
}
function apply(c, rec) {
  const [op, ...a] = c.trim().split(/\s+/);
  let r = '';
  const R = n => s.routes[+n];
  if (op === 'route') { const q = s.newRoute(T(a[0]), T(a[1])); r = q ? `route ${s.routes.length - 1} (${q.col}) ${q.path.length} tiles` : 'REFUSED route'; }
  else if (op === 'extend') r = s.extend(R(a[0]), +a[1], T(a[2])) ? `extended ${a[0]} to ${R(a[0]).path.length} tiles` : 'REFUSED extend';
  else if (op === 'truck') r = s.addTruck(R(a[0]), false, a[1] === 'big') ? 'truck' : 'REFUSED truck';
  else if (op === 'trim') r = s.trim(R(a[0]), +a[1]) ? 'trimmed' : 'REFUSED';
  else if (op === 'remove') r = s.removeRoute(R(a[0])) ? 'removed' : 'REFUSED';
  else if (op === 'depot') r = s.placeDepot(T(a[0])) ? 'depot' : 'REFUSED depot';
  else if (op === 'pick') r = s.pick(+a[0]) ? 'picked ' + a[0] : 'REFUSED pick';
  else if (op === 'run') { const u = s.time + +a[0]; while (s.time < u - 1e-9 && !s.offer) { s.step(1 / 30); for (const e of s.events) { const d = desc(e); if (rec && d) notes.push(fmt(s.time) + ' ' + d); } s.events.length = 0; } r = `ran to ${fmt(s.time)}`; }
  if (rec) notes.push(fmt(s.time) + ' ' + r);
}
for (const c of log) apply(c, false);
s.events.length = 0;
for (const c of cmds.filter(c => c !== 'shot' && c !== 'look')) { apply(c, true); log.push(c); }
fs.writeFileSync(logFile, JSON.stringify(log));
console.log(notes.join('\n'));
if (s.dirty) s.reachAll();
console.log(`\n== ${fmt(s.time)} week ${s.week} (${Math.round(s.weekT)}s) hand ${JSON.stringify(s.hand)}${s.offer ? ' OFFER ' + s.offer : ''} people ${s.people()} ${S.STATUSES[s.status].name} left ${s.stats.left}`);
s.routes.forEach((r, k) => console.log(`  route ${k} ${r.col} ends ${xy(r.stops[0])} / ${xy(r.stops[r.stops.length - 1])} ${r.path.length} tiles, ${s.trucks.filter(t => t.route === r).length} trucks, serves ${r.on.size}`));
for (const p of s.places.values()) {
  const srv = s.served(p) ? '' : ' UNSERVED';
  if (p.house) { if (p.vacant) continue; const w = Object.entries(p.wants).filter(([, w]) => w.since >= 0).map(([g, w]) => `${g} ${Math.round((s.time - w.since) / S.PATIENCE * 100)}%${w.coming ? '*' : ''}`); console.log(`  ${S.LEVELS[p.level].name.padEnd(9)} ${String(xy(p.tile)).padEnd(6)}${srv} ${w.join(', ')}`); }
  else if (p.kind) console.log(`  ${p.kind.padEnd(10)} ${String(xy(p.tile)).padEnd(6)}${srv} out ${p.out} in ${p.inBuf} ${p.idle || ''}`);
  else console.log(`  depot ${xy(p.tile)} ${p.store}`);
}
if (cmds.includes('look')) {
  const B = s.bounds, road = s.roadTiles();
  const L = { fishery: 'F', farm: 'A', bakery: 'B', woodcutter: 'W', sawmill: 'S', workshop: 'O', sheep: 'E', tailor: 'T' };
  let hdr = '    '; for (let x = B.x0; x <= B.x1; x++) hdr += x % 10; console.log(hdr);
  for (let y = B.y0; y <= B.y1; y++) {
    let row = String(y).padStart(3) + ' ';
    for (let x = B.x0; x <= B.x1; x++) { const i = at(x, y), p = s.placeAt(i); row += p ? (p.house ? (p.vacant ? '_' : 'h234'[p.level]) : p.depot ? 'D' : L[p.kind]) : road.has(i) ? '=' : '.#~m='[s.terrain[i]]; }
    console.log(row);
  }
}
if (cmds.includes('shot')) {
  fs.writeFileSync(path.join(__dirname, '.replay.json'), JSON.stringify(log));
  require('child_process').execFileSync('node', [path.join(__dirname, 'shot-replay.js'), path.join(path.dirname(path.resolve(logFile)), 'play.png')], { stdio: 'inherit' });
}
