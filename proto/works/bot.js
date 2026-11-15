// A bot that lays a bakery by the meadow, a woodcutter by the forest and
// roads between them and the town, then watches: node bot.js [minutes] [seed]
const Sim = require('./sim.js');
const mins = +process.argv[2] || 10, s = new Sim(+process.argv[3] || 7);
const { W, H, SW, SH, MEADOW } = Sim;
const town = [22, 14];
// the nearest half-grid spot where every piece of a layout fits
function spot(pieces, far = 0) {
  let best = null, bd = 1e9;
  for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
    const d = Math.abs(x / 2 - town[0]) + Math.abs(y / 2 - town[1]);
    if (d < far || d >= bd) continue;
    if (pieces.every(([k, dx, dy]) => !s.why(k, x + dx, y + dy))) { bd = d; best = [x, y]; }
  }
  return best;
}
function lay(pieces, far) {
  const at = spot(pieces, far);
  if (!at) { console.log('no room for', pieces[0][0]); process.exit(1); }
  for (const [k, dx, dy, dir] of pieces) s.place(k, at[0] + dx, at[1] + dy, dir || 0);
  return at;
}
// a road over free land from beside a dock to the nearest road
function join(dock) {
  const starts = [];
  for (const t of s.tilesOf(dock)) for (const [dx, dy] of Sim.DIRS) { const x = t % W + dx, y = ((t / W) | 0) + dy; if (s.canRoad(x, y)) starts.push(y * W + x); }
  const from = new Map(starts.map(t => [t, -1])), q = [...starts];
  for (let i = 0; i < q.length; i++) {
    const t = q[i], x = t % W, y = (t / W) | 0;
    for (const [dx, dy] of Sim.DIRS) {
      const nx = x + dx, ny = y + dy, n = ny * W + nx;
      if (!s.inside(nx, ny) || from.has(n)) continue;
      if (s.road[n]) { for (let c = t; c >= 0; c = from.get(c)) s.setRoad(c % W, (c / W) | 0); return true; }
      if (s.canRoad(nx, ny)) { from.set(n, t); q.push(n); }
    }
  }
  return false;
}
// three harvesters over a belt to the mill, the oven and its dock
const a = lay([['harvester', 0, 0], ['harvester', 2, 0], ['harvester', 4, 0], ['belt', 0, 2], ['belt', 1, 2], ['belt', 2, 2], ['belt', 3, 2], ['belt', 4, 2], ['belt', 5, 2], ['mill', 6, 2], ['oven', 8, 2], ['dock', 10, 2]], 8);
const b = lay([['woodcutter', 0, 0], ['dock', 2, 0]], 5);
for (const d of s.parts.filter(p => p.kind === 'dock')) if (!join(d)) console.log('no road to dock');
for (let m = 1; m <= mins; m++) {
  s.run(60);
  if (s.offer) s.pick(0);
  const moving = s.vehicles.filter(v => v.on).length, hungry = s.houses.filter(h => h.hungry).length;
  console.log(`${m} min: ${s.pop} people, ${s.houses.length} houses (${hungry} hungry), ${moving} on the road, sold ${s.stats.sold}, hauled ${s.stats.hauled}, ghost ticks ${s.stats.ghosts}, docks ${s.parts.filter(p => p.kind === 'dock').map(d => JSON.stringify(d.pile)).join(' ')}`);
}
