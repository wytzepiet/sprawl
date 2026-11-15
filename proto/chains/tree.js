// What is made of what, and what homes want. Amounts are crates; a lorry
// carries `tune.load` of them. Rates worth knowing sit beside each line.
(function (root) {

const goods = {
  log:    { name: 'Logs',      col: '#8a5a33' },
  plank:  { name: 'Planks',    col: '#e8b96a' },
  grain:  { name: 'Grain',     col: '#e6c53f' },
  bread:  { name: 'Bread',     col: '#d8813a' },
  fish:   { name: 'Fish',      col: '#4c95d6' },
  clay:   { name: 'Clay',      col: '#c98a6b' },
  brick:  { name: 'Bricks',    col: '#b5503c' },
  coal:   { name: 'Coal',      col: '#3a3d42' },
  ore:    { name: 'Ore',       col: '#9c6f8e' },
  iron:   { name: 'Iron',      col: '#aab4c0' },
  chair:  { name: 'Furniture', col: '#2fa39a' },
  cement: { name: 'Cement',    col: '#c9ccd0' },
  oil:    { name: 'Oil',       col: '#5b4a6e' },
  fuel:   { name: 'Fuel',      col: '#e9552f' },
};

// Every works has a heavy input and a light one, three to one. It stands
// where the biggest pile is: at its heavy input, touching the makers, and
// its lorry fetches the light one; or, when it makes more crates than it
// takes (bread), touching the shop. A lorry leaves only for a full load,
// so crates a minute over `tune.load` is trips a minute: `node table.js`
// prints each block and checks it against the sim, `node loops.js` that
// nothing needs itself. Blocks do not all come out even: two woodcutters
// leave a sawmill 6 logs a minute over, which is the fuel of three
// bakeries; three clay pits feed two kilns; a coal mine fires a smelter
// and a half.
const kinds = {
  woodcutter: { name: 'Woodcutter', near: 'forest', out: { log: 1 }, time: 4 },                                   // 15 logs
  sawmill:    { name: 'Sawmill',    ins: { log: 3 }, out: { plank: 1 }, time: 7.5 },                               // 24 logs in, 8 planks out: 2 woodcutters, and 6 logs to spare
  farm:       { name: 'Farm',       near: 'field', out: { grain: 1 }, time: 5, cost: { plank: 2 } },               // 12 grain
  bakery:     { name: 'Bakery',     ins: { grain: 3, log: 1 }, out: { bread: 9 }, time: 30, cost: { plank: 3 }, quiet: true }, // 6 grain + 2 logs in, 18 bread out, a shop's worth: 1 farm to 2
  shop:       { name: 'Shop',       shop: true, cost: { plank: 3 } },
  builder:    { name: 'Builder',    builder: true, cost: { plank: 2 } },
  garage:     { name: 'Garage',     garage: true, cost: { plank: 3 }, loud: true },
  fishery:    { name: 'Fishery',    near: 'water', out: { fish: 1 }, time: 5, cost: { plank: 3 }, tier: 1 },       // 12 fish
  claypit:    { name: 'Clay pit',   near: 'clay', out: { clay: 1 }, time: 4, cost: { plank: 3 }, tier: 2 },        // 15 clay
  kiln:       { name: 'Kiln',       ins: { clay: 3, log: 1 }, out: { brick: 2 }, time: 8, cost: { plank: 4 }, tier: 2 },    // 22 clay + 7 logs in, 15 bricks out: 3 pits to 2
  coalmine:   { name: 'Coal mine',  near: 'coal', out: { coal: 1 }, time: 4, cost: { plank: 5 }, tier: 2 },        // 15 coal
  oremine:    { name: 'Ore mine',   near: 'ore', out: { ore: 1 }, time: 4, cost: { plank: 5 }, tier: 3 },          // 15 ore
  smelter:    { name: 'Smelter',    ins: { ore: 3, coal: 1 }, out: { iron: 1 }, time: 6, cost: { brick: 6 }, tier: 3 },     // 30 ore + 10 coal in, 10 iron out: 2 mines
  workshop:   { name: 'Workshop',   ins: { plank: 3, iron: 1 }, out: { chair: 2 }, time: 15, cost: { brick: 4, plank: 2 }, tier: 3 },  // 12 planks + 4 iron in, 8 furniture out: 3 sawmills to 2
  cementworks:{ name: 'Cement works', ins: { clay: 3, coal: 1 }, out: { cement: 2 }, time: 6, cost: { brick: 6, iron: 2 }, tier: 4 }, // 30 clay + 10 coal in, 20 cement out: 2 pits
  // the ship takes what the town has to spare and leaves oil: a little always, and a crate more for each it took
  harbour:    { name: 'Harbour',    near: 'water', harbour: true, lorries: 2, cost: { brick: 8, plank: 4 }, brings: { oil: 6 }, trade: 1, tier: 4, loud: true },
  oilrig:     { name: 'Oil rig',    near: 'oil', out: { oil: 1 }, time: 4, cost: { iron: 4, brick: 2 }, tier: 4 },                  // 15 oil
  refinery:   { name: 'Refinery',   ins: { oil: 3 }, out: { fuel: 2 }, time: 8, cost: { brick: 6, iron: 4 }, tier: 4 },             // 22 oil in, 15 fuel out
  // great works: they take what they need for good and are done
  townhall:   { name: 'Town hall',  need: { brick: 120, plank: 80, cement: 100 }, lorries: 4, tier: 4, gives: { offer: true } },
  lighthouse: { name: 'Lighthouse', near: 'water', need: { brick: 240, iron: 120, cement: 240 }, lorries: 4, tier: 4, gives: { tune: { ship: '*0.5' } } },
};

// what a home eats is crates a minute; what it grows with is brought once
const homes = [
  { name: 'Cottage',    people: 2,  eat: { bread: 0.4 }, grow: { plank: 2 } },
  { name: 'House',      people: 4,  eat: { bread: 0.5, fish: 0.3 }, grow: { brick: 3 }, tier: 1 },
  { name: 'Townhouse',  people: 7,  eat: { bread: 0.6, fish: 0.4, coal: 0.2 }, grow: { brick: 4 }, tier: 2 },
  { name: 'Apartments', people: 12, eat: { bread: 0.7, fish: 0.5, coal: 0.3, chair: 0.15 }, tier: 3 },
];

const Tree = {
  goods, kinds, homes,
  // a step opens when this many homes have reached a level
  tiers: [{ pop: 0 }, { level: 0, homes: 24 }, { level: 1, homes: 12 }, { level: 2, homes: 8 }, { level: 3, homes: 6 }],
  // ground, how far from home, how big, and which side (-1 west, 1 east)
  land: [['field', 8, 2.6], ['forest', 9, 3], ['water', 10, 2.2], ['clay', 14, 2.2], ['forest', 16, 3.2], ['field', 16, 2.8], ['ore', 22, 2.3, -1], ['coal', 22, 2.3, 1], ['oil', 20, 2]],
  start: { parts: [['shop', 0, -1], ['builder', 2, 1]], homes: [[-2, -1], [3, -1], [-1, 1], [-3, 1]], stock: { plank: 12 } },
  boost: { good: 'fuel', cycles: 40, speed: 2, keep: 6 },   // a crate of fuel runs a works 40 batches at double speed; it keeps a lorry load
  exports: ['chair', 'cement'],
  tune: { load: 6, grow: 20, pantry: 100, quay: 36 },
  pickAt: [12, 40, 100, 220],
  picks: {
    load:  { name: 'Bigger lorries', say: 'A lorry carries half as much again.', tune: { load: 9 } },
    fast:  { name: 'Faster lorries', say: 'Lorries drive a quarter faster.', tune: { lorrySpeed: '*1.25' } },
    fleet: { name: 'Town fleet',     say: 'Every shop and builder gets a second lorry.' },
    shelf: { name: 'Bigger shops',   say: 'A shop holds twice as much.', tune: { shelf: '*2' } },
    coal:  { name: 'Coal firing',    say: 'Kilns burn coal and leave the logs.', tier: 2, kinds: { kiln: { ins: { clay: 3, coal: 1 } } } },
  },
};

if (typeof module !== 'undefined') module.exports = Tree; else root.Tree = Tree;
})(this);
