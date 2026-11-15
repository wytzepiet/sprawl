// The ratio table, and a check that the sim does what it says.
//   node table.js [tree=./tree.js]
// For each made good: the block that balances, crates a minute in and out,
// and the lorry trips a minute the block causes with its heavy input
// touching and with nothing touching (every source ten tiles off). Each
// row is then built by hand on an empty map and run; `ok` means the sim's
// rates are within a tenth of the table's.
const path = require('path');
const Sim = require('./sim.js');
const { W, GR } = Sim;
const arg = process.argv.slice(2).find(a => a.startsWith('tree='));
const tree = require(path.resolve(arg ? arg.slice(5) : path.join(__dirname, 'tree.js')));
const bare = Object.assign(JSON.parse(JSON.stringify(tree)), { land: [], start: { parts: [], homes: [], stock: {} }, pickAt: [], boost: null });
const FAR = 10, MIN = 10, Y = 10, X = 20;

const per = (K, io, g) => K[io][g] / K.time * 60;
const maker = g => Object.keys(tree.kinds).find(k => (tree.kinds[k].out || {})[g]);
const frac = x => { for (const d of [1, 2, 3]) if (Math.abs(x * d - Math.round(x * d)) < 0.02) return [Math.round(x * d), d]; return [x.toFixed(2), 1]; };

// a town of one works: the heavy input's makers against it or down the road, the light one's down the road
function run(kind, touching) {
  const s = new Sim(1, bare, {}), K = s.kinds[kind];
  s.tier = 9;
  for (let x = X - FAR - 2; x <= X + FAR + 2; x++) s.setRoad(x, Y);
  const stand = (k, x, y, up) => {   // a maker, its ground painted behind it
    if (s.kinds[k].near) s.terrain[(y + up) * W + x] = GR[s.kinds[k].near];
    return s.place(k, x, y, true);
  };
  const b = s.place(kind, X, Y - 1, true), stocks = [];
  const ins = Object.keys(K.ins).sort((p, q) => K.ins[q] - K.ins[p]), heavy = ins[0];
  ins.forEach((g, i) => {
    const mk = maker(g), M = s.kinds[mk], raw = !M.ins, n = raw ? Math.ceil(per(K, 'ins', g) / per(M, 'out', g) - 0.02) : 1;
    if (g === heavy && touching) {
      const spots = [[X - 1, Y - 1, -1], [X + 1, Y - 1, -1], [X, Y - 2, -1]];
      for (let j = 0; j < n; j++) { const m = stand(mk, ...spots[j]); if (!raw) stocks.push([m, g]); }
    } else {
      const x = i === 0 ? X - FAR : X + FAR;   // down the road, a yard that never runs out
      stocks.push([stand(mk, x, Y - 1, -1), g]);
      if (g === 'log' || raw) stocks.push([stand(mk, x, Y + 1, 1), g]);
    }
  });
  const out = Object.keys(K.out)[0];
  let busy = 0, n = 0, base = null;
  for (let t = 0; t < (MIN + 2) * 60; t++) {
    for (const [m, g] of stocks) m.made[g] = 1000;
    b.made[out] = 0;   // someone takes what it makes
    s.run(1);
    if (t === 119) base = JSON.parse(JSON.stringify(s.stats));
    if (t >= 120) { n++; if (b.prog > 0) busy++; }
  }
  const d = k => g => ((s.stats[k][g] || 0) - (base[k][g] || 0)) / MIN;
  return { busy: busy / n, made: d('made')(out), used: Object.fromEntries(ins.map(g => [g, d('used')(g)])), trips: ins.reduce((a, g) => a + d('trips')(g), 0), touch: ins.reduce((a, g) => a + d('touch')(g), 0) };
}

const T = Object.assign({}, Sim.TUNE, tree.tune);
const trip = d => 2 * d / T.lorrySpeed + T.loadTime + T.dropTime + 0.25;
console.log(`a lorry carries ${T.load}; a trip of ${FAR} tiles takes about ${trip(FAR).toFixed(1)} s, so one lorry brings ${(60 / trip(FAR) * T.load).toFixed(0)} crates a minute from there\n`);
console.log('good    works        block                                   in a minute            out   trips touching  trips apart  rate apart | sim: out  trips  rate | out  trips  rate');
let bad = 0;
for (const kind in tree.kinds) {
  const K = tree.kinds[kind];
  if (!K.ins || !K.out) continue;
  const ins = Object.keys(K.ins).sort((p, q) => K.ins[q] - K.ins[p]), heavy = ins[0], out = Object.keys(K.out)[0];
  const M = tree.kinds[maker(heavy)], need = per(K, 'ins', heavy), each = per(M, 'out', heavy), [a, c] = frac(need / each);
  const whole = Math.ceil(need / each - 0.02);   // when it does not come out even, the next whole number, and what is left over
  const block = c > 1 || a === whole ? `${a} ${maker(heavy)} to ${c} ${kind}` : `${whole} ${maker(heavy)} to 1 ${kind}, ${(whole * each - need).toFixed(0)} ${heavy} over`;
  const all = ins.reduce((n, g) => n + per(K, 'ins', g), 0), light = all - per(K, 'ins', heavy);
  const tTouch = light / T.load, tApart = all / T.load, rApart = Math.min(1, 60 / (tApart * trip(FAR)));
  const A = run(kind, true), B = run(kind, false);
  const near = (x, y) => Math.abs(x - y) <= Math.max(0.1 * y, 0.15);
  const ok = near(A.made, per(K, 'out', out)) && near(A.trips, tTouch) && ins.every(g => near(A.used[g], per(K, 'ins', g))) && near(B.trips, tApart * rApart) && near(B.busy, rApart);
  if (!ok) bad++;
  console.log(out.padEnd(7), kind.padEnd(12), block.padEnd(39), ins.map(g => `${per(K, 'ins', g).toFixed(1)} ${g}`).join(' + ').padEnd(22), per(K, 'out', out).toFixed(1).padStart(5), tTouch.toFixed(2).padStart(10), tApart.toFixed(2).padStart(14), (rApart * 100).toFixed(0).padStart(10) + '%',
    '|', A.made.toFixed(1).padStart(8), A.trips.toFixed(2).padStart(6), (A.busy * 100).toFixed(0).padStart(4) + '%', '|', B.made.toFixed(1).padStart(4), B.trips.toFixed(2).padStart(6), (B.busy * 100).toFixed(0).padStart(4) + '%', ok ? ' ok' : ' DIFFERS');
}
console.log(bad ? `\n${bad} rows differ from the sim` : '\nevery row is what the sim does');
process.exit(bad ? 1 : 0);
