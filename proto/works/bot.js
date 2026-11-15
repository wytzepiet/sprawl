// A bot that lays one bread works by a meadow and a road to town, then
// watches: node bot.js [minutes] [seed]
const Sim = require('./sim.js');
const mins = +process.argv[2] || 10, s = new Sim(+process.argv[3] || 7);
const { W, H, MEADOW } = Sim;
// a meadow tile with meadow to its right, nearest the town
let best = null, bd = 1e9;
for (let y = 1; y < H - 3; y++) for (let x = 1; x < W - 6; x++) {
  let ok = true;
  for (let i = 0; i < 3; i++) ok = ok && s.terrain[y * W + x + i] === MEADOW;
  for (let i = 0; i < 6; i++) ok = ok && s.terrain[(y + 1) * W + x + i] <= MEADOW && s.terrain[(y + 2) * W + x + i] <= MEADOW;
  const d = Math.abs(x - 22) + Math.abs(y - 14);
  if (ok && d > 9 && x < 20 && d < bd) { bd = d; best = [x, y]; }
}
const [mx, my] = best;
const put = (k, x, y) => { if (!s.place(k, x, y)) console.log('refused', k, x, y, s.why(k, x, y)); };
const works = (x, y) => {   // three harvesters in a row, a belt under them to mill, oven, dock
  for (let i = 0; i < 3; i++) put('harvester', (x + i) * 2, y * 2);
  for (let i = 0; i < 6; i++) s.place('belt', x * 2 + i, y * 2 + 2, 0);
  put('mill', x * 2 + 6, y * 2 + 2); put('oven', x * 2 + 8, y * 2 + 2); put('dock', x * 2 + 10, y * 2 + 2);
};
works(mx, my);
// a road from the dock's side to the town's street
const road = (x0, y0, x1, y1) => { let x = x0, y = y0; s.setRoad(x, y); while (x !== x1) { x += Math.sign(x1 - x); s.setRoad(x, y); } while (y !== y1) { y += Math.sign(y1 - y); s.setRoad(x, y); } };
road(mx + 6, my + 1, 19, my + 1); road(19, my + 1, 19, 14);
road(19, 14, 19, 18); road(19, 18, 27, 18); road(25, 14, 27, 14); road(27, 14, 27, 18); road(22, 10, 22, 13); road(15, 14, 19, 14);
for (let m = 1; m <= mins; m++) {
  s.run(60);
  if (s.offer) { console.log('  pick', s.offer.join(' '), '→', s.offer[0]); s.pick(0); }
  const moving = s.vehicles.filter(v => v.on).length, hungry = s.houses.filter(h => h.hungry).length;
  const shop = s.parts.find(p => p.kind === 'shop'), dock = s.parts.find(p => p.kind === 'dock');
  console.log(`${m} min: ${s.pop} people, ${s.houses.length} houses (${hungry} hungry), ${moving} on the road, sold ${s.stats.sold}, hauled ${s.stats.hauled}, ghost ticks ${s.stats.ghosts}, shop ${JSON.stringify(shop.pile)}, dock ${JSON.stringify(dock.pile)}`);
}
