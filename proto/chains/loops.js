// No loops: every building's cost and inputs can be made without it, at the
// step it opens (or the step a pick that changes it is offered), with no
// pick and under every pick alone and all together.
//   node loops.js [tree=./tree.js]
const path = require('path');
const arg = process.argv.slice(2).find(a => a.startsWith('tree='));
const tree = require(path.resolve(arg ? arg.slice(5) : path.join(__dirname, 'tree.js')));

function check(picks) {
  const kinds = JSON.parse(JSON.stringify(tree.kinds)), bad = [];
  for (const p of picks) for (const k in tree.picks[p].kinds || {}) Object.assign(kinds[k], tree.picks[p].kinds[k]);
  const floor = Math.max(0, ...picks.map(p => tree.picks[p].tier || 0));   // a pick is not offered before its step
  // what can be built and made by step `tier`, from nothing: a fixed point
  const reach = tier => {
    const built = new Set(), made = new Set();
    for (let again = true; again;) {
      again = false;
      for (const k in kinds) {
        const K = kinds[k];
        if (built.has(k) || (K.tier || 0) > tier || !Object.keys(K.cost || {}).every(g => made.has(g))) continue;
        built.add(k); again = true;
      }
      for (const k of built) {
        const K = kinds[k];
        if (!Object.keys(K.ins || {}).every(g => made.has(g))) continue;
        for (const g in { ...K.out, ...K.brings }) if (!made.has(g)) { made.add(g); again = true; }
      }
    }
    return { built, made };
  };
  const top = tree.tiers.length - 1;
  for (const k in kinds) {
    const K = kinds[k], t = Math.max(floor, K.tier || 0), r = reach(t);
    if (!r.built.has(k)) bad.push(`${k} cannot be built at step ${t}: its cost ${JSON.stringify(K.cost)} needs ${Object.keys(K.cost).filter(g => !r.made.has(g)).join(', ')}` + (reach(top).built.has(k) ? ' (made only later)' : ' (a loop)'));
    const short = Object.keys(K.ins || {}).filter(g => !r.made.has(g));
    if (short.length) bad.push(`${k} cannot run at step ${t}: ${short.join(', ')} ` + (short.every(g => reach(top).made.has(g)) ? 'made only later' : 'in a loop'));
  }
  tree.homes.forEach((L, i) => {
    const r = reach(Math.max(floor, L.tier || 0)), nx = tree.homes[i + 1];
    for (const g in L.eat) if (!r.made.has(g)) bad.push(`${L.name} eats ${g}, which cannot be made at step ${L.tier || 0}`);
    if (nx) { const r2 = reach(Math.max(floor, nx.tier || 0)); for (const g in L.grow || {}) if (!r2.made.has(g)) bad.push(`${L.name} grows with ${g}, which cannot be made at step ${nx.tier || 0}`); }
  });
  return bad;
}

const names = Object.keys(tree.picks || {});
let fail = 0;
for (const set of [[], ...names.map(n => [n]), names]) {
  const bad = check(set);
  console.log((set.length ? 'with ' + set.join(' + ') : 'no pick').padEnd(40), bad.length ? '' : 'ok');
  for (const b of bad) { console.log('   ' + b); fail++; }
}
process.exit(fail ? 1 : 0);
