// A tree's scorecard: several seeds, both players.
//   node measure.js [minutes] [seeds] [tree=./tree.js] [key=value …]   (keys are sim.js TUNE names)
const path = require('path');
const { run, junctions } = require('./bot.js');
const [mins = 30, seeds = 4, ...rest] = process.argv.slice(2);
const opts = Object.fromEntries(rest.map(kv => { const [k, v] = kv.split('='); return [k, isNaN(+v) ? (v === 'true' ? true : v === 'false' ? false : v) : +v]; }));
const tree = require(path.resolve(opts.tree || path.join(__dirname, 'tree.js'))); delete opts.tree;
const verbose = opts.v; delete opts.v;
const only = opts.only; delete opts.only;   // only=naive runs the one player
const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
const pct = x => (x * 100).toFixed(0) + '%';
const card = {};
for (const mode of only ? [only] : ['naive', 'clever']) {
  const all = [];
  for (let seed = 1; seed <= +seeds; seed++) {
    const { s, bot, rows, tierAt } = run({ minutes: +mins, seed, mode, tree, opts });
    const st = s.stats, js = junctions(s, 5);
    const probs = {}; for (const r of rows) { const k = r.problem.split(':')[0]; probs[k] = (probs[k] || 0) + 1 / rows.length; }
    const at = m => rows[Math.min(m, rows.length) - 1].pop;
    const lastHomes = rows[rows.length - 1].homes, nh = h => Math.max(1, h.reduce((a, b) => a + b, 0));
    const tail = rows.slice(-5);
    const r = { seed, pop10: at(10), pop20: at(20), pop: s.pop, tiers: tierAt, homes: lastHomes, parts: s.parts.length, perHome: s.parts.length / nh(lastHomes), acts: bot.log.length / +mins,
      trips: tail.reduce((n, r) => n + r.trips, 0) / tail.length, len: sum(st.tiles) / sum(st.trips) / 2, haul: sum(st.tiles) / sum(st.made), touch: sum(st.touch) / (sum(st.touch) + sum(st.trips) * s.T.load),
      wait: (st.waitCar + st.waitLorry) / (st.driveCar + st.driveLorry), hungry: rows.reduce((n, r) => n + r.hungry / nh(r.homes), 0) / rows.length,
      jl: js.reduce((n, j) => n + j.lorries, 0) / Math.max(1, js.reduce((n, j) => n + j.total, 0)), jg: js.reduce((n, j) => n + j.goods, 0) / Math.max(1, js.length), probs, shipped: sum(st.shipped) };
    all.push(r);
    if (verbose) console.log(`${mode} seed ${seed}: pop ${r.pop10}/${r.pop20}/${r.pop} tiers ${r.tiers.join('/')} homes ${r.homes.join('/')} parts ${r.parts} hungry ${pct(r.hungry)} wait ${pct(r.wait)} ` + JSON.stringify(Object.fromEntries(Object.entries(probs).map(([k, v]) => [k, +v.toFixed(2)]))));
  }
  const avg = f => all.reduce((n, r) => n + f(r), 0) / all.length;
  const top = Math.max(...all.map(r => r.tiers.length));
  const probs = {}; for (const r of all) for (const k in r.probs) probs[k] = (probs[k] || 0) + r.probs[k] / all.length;
  card[mode] = { avg, all };
  console.log(`${mode.toUpperCase()}
  people at 10 / 20 / ${mins} min:  ${avg(r => r.pop10).toFixed(0)} / ${avg(r => r.pop20).toFixed(0)} / ${avg(r => r.pop).toFixed(0)}   (worst seed ${Math.min(...all.map(r => r.pop))})
  steps opened at minute:       ${Array.from({ length: top }, (_, i) => { const got = all.filter(r => r.tiers[i] != null); return `${(got.reduce((n, r) => n + r.tiers[i], 0) / got.length).toFixed(0)}${got.length < all.length ? ` (${got.length}/${all.length} seeds)` : ''}`; }).join(', ')}
  homes by level at the end:    ${all[0].homes.map((_, i) => avg(r => r.homes[i]).toFixed(0)).join(' / ')}
  hungry homes, mean share:     ${pct(avg(r => r.hungry))}     standing in traffic: ${pct(avg(r => r.wait))}
  buildings per home:           ${avg(r => r.perHome).toFixed(2)}    the bot's moves a minute: ${avg(r => r.acts).toFixed(1)}
  lorry trips a minute (end):   ${avg(r => r.trips).toFixed(0)}, ${avg(r => r.len).toFixed(1)} tiles each way; ${avg(r => r.haul).toFixed(1)} lorry tiles per crate made; ${pct(avg(r => r.touch))} of crates passed by touch
  five busiest junctions:       ${pct(avg(r => r.jl))} lorries, ${avg(r => r.jg).toFixed(1)} goods crossing each
  what was wrong, share of time: ${Object.entries(probs).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k === '-' ? 'nothing' : k} ${pct(v)}`).join(', ')}
  shipped: ${avg(r => r.shipped).toFixed(0)}`);
}
const c = !only && card.clever.avg, n = !only && card.naive.avg;
if (!only) console.log(`CLEVER AGAINST NAIVE: people x${(c(r => r.pop) / n(r => r.pop)).toFixed(2)}, lorry tiles per crate x${(c(r => r.haul) / n(r => r.haul)).toFixed(2)}`);
