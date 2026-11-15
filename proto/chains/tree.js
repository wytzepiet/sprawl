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
  tool:   { name: 'Tools',     col: '#f2f1ec' },
  chair:  { name: 'Furniture', col: '#2fa39a' },
  cement: { name: 'Cement',    col: '#c9ccd0' },
};

const kinds = {
  woodcutter: { name: 'Woodcutter', near: 'forest', out: { log: 1 }, time: 5 },                                  // 12 logs a minute
  sawmill:    { name: 'Sawmill',    ins: { log: 2 }, out: { plank: 1 }, time: 5 },                                // 24 logs in, 12 planks out
  farm:       { name: 'Farm',       near: 'field', out: { grain: 1 }, time: 5, cost: { plank: 2 } },              // 12 grain
  bakery:     { name: 'Bakery',     ins: { grain: 2, log: 1 }, out: { bread: 4 }, time: 10, cost: { plank: 3 }, quiet: true }, // 12 grain + 6 logs in, 24 bread out
  shop:       { name: 'Shop',       shop: true, cost: { plank: 3 } },
  builder:    { name: 'Builder',    builder: true, cost: { plank: 2 } },
  garage:     { name: 'Garage',     garage: true, cost: { plank: 3 }, loud: true },
  fishery:    { name: 'Fishery',    near: 'water', out: { fish: 1 }, time: 5, cost: { plank: 3 }, tier: 1 },
  claypit:    { name: 'Clay pit',   near: 'clay', out: { clay: 1 }, time: 4, cost: { plank: 3 }, tier: 1 },       // 15 clay
  kiln:       { name: 'Kiln',       ins: { clay: 3, log: 1 }, out: { brick: 2 }, time: 8, cost: { plank: 4 }, tier: 1 },   // 22 clay + 7 logs in, 15 bricks out
  coalmine:   { name: 'Coal mine',  near: 'coal', out: { coal: 1 }, time: 4, cost: { plank: 5 }, tier: 2 },
  oremine:    { name: 'Ore mine',   near: 'ore', out: { ore: 1 }, time: 4, cost: { plank: 5 }, tier: 2 },
  smelter:    { name: 'Smelter',    ins: { ore: 2, coal: 1 }, out: { iron: 1 }, time: 6, cost: { brick: 6 }, tier: 2 },    // 20 ore + 10 coal in, 10 iron out
  toolworks:  { name: 'Toolworks',  ins: { iron: 1, plank: 1 }, out: { tool: 2 }, time: 8, cost: { brick: 4, plank: 2 }, tier: 2 },
  workshop:   { name: 'Workshop',   ins: { plank: 2, iron: 1 }, out: { chair: 2 }, time: 10, cost: { brick: 4, plank: 2 }, tier: 2 },
  cementworks:{ name: 'Cement works', ins: { clay: 2, coal: 1 }, out: { cement: 2 }, time: 6, cost: { brick: 6, iron: 2 }, tier: 3 },
  harbour:    { name: 'Harbour',    near: 'water', harbour: true, lorries: 2, cost: { brick: 8, iron: 4 }, tier: 3, loud: true },
};

// what a home eats is crates a minute; what it grows with is brought once
const homes = [
  { name: 'Cottage',    people: 2,  eat: { bread: 0.5 }, grow: { plank: 2 } },
  { name: 'House',      people: 4,  eat: { bread: 0.6, fish: 0.4 }, grow: { brick: 4, plank: 2 }, tier: 1 },
  { name: 'Townhouse',  people: 7,  eat: { bread: 0.8, fish: 0.6, chair: 0.2 }, grow: { cement: 4, iron: 2 }, tier: 2 },
  { name: 'Apartments', people: 12, eat: { bread: 1.2, fish: 0.8, chair: 0.4 }, tier: 3 },
];

const Tree = {
  goods, kinds, homes,
  // a step opens when this many homes have reached a level
  tiers: [{ pop: 0 }, { level: 0, homes: 10 }, { level: 1, homes: 10 }, { level: 2, homes: 10 }],
  // ground, how far from home, how big, and which side (-1 west, 1 east)
  land: [['field', 8, 2.6], ['forest', 9, 3], ['water', 10, 2.2], ['clay', 14, 2.2], ['forest', 16, 3.2], ['field', 16, 2.8], ['ore', 22, 2.3, -1], ['coal', 22, 2.3, 1]],
  start: { parts: [['shop', 0, -1], ['builder', 2, 1]], homes: [[-2, -1], [3, -1], [-1, 1], [-3, 1]], stock: { plank: 12 } },
  boost: { good: 'tool', cycles: 24, speed: 2 },
  exports: ['chair', 'tool', 'cement'],
  tune: { load: 6 },
  pickAt: [12, 40, 100, 220],
  picks: {
    load:  { name: 'Bigger lorries', say: 'A lorry carries half as much again.', tune: { load: 9 } },
    fast:  { name: 'Faster lorries', say: 'Lorries drive a quarter faster.', tune: { lorrySpeed: '*1.25' } },
    fleet: { name: 'Town fleet',     say: 'Every shop and builder gets a second lorry.' },
    shelf: { name: 'Bigger shops',   say: 'A shop holds twice as much.', tune: { shelf: '*2' } },
    coal:  { name: 'Coal firing',    say: 'Bakeries and kilns burn coal and leave the logs.', tier: 2, kinds: { bakery: { ins: { grain: 2, coal: 1 } }, kiln: { ins: { clay: 3, coal: 1 } } } },
  },
};

if (typeof module !== 'undefined') module.exports = Tree; else root.Tree = Tree;
})(this);
