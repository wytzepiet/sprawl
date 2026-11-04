// A player who answers every pin promptly, to time the beats: node bot.js [minutes] [seed]
require('./sim.js');
const S = globalThis.SprawlPinned;
const { xy, at, cheb, STEPS4, STEPS8, KINDS, W, H } = S;

const minutes = +(process.argv[2] || 15), seed = +(process.argv[3] || 7);
const quiet = process.env.QUIET;
const s = new S.Sim(seed);

function log(...a) { if (!quiet) console.log(fmt(s.time), ...a); }
function fmt(t) { return `${(t / 60) | 0}:${String((t % 60) | 0).padStart(2, '0')}`; }

require('./brain.js');
const think = globalThis.makeBot(s, S, log);
const seenEv = new Set();
let lastPeople = -1, maxQueue = 0;
const dt = 1 / 30;
const DG = { idle: {}, lorry: {}, next: 120 };
function fill() { let have = 0, room = 0; for (const b of s.buildings.values()) if (b.stock) for (const g of b.sells) { have += Math.min(b.stock[g] || 0, b.shelf[g] || 2); room += b.shelf[g] || 2; } return room ? (have / room).toFixed(2) + ' of ' + room : '-'; }
let wasOpen = true;
for (let tick = 0; s.time < minutes * 60; tick++) {
  s.step(dt);
  if (process.env.DIAG) {
    for (const b of s.buildings.values()) if (!b.house) { const key = b.stock ? 'shop' : b.kind; const st = DG.idle[key] ||= {}; const why = b.stock ? (b.idle || 'ok') : (b.idle || 'working') + (b.crew < 2 ? '-short' : ''); st[why] = (st[why] || 0) + dt; }
    for (const v of s.vehicles) if (!v.car) { const b = s.B(v.home); if (b && b.stock) DG.lorry[v.state] = (DG.lorry[v.state] || 0) + dt; }
    if (s.time >= DG.next) { DG.next += 120; const out = {}; for (const k in DG.idle) { const t = Object.values(DG.idle[k]).reduce((a, b) => a + b, 0); out[k] = Object.entries(DG.idle[k]).map(([w, x]) => w + ' ' + Math.round(100 * x / t) + '%').join(', '); } log('DIAG wanted', JSON.stringify(s.stats.wanted), 'made', JSON.stringify(s.stats.made)); for (const k in out) log('   ', k, out[k]); const lt = Object.values(DG.lorry).reduce((a, b) => a + b, 0); log('    shop lorries', Object.entries(DG.lorry).map(([w, x]) => w + ' ' + Math.round(100 * x / lt) + '%').join(', ')); DG.idle = {}; DG.lorry = {}; }
  }
  if (process.env.SHELVES && wasOpen && !s.open()) log('DUSK shelves', fill());
  wasOpen = s.open();
  for (const e of s.events) {
    if (e.type === 'unlock') log('UNLOCK', e.kind);
    if (e.type === 'grow') log('GROW to', S.LEVELS[e.level].name);
    if (e.type === 'leave') log('LEFT', e.good, e.gone ? '(house gone)' : '(shrank)');
    if (e.type === 'status') log('STATUS', e.name);
    if (e.type === 'jam') log('JAM at', xy(e.tile));
    if (e.type === 'week') log('PICKTIME', e.week, 'left last week', s.leftThisWeek);
    if (e.type === 'day' && process.env.SHELVES) log('DAWN', e.day, 'left', e.left, 'shelves', fill());
  }
  s.events.length = 0;
  if (tick % 15) continue;   // the bot thinks twice a second

  think();
  const ppl = s.people();
  if (tick % 1800 === 0) {
    const waiting = s.pins.filter(p => p.kind === 'want').length;
    if (process.env.DUMP) for (const v of s.vehicles.filter(v => v.car)) log(" w", v.id, v.state, "job", v.job, "rest", v.rest.toFixed(1), "door", s.B(v.job)?.door, "home door", s.B(v.home)?.door);
    if (process.env.CREW) { const w = s.vehicles.filter(v => v.car), mk = [...s.buildings.values()].filter(b => !b.house && !b.stock); log(`crew: makers ${mk.length} seats ${mk.length * S.SEATS} hired ${w.filter(v => v.job >= 0).length}/${w.length} working ${w.filter(v => v.state === 'work').length} commuting ${w.filter(v => v.commuting).length} drive ${w.filter(v => v.state === 'drive').length} door ${w.filter(v => v.state === 'leave').length} ghost ${w.filter(v => v.ghost > 0).length} home ${w.filter(v => v.state === 'in').length}`); }
    log(`people ${ppl} roads ${s.roads} week ${s.week} picks ${[...s.buildings.values()].filter(b => b.house).length} trucks ${s.vehicles.length} pins ${s.pins.length} (wants ${waiting}) delivered ${s.stats.delivered} left ${s.stats.left}`);
  }
}
console.log('firsts', Object.fromEntries(Object.entries(s.stats.firsts).map(([k, v]) => [k, fmt(v)])));
console.log(`end: people ${s.people()} best ${s.best} delivered ${s.stats.delivered} left ${s.stats.left} roads ${s.roads}`);
