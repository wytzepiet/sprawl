// Play by hand, a few commands at a time. The game is the same from the same
// inputs, so each call replays the log and adds to it.
//   node play.js <log> road 32,12 37,12 ...   place sawmill 30,10   truck 30,10
//                round 30,10   erase 30,10   remove 30,10   run 20   shot   look
const fs = require('fs');
const path = require('path');
require('./sim.js');
const S = globalThis.SprawlPinned;
const { xy, at } = S;

const logFile = process.argv[2];
const cmds = process.argv.slice(3).join(' ').split(/\s*;\s*|\s+(?=(?:road|place|truck|round|erase|remove|run|shot|look|pick)\b)/).filter(Boolean);
const log = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, 'utf8')) : [];
const s = new S.Sim(7);
const DT = 1 / 30;
const P = t => t.split(',').map(Number);
const T = t => at(...P(t));
function line8(a, b) {
  const out = []; let [x, y] = xy(a); const [tx, ty] = xy(b);
  while (x !== tx || y !== ty) { x += Math.sign(tx - x); y += Math.sign(ty - y); out.push(at(x, y)); }
  return out;
}
const notes = [];
function apply(c, record) {
  const [op, ...a] = c.trim().split(/\s+/);
  let r = '';
  if (op === 'road') {
    let spent = 0, fails = 0;
    for (let k = 0; k < a.length - 1; k++) {
      let prev = T(a[k]);
      for (const j of line8(prev, T(a[k + 1]))) { const c2 = s.addRoad(prev, j); if (c2 < 0) fails++; else spent += c2; prev = j; }
    }
    r = `road spent ${spent}${fails ? ` (${fails} steps refused)` : ''}`;
  } else if (op === 'place') r = s.place(a[0], T(a[1])) ? `placed ${a[0]}` : `REFUSED ${a[0]} at ${a[1]}`;
  else if (op === 'truck') r = s.addTruck(s.B(s.tileB.get(T(a[0])))) ? 'truck added' : 'REFUSED truck';
  else if (op === 'round') r = s.addRoundabout(T(a[0])) ? 'roundabout' : 'REFUSED roundabout';
  else if (op === 'erase') r = s.removeRoadTile(T(a[0])) ? 'erased' : 'nothing to erase';
  else if (op === 'remove') r = s.removeBuilding(s.tileB.get(T(a[0]))) ? 'removed' : 'REFUSED remove';
  else if (op === 'pick') r = s.pick(+a[0]) ? 'picked ' + a[0] : 'REFUSED pick';
  else if (op === 'run') { const until = s.time + +a[0]; while (s.time < until - 1e-9 && !s.offer) { s.step(DT); for (const e of s.events) if (record) notes.push(fmt(s.time) + ' ' + desc(e)); s.events.length = 0; } r = `ran to ${fmt(s.time)}`; }
  if (record && op !== 'run') notes.push(fmt(s.time) + ' ' + r);
  return r;
}
function fmt(t) { return `${(t / 60) | 0}:${String(Math.round(t % 60)).padStart(2, '0')}`; }
function desc(e) {
  if (e.type === 'unlock') return `UNLOCK ${e.kind}`;
  if (e.type === 'spawn') return `new house at ${xy(e.tile)}`;
  if (e.type === 'grow') return `house at ${xy(e.tile)} grew to ${S.LEVELS[e.level].name}`;
  if (e.type === 'leave') return `LEFT at ${xy(e.tile)} (${e.good})`;
  if (e.type === 'status') return `STATUS ${e.name}`;
  if (e.type === 'jam') return `JAM at ${xy(e.tile)}`;
  if (e.type === 'deliver') return `delivered ${e.good} to ${xy(e.tile)}${e.pay ? ' +' + e.pay : ''}`;
  return e.type;
}
for (const c of log) apply(c, false);
for (const c of s.events.splice(0)) {}
const shoot = cmds.includes('shot');
for (const c of cmds.filter(c => c !== 'shot' && c !== 'look')) { apply(c, true); log.push(c); }
fs.writeFileSync(logFile, JSON.stringify(log));
console.log(notes.filter(n => !/delivered/.test(n) || process.env.ALL).join('\n'));
console.log(`delivered ${notes.filter(n => /delivered/.test(n)).length} in this step`);

// the state, as a player would read the screen
console.log(`\n== ${fmt(s.time)}  week ${s.week} (${Math.round(s.weekT)}s)  roads ${s.roads}  hand ${JSON.stringify(s.tokens)}${s.offer ? '\n  OFFER: ' + JSON.stringify(s.offer.map(o => o.type + ':' + (o.kind || o.n))) : ''}  people ${s.people()}  ${S.STATUSES[s.status].name}  bounds x${s.bounds.x0}-${s.bounds.x1} y${s.bounds.y0}-${s.bounds.y1}`);
for (const b of s.buildings.values()) {
  const pins = s.pins.filter(p => p.at === b.id).map(p => `${p.good}${p.kind === 'build' ? '(build)' : p.kind === 'input' ? '(in)' : ''}${p.kind === 'want' ? ' ' + Math.round((s.time - p.born) / S.PATIENCE * 100) + '%' : ''}${p.by >= 0 ? '*' : ''}`);
  if (b.house) console.log(`  ${S.LEVELS[b.level].name.padEnd(9)} ${String(xy(b.tile)).padEnd(6)} ${b.door < 0 ? 'NO ROAD ' : ''}happy ${b.happy}${b.quiet ? ' QUIET' : ''}  ${pins.join(', ')}`);
  else console.log(`  ${b.kind.padEnd(10)} ${String(xy(b.tile)).padEnd(6)} ${b.door < 0 ? 'NO ROAD ' : ''}trucks ${b.trucks.length} out ${b.out} ${b.idle || 'working'} ${JSON.stringify(b.inBuf)}  ${pins.join(', ')}`);
}
if (cmds.includes('look')) {
  // the map around the bounds as text: H house, letters for producers, = road
  const B = s.bounds;
  const letter = { fishery: 'F', woodcutter: 'W', sawmill: 'S', farm: 'A', bakery: 'B', claypit: 'C', brickworks: 'K', workshop: 'O' };
  let hdr = '    '; for (let x = B.x0; x <= B.x1; x++) hdr += x % 10; console.log(hdr);
  for (let y = B.y0; y <= B.y1; y++) {
    let r = String(y).padStart(3) + ' ';
    for (let x = B.x0; x <= B.x1; x++) {
      const i = at(x, y), id = s.tileB.get(i);
      r += id !== undefined ? (s.B(id).house ? 'h123'[s.B(id).level] : letter[s.B(id).kind]) : s.adj.has(i) ? '=' : '.#~mc'[s.terrain[i]];
    }
    console.log(r);
  }
}
if (shoot) {
  const { execFileSync } = require('child_process');
  const out = path.join(path.dirname(path.resolve(logFile)), 'play.png');
  fs.writeFileSync(path.join(__dirname, '.replay.json'), JSON.stringify(log));
  execFileSync('node', [path.join(__dirname, 'shot-replay.js'), out], { stdio: 'inherit' });
}
