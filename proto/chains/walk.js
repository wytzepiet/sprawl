// Where the town is held back, step by step: node walk.js [minutes] [seeds]
// For each step of the ladder: what was short and why, how many lorry trips
// a minute and how long, and what met at the busiest junction.
const { run, junctions } = require('./bot.js');
const Sim = require('./sim.js');
const [mins = 30, seeds = 8] = process.argv.slice(2);
const cx = Sim.W / 2, cy = Sim.H / 2;
for (const mode of ['naive', 'clever']) {
  const steps = [];
  const at = i => steps[i] || (steps[i] = { min: 0, probs: {}, trips: 0, tiles: 0, pop: 0, j: [], runs: 0 });
  for (let seed = 1; seed <= +seeds; seed++) {
    let tier = 0;
    const close = s => {
      const j = junctions(s, 1)[0];
      if (j) at(tier).j.push({ far: Math.abs(j.x - cx) + Math.abs(j.y - cy), lorries: j.lorries / j.total, goods: j.goods, wait: j.wait, top: Object.entries(j.f).filter(e => e[0] !== 'car').sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]) });
      s.flow = new Map(); s.wait.fill(0); at(tier).runs++;
    };
    const { s } = run({ minutes: +mins, seed, mode, each: (s, bot, r) => {
      if (s.tier !== tier) { close(s); tier = s.tier; }
      const st = at(tier); st.min++; st.trips += r.trips; st.tiles += r.trips * r.tripLen; st.pop += r.pop;
      st.probs[r.problem] = (st.probs[r.problem] || 0) + 1;
    } });
    close(s);
  }
  console.log(`\n${mode.toUpperCase()} (${seeds} lands, ${mins} minutes)`);
  steps.forEach((st, i) => {
    const probs = Object.entries(st.probs).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k === '-' ? 'nothing' : k.replace(':', ' ')} ${(n / st.min * 100).toFixed(0)}%`).join(', ');
    const a = f => st.j.reduce((n, j) => n + f(j), 0) / Math.max(1, st.j.length);
    const tops = {}; for (const j of st.j) for (const g of j.top) tops[g] = (tops[g] || 0) + 1;
    console.log(`step ${i}: ${(st.min / st.runs).toFixed(1)} min, ${(st.pop / st.min).toFixed(0)} people, ${(st.trips / st.min).toFixed(0)} trips a minute of ${(st.tiles / Math.max(1, st.trips)).toFixed(0)} tiles
   held back by: ${probs}
   busiest junction: ${a(j => j.far).toFixed(0)} tiles from the middle, ${(a(j => j.lorries) * 100).toFixed(0)}% lorries, ${a(j => j.goods).toFixed(1)} goods, waited ${a(j => j.wait).toFixed(0)} s; mostly ${Object.entries(tops).sort((a, b) => b[1] - a[1]).slice(0, 4).map(e => e[0]).join(', ')}`);
  });
}
