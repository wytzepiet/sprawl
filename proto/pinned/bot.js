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
for (let tick = 0; s.time < minutes * 60; tick++) {
  s.step(dt);
  for (const e of s.events) {
    if (e.type === 'unlock') log('UNLOCK', e.kind);
    if (e.type === 'grow') log('GROW to', S.LEVELS[e.level].name);
    if (e.type === 'leave') log('LEFT', e.good, e.gone ? '(house gone)' : '(shrank)');
    if (e.type === 'status') log('STATUS', e.name);
    if (e.type === 'jam') log('JAM at', xy(e.tile));
  }
  s.events.length = 0;
  if (tick % 15) continue;   // the bot thinks twice a second

  think();
  const ppl = s.people();
  if (tick % 1800 === 0) {
    const waiting = s.pins.filter(p => p.kind === 'want').length;
    log(`people ${ppl} coins ${s.coins} houses ${[...s.buildings.values()].filter(b => b.house).length} trucks ${s.vehicles.length} pins ${s.pins.length} (wants ${waiting}) delivered ${s.stats.delivered} left ${s.stats.left}`);
  }
}
console.log('firsts', Object.fromEntries(Object.entries(s.stats.firsts).map(([k, v]) => [k, fmt(v)])));
console.log(`end: people ${s.people()} best ${s.best} delivered ${s.stats.delivered} left ${s.stats.left} coins ${s.coins}`);
