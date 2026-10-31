// The bot's brain, shared by bot.js (node) and shots.js (in the page).
(function (root) {
root.makeBot = function (s, S, log) {
const { xy, at, cheb, STEPS4, STEPS8, KINDS, W, H } = S;
// cheapest road from any start tile to any goal tile, over the land as it is
function roadPath(starts, isGoal) {
  const cost = new Map(), prev = new Map(), open = [];
  for (const i of starts) { cost.set(i, 0); open.push([0, i]); }
  while (open.length) {
    let bi = 0;
    for (let k = 1; k < open.length; k++) if (open[k][0] < open[bi][0]) bi = k;
    const [c, n] = open[bi]; open[bi] = open[open.length - 1]; open.pop();
    if (c > cost.get(n)) continue;
    if (isGoal(n)) { const p = [n]; let m = n; while (prev.has(m)) { m = prev.get(m); p.push(m); } return p.reverse(); }
    const [x, y] = xy(n);
    for (const [dx, dy] of STEPS8) {
      const m = at(x + dx, y + dy);
      if (m < 0 || !s.roadable(m)) continue;
      if (dx && dy && s.adj.get(at(x, y + dy))?.has(at(x + dx, y))) continue;
      const step = (dx && dy ? 1.45 : 1) * (s.adj.has(m) ? 0.3 : s.terrain[m] === S.WATER ? 5 : 1);
      if (c + step < (cost.get(m) ?? Infinity)) { cost.set(m, c + step); prev.set(m, n); open.push([c + step, m]); }
    }
  }
  return null;
}
function frontTiles(b) {
  const [x, y] = xy(b.tile);
  return STEPS4.map(([dx, dy]) => at(x + dx, y + dy)).filter(i => i >= 0 && s.roadable(i));
}
function connect(b) {
  const starts = frontTiles(b);
  if (!starts.length) return false;
  const others = [...s.buildings.values()].filter(o => o !== b);
  const goal = s.adj.size ? (i => s.adj.has(i)) : (i => others.some(o => frontTiles(o).includes(i)));
  const p = roadPath(starts, goal);
  if (!p) return false;
  let spent = 0;
  if (p.length === 1) { // a lone tile: road it to a neighbour that leads nowhere else yet
    return false;
  }
  for (let k = 0; k < p.length - 1; k++) { const c = s.addRoad(p[k], p[k + 1]); if (c < 0) return false; spent += c; }
  return true;
}
function bestSpot(kind, near) {
  let best = -1, bd = Infinity;
  for (let i = 0; i < W * H; i++) {
    if (!s.canPlace(kind, i)) continue;
    const d = near.reduce((a, t) => a + Math.hypot(xy(t)[0] - xy(i)[0], xy(t)[1] - xy(i)[1]), 0) / near.length;
    // keep the loud ones off the houses
    const loudPenalty = KINDS[kind].loud ? [...s.buildings.values()].filter(h => h.house && cheb(h.tile, i) <= 2).length * 4 : 0;
    const byRoad = STEPS4.some(([dx, dy]) => s.adj.has(at(xy(i)[0] + dx, xy(i)[1] + dy))) ? -1 : 0;
    if (d + loudPenalty + byRoad < bd) { bd = d + loudPenalty + byRoad; best = i; }
  }
  return best;
}


return function think() {
  if (s.offer) {
    // take the building whose good is most behind, else trucks, else road
    const o = s.offer;
    let k = o.findIndex(x => x.type === 'roads' && s.roads < 8);
    if (k < 0) k = o.findIndex(x => x.type === 'kind' && (x.kind === 'shop' ? [...s.buildings.values()].some(h => h.house && h.shop == null) : s.backlog(KINDS[x.kind].out) >= 2));
    if (k < 0) k = o.findIndex(x => x.type === 'truck');
    if (k < 0) k = 0;
    log('PICK', JSON.stringify(o[k]));
    s.pick(k);
  }
  for (const b of [...s.buildings.values()]) if (b.idle === 'cleared') { s.removeBuilding(b.id); log('MOVE woodcutter (bare)'); }
  for (const b of s.buildings.values()) if (b.door < 0) connect(b);
  // a shop among the houses that have none within reach
  if (s.tokens.shop) {
    const lonely = [...s.buildings.values()].filter(h => h.house && h.door >= 0 && h.shop == null);
    if (lonely.length) { const i = bestSpot('shop', lonely.map(h => h.tile)); if (i >= 0 && s.place('shop', i)) log('PLACE shop', xy(i)); }
  }
  for (const kind of s.unlocked) {
    if (kind === 'shop') continue;
    const good = KINDS[kind].out;
    const pins = s.pins.filter(p => p.good === good);
    const mine = [...s.buildings.values()].filter(b => b.kind === kind);
    if (!pins.length) continue;
    const backlog = pins.filter(p => p.by < 0 && s.time - p.born > 12).length;
    if (s.tokens[kind] && (!mine.length || backlog >= 2)) {
      const i = bestSpot(kind, pins.map(p => s.B(p.at).tile));
      if (i >= 0 && s.place(kind, i)) log('PLACE', kind, xy(i), 'roads', s.roads);
      continue;
    }
    if (backlog >= 2 && s.tokens.truck) {
      const b = mine.sort((a, c) => a.trucks.length - c.trucks.length)[0];
      if (b && s.addTruck(b)) log('TRUCK', kind, b.trucks.length);
    }
  }
  if (s.jamAt !== undefined && s.isJunction(s.jamAt) && !s.roundabouts.has(s.jamAt)) {
    if (s.addRoundabout(s.jamAt)) log('ROUNDABOUT', xy(s.jamAt));
  }
};
};
})(typeof window !== 'undefined' ? window : globalThis);
