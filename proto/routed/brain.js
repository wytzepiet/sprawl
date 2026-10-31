// A player who runs a street from each maker to whoever waits for its good,
// as directly as the hand allows.
(function (root) {
root.makeBot = function (s, S, log = () => {}) {
  const { KINDS, MAKER, LEVELS, dist } = S;
  const shares = (a, b) => s.routes.some(r => r.on && r.on.has(a.id) && r.on.has(b.id));
  let failed = 0;
  // the nearest tile beside a place that a route could end on
  function join(a, b) {
    if (shares(a, b)) return true;
    // extend the route whose end is nearest to b, from a route serving a
    let best = null, bd = Infinity;
    for (const r of s.routes) {
      if (!r.on || !r.on.has(a.id)) continue;
      for (const end of [0, 1]) { const d = dist(r.stops[end ? r.stops.length - 1 : 0], b.tile); if (d < bd) { bd = d; best = [r, end]; } }
    }
    if (best && s.extend(best[0], best[1], b.tile)) { log('extend', best[0].col, b.kind || 'house'); return true; }
    if (s.hand.route > 0) { const r = s.newRoute(a.tile, b.tile); if (r) { log('new route', r.col, a.kind || 'house', '->', b.kind || 'house'); return true; } }
    failed++;
    return false;
  }
  return function think() {
    if (s.offer) {
      const pref = failed > 3 ? ['route', 'bridge', 'truck', 'big', 'depot'] : ['truck', 'big', 'route', 'bridge', 'depot'];
      const k = pref.map(p => s.offer.indexOf(p)).find(i => i >= 0);
      log('pick', s.offer[k]); s.pick(k); failed = 0; return;
    }
    if (s.dirty) s.reachAll();
    const places = [...s.places.values()];
    const need = [];
    for (const h of places.filter(p => p.house && !p.vacant)) for (const g of LEVELS[h.level].wants) if (h.wants[g].since >= 0) need.push([h, g]);
    for (const p of places.filter(p => p.kind && KINDS[p.kind].needs)) need.push([p, KINDS[p.kind].needs]);
    for (const [p, g] of need) {
      const makers = places.filter(m => m.kind === MAKER[g]);
      if (makers.some(m => shares(m, p))) continue;
      makers.sort((a, b) => dist(a.tile, p.tile) - dist(b.tile, p.tile));
      if (makers[0]) { join(makers[0], p); s.reachAll(); }
    }
    while (s.hand.truck > 0 || s.hand.big > 0) {
      let best = null, bs = -1;
      for (const r of s.routes) {
        const n = s.trucks.filter(t => t.route === r).length;
        let w = 0;
        for (const id of r.on.keys()) { const p = s.P(id); if (p && p.house) w += Object.values(p.wants).filter(w => w.since >= 0).length; }
        const sc = (w + 1) * r.path.length / n;
        if (sc > bs) { bs = sc; best = r; }
      }
      if (!best || !s.addTruck(best, false, s.hand.big > 0)) break;
      log('truck on', best.col);
    }
  };
};
})(typeof window !== 'undefined' ? window : globalThis);
