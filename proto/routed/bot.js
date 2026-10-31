// node bot.js [minutes] [seed]; QUIET=1 for the firsts and the end alone
require('./sim.js'); require('./brain.js');
const S = globalThis.SprawlRouted;
const minutes = +(process.argv[2] || 15), seed = +(process.argv[3] || 7), quiet = process.env.QUIET;
const s = new S.Sim(seed);
const fmt = t => `${(t / 60) | 0}:${String((t % 60) | 0).padStart(2, '0')}`;
const log = (...a) => { if (!quiet) console.log(fmt(s.time), ...a); };
const think = globalThis.makeBot(s, S, log);
for (let tick = 0; s.time < minutes * 60; tick++) {
  if (s.offer) think();
  s.step(1 / 30);
  for (const e of s.events) {
    if (e.type === 'open') log('OPEN', e.kind, S.xy(e.tile));
    if (e.type === 'grow') log('GROW to', S.LEVELS[e.level].name);
    if (e.type === 'leave') log('LEFT', e.good, e.gone ? '(empty)' : '(shrank)');
    if (e.type === 'status') log('STATUS', e.name);
    if (e.type === 'week') log('WEEK', e.week);
  }
  s.events.length = 0;
  if (tick % 15 === 0) think();
  if (tick % 1800 === 0) log(`people ${s.people()} routes ${s.routes.length} trucks ${s.trucks.length} hand ${JSON.stringify(s.hand)} delivered ${s.stats.delivered} left ${s.stats.left}`);
}
console.log('firsts', Object.fromEntries(Object.entries(s.stats.firsts).map(([k, v]) => [k, fmt(v)])));
console.log(`end: people ${s.people()} best ${s.best} delivered ${s.stats.delivered} left ${s.stats.left} routes ${s.routes.length} trucks ${s.trucks.length}`);
