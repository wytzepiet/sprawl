// How things look: the grounds, a body and a small drawing for each kind,
// and the homes' sizes. Everything is found from the data: a kind this has
// never heard of takes its colour from the good it makes and a drawing
// from what it is (beside some ground, a maker, or neither).
(function (root) {

const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
const mix = (a, b, k) => { const A = hex(a), B = hex(b); return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * k).toString(16).padStart(2, '0')).join(''); };
const lum = c => { const [r, g, b] = hex(c); return (r * 0.3 + g * 0.59 + b * 0.11) / 255; };
const EDGE = 'rgba(40,30,20,.55)';

function rr(c, x, y, w, h, r, fill, stroke) {
  c.beginPath(); c.roundRect(x, y, w, h, r);
  if (fill) { c.fillStyle = fill; c.fill(); }
  if (stroke) { c.strokeStyle = stroke; c.stroke(); }
}
function disc(c, x, y, r, fill, stroke) {
  c.beginPath(); c.arc(x, y, r, 0, 7);
  if (fill) { c.fillStyle = fill; c.fill(); }
  if (stroke) { c.strokeStyle = stroke; c.stroke(); }
}

// ---- the grounds -------------------------------------------------------
// col, the ground; rim, a band round it; deco, what is scattered on a tile
// (g the context, px py the tile's corner, T its size, r a random number).

const GROUNDS = {
  grass: { col: '#a8d27a', deco(g, px, py, T, r) {
    if (r() > 0.16) return;
    const a = px + T * (0.2 + r() * 0.6), b = py + T * (0.3 + r() * 0.5);
    g.strokeStyle = '#96c56a'; g.lineWidth = T * 0.05; g.beginPath();
    g.moveTo(a, b); g.lineTo(a - T * 0.06, b - T * 0.14); g.moveTo(a + T * 0.08, b); g.lineTo(a + T * 0.12, b - T * 0.12); g.stroke();
  } },
  field: { col: '#e6dc8e', grow: 2, deco(g, px, py, T, r) {
    g.strokeStyle = '#d0c165'; g.lineWidth = T * 0.05; g.beginPath();
    for (let i = 0; i < 4; i++) { const a = px + T * (0.14 + i * 0.25), b = py + T * (0.18 + r() * 0.2); g.moveTo(a, b); g.lineTo(a, b + T * 0.44); }
    g.stroke();
  } },
  forest: { col: '#8fc26c', grow: 3, deco(g, px, py, T, r) {
    for (let i = 0; i < 3; i++) {
      const a = px + T * (0.2 + r() * 0.6), b = py + T * (0.2 + r() * 0.6), q = T * (0.19 + r() * 0.12);
      disc(g, a, b, q, '#5c9e58'); disc(g, a - q * 0.25, b - q * 0.25, q * 0.6, '#6fb166');
    }
  } },
  water: { col: '#7fc4e4', rim: '#e8dfae', grow: 0, rimGrow: 5, deco(g, px, py, T, r) {
    if (r() > 0.5) return;
    const a = px + T * (0.2 + r() * 0.3), b = py + T * (0.25 + r() * 0.5);
    g.strokeStyle = '#a8daf0'; g.lineWidth = T * 0.05; g.beginPath(); g.moveTo(a, b); g.lineTo(a + T * 0.3, b); g.stroke();
  } },
  clay: { col: '#dba88b', rim: '#c98f73', grow: 1, rimGrow: 3, deco(g, px, py, T, r) {
    g.strokeStyle = '#bd8163'; g.lineWidth = T * 0.045; g.beginPath();
    const a = px + T * (0.2 + r() * 0.3), b = py + T * (0.2 + r() * 0.3);
    g.moveTo(a, b); g.lineTo(a + T * 0.18, b + T * 0.12); g.lineTo(a + T * 0.14, b + T * 0.34); g.moveTo(a + T * 0.18, b + T * 0.12); g.lineTo(a + T * 0.4, b + T * 0.1);
    g.stroke();
  } },
  ore: { col: '#bfb3c2', rim: '#a99bad', grow: 1, rimGrow: 3, deco(g, px, py, T, r) {
    for (let i = 0; i < 2; i++) {
      const a = px + T * (0.25 + r() * 0.5), b = py + T * (0.25 + r() * 0.5), q = T * (0.1 + r() * 0.07);
      g.fillStyle = '#8d6a86'; g.beginPath(); g.moveTo(a - q, b + q * 0.6); g.lineTo(a - q * 0.3, b - q); g.lineTo(a + q, b - q * 0.3); g.lineTo(a + q * 0.7, b + q * 0.8); g.fill();
      g.fillStyle = '#c9a8c4'; g.beginPath(); g.moveTo(a - q * 0.3, b - q); g.lineTo(a + q, b - q * 0.3); g.lineTo(a, b - q * 0.1); g.fill();
    }
  } },
  coal: { col: '#9a9c9e', rim: '#84878a', grow: 1, rimGrow: 3, deco(g, px, py, T, r) {
    for (let i = 0; i < 3; i++) {
      const a = px + T * (0.2 + r() * 0.6), b = py + T * (0.2 + r() * 0.6), q = T * (0.07 + r() * 0.07);
      rr(g, a - q, b - q, q * 2, q * 1.7, q * 0.5, '#2e3035'); rr(g, a - q * 0.6, b - q * 0.7, q * 0.7, q * 0.4, q * 0.2, '#5d6168');
    }
  } },
  oil: { col: '#c2ba94', rim: '#aaa27c', grow: 1, rimGrow: 3, deco(g, px, py, T, r) {
    if (r() > 0.75) return;
    const a = px + T * (0.35 + r() * 0.3), b = py + T * (0.35 + r() * 0.3), q = T * (0.16 + r() * 0.1);
    g.fillStyle = '#1d1f22'; g.beginPath(); g.ellipse(a, b, q, q * 0.65, r() * 3, 0, 7); g.fill();
    g.strokeStyle = '#8a7fd0'; g.lineWidth = T * 0.035; g.beginPath(); g.arc(a, b, q * 0.5, 3.6, 5); g.stroke();
  } },
};
function ground(name) {
  if (GROUNDS[name]) return GROUNDS[name];
  let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return GROUNDS[name] = { col: `hsl(${h} 30% 68%)`, grow: 1, deco() {} };
}

// the whole land, once, onto a canvas T pixels a tile
function land(g, sim, T) {
  const { W, H, GROUND } = sim.constructor;
  let s = 12345; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const at = (x, y) => GROUND[sim.inside(x, y) ? sim.terrain[y * W + x] : 0];
  const blob = (k, col, grow) => {
    g.fillStyle = col; g.beginPath();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (at(x, y) === k) {
      // a corner is round only where the ground ends on both its sides
      const n = at(x, y - 1) === k, e = at(x + 1, y) === k, s = at(x, y + 1) === k, w = at(x - 1, y) === k, c = (p, q) => p || q ? 0 : T * 0.28;
      g.roundRect(x * T - grow, y * T - grow, T + grow * 2, T + grow * 2, [c(n, w), c(n, e), c(s, e), c(s, w)]);
    }
    g.fill();
  };
  g.fillStyle = ground(GROUND[0]).col; g.fillRect(0, 0, W * T, H * T);
  const px = T / 32;
  for (const k of GROUND.slice(1)) { const G = ground(k); if (G.rim) blob(k, G.rim, (G.rimGrow || 3) * px); }
  for (const k of GROUND.slice(1)) blob(k, ground(k).col, (ground(k).grow || 0) * px);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) ground(at(x, y)).deco(g, x * T, y * T, T, r);
}

// ---- small drawings, about the middle of a tile ------------------------
// o: t the clock, busy whether it works, letter the kind's first letter

const GLYPHS = {
  axe(c, o) {
    rr(c, -0.2, 0.1, 0.4, 0.14, 0.06, '#6e4a2b', EDGE);
    c.translate(0.12, 0.12); c.rotate(-1.1 + (o.busy ? Math.abs(Math.sin(o.t * 4)) * 0.9 : 0.5));
    rr(c, -0.03, -0.42, 0.06, 0.44, 0.03, '#f1e3c8', EDGE);
    c.fillStyle = '#e4e6e8'; c.beginPath(); c.moveTo(0.02, -0.44); c.lineTo(-0.2, -0.47); c.quadraticCurveTo(-0.25, -0.36, -0.2, -0.25); c.lineTo(0.02, -0.3); c.closePath(); c.fill(); c.strokeStyle = EDGE; c.stroke();
  },
  saw(c, o) {
    c.rotate(o.busy ? o.t * 6 : 0.3);
    c.fillStyle = '#e4e6e8'; c.beginPath();
    for (let i = 0; i < 12; i++) { const a = i / 12 * 6.283, q = i % 2 ? 0.19 : 0.28; c.lineTo(Math.cos(a) * q, Math.sin(a) * q); }
    c.closePath(); c.fill(); c.strokeStyle = EDGE; c.stroke();
    disc(c, 0, 0, 0.06, '#6e5a43');
  },
  rows(c, o) {
    const s = o.busy ? Math.sin(o.t * 4) * 0.03 : 0;
    for (let i = -1; i <= 1; i++) rr(c, -0.3, i * 0.17 - 0.045 + s * i, 0.6, 0.09, 0.04, i ? '#8f7420' : '#a8892a');
  },
  oven(c, o) {
    c.beginPath(); c.moveTo(-0.27, 0.24); c.lineTo(-0.27, -0.04); c.arc(0, -0.04, 0.27, Math.PI, 0); c.lineTo(0.27, 0.24); c.closePath();
    c.fillStyle = '#8d3f2c'; c.fill(); c.strokeStyle = EDGE; c.stroke();
    const glow = o.busy ? 0.6 + 0.4 * Math.sin(o.t * 6) : 0.1;
    c.beginPath(); c.moveTo(-0.14, 0.24); c.lineTo(-0.14, 0.06); c.arc(0, 0.06, 0.14, Math.PI, 0); c.lineTo(0.14, 0.24); c.closePath();
    c.fillStyle = `rgba(${90 + glow * 165 | 0},${50 + glow * 150 | 0},40,1)`; c.fill();
  },
  fish(c, o) {
    c.rotate(Math.sin(o.t * 2) * 0.12);
    c.fillStyle = '#f2f1ec'; c.beginPath(); c.ellipse(-0.04, 0, 0.23, 0.13, 0, 0, 7); c.fill(); c.strokeStyle = EDGE; c.stroke();
    c.beginPath(); c.moveTo(0.16, 0); c.lineTo(0.31, -0.13); c.lineTo(0.31, 0.13); c.closePath(); c.fill(); c.stroke();
    disc(c, -0.15, -0.03, 0.03, '#1b1d20');
  },
  pit(c, o) {
    c.fillStyle = 'rgba(40,30,20,.35)'; c.beginPath(); c.ellipse(0, 0.04, 0.3, 0.2, 0, 0, 7); c.fill();
    c.fillStyle = 'rgba(40,30,20,.45)'; c.beginPath(); c.ellipse(0.02, 0.07, 0.19, 0.12, 0, 0, 7); c.fill();
    c.rotate(-0.7 + (o.busy ? Math.sin(o.t * 5) * 0.25 : 0));
    rr(c, -0.025, -0.34, 0.05, 0.36, 0.02, '#f1e3c8', EDGE); rr(c, -0.08, -0.02, 0.16, 0.15, 0.04, '#e4e6e8', EDGE);
  },
  dome(c, o) {
    rr(c, 0.09, -0.34, 0.1, 0.2, 0.03, '#7a3526', EDGE);
    c.beginPath(); c.moveTo(-0.28, 0.24); c.quadraticCurveTo(-0.28, -0.3, 0, -0.3); c.quadraticCurveTo(0.28, -0.3, 0.28, 0.24); c.closePath();
    c.fillStyle = '#a5503a'; c.fill(); c.strokeStyle = EDGE; c.stroke();
    const glow = o.busy ? 0.6 + 0.4 * Math.sin(o.t * 5) : 0.1;
    disc(c, 0, 0.1, 0.09, `rgba(${90 + glow * 165 | 0},${50 + glow * 150 | 0},40,1)`);
  },
  frame(c, o) {
    c.strokeStyle = '#2b2d31'; c.lineWidth = 0.06; c.lineCap = 'round'; c.beginPath();
    c.moveTo(-0.24, 0.26); c.lineTo(0, -0.18); c.lineTo(0.24, 0.26); c.moveTo(-0.13, 0.08); c.lineTo(0.13, 0.08); c.stroke();
    c.translate(0, -0.2); c.rotate(o.busy ? o.t * 4 : 0);
    disc(c, 0, 0, 0.11, '#e4e6e8', '#2b2d31');
    c.lineWidth = 0.03; c.beginPath(); c.moveTo(-0.11, 0); c.lineTo(0.11, 0); c.moveTo(0, -0.11); c.lineTo(0, 0.11); c.stroke();
  },
  pour(c, o) {
    const glow = o.busy ? 0.7 + 0.3 * Math.sin(o.t * 6) : 0.15;
    c.fillStyle = '#3c4046'; c.beginPath(); c.moveTo(-0.26, -0.2); c.lineTo(0.26, -0.2); c.lineTo(0.17, 0.2); c.lineTo(-0.17, 0.2); c.closePath(); c.fill(); c.strokeStyle = EDGE; c.stroke();
    rr(c, -0.2, -0.17, 0.4, 0.11, 0.04, `rgba(255,${120 + glow * 90 | 0},50,${0.3 + glow * 0.7})`);
    if (o.busy) rr(c, -0.03, 0.2, 0.06, 0.1 + 0.03 * Math.sin(o.t * 9), 0.02, '#ffb04a');
  },
  hammer(c, o) {
    rr(c, -0.26, 0.1, 0.52, 0.14, 0.04, '#3c4046', EDGE);
    c.translate(0.16, 0.1); c.rotate(-1.2 + (o.busy ? Math.abs(Math.sin(o.t * 5)) * 0.8 : 0.4));
    rr(c, -0.025, -0.36, 0.05, 0.36, 0.02, '#f1e3c8', EDGE); rr(c, -0.12, -0.44, 0.2, 0.12, 0.03, '#8b9097', EDGE);
  },
  chair(c, o) {
    const s = o.busy ? Math.sin(o.t * 5) * 0.06 : 0;
    c.rotate(s);
    c.strokeStyle = '#f2f1ec'; c.lineWidth = 0.075; c.lineCap = 'round'; c.lineJoin = 'round'; c.beginPath();
    c.moveTo(-0.15, -0.28); c.lineTo(-0.15, 0.26); c.moveTo(-0.15, 0.02); c.lineTo(0.17, 0.02); c.lineTo(0.17, 0.26); c.moveTo(-0.15, -0.14); c.lineTo(-0.02, -0.14);
    c.stroke();
  },
  drum(c, o) {
    c.rotate(-0.25);
    rr(c, -0.3, -0.15, 0.6, 0.3, 0.12, '#8b9097', EDGE);
    c.save(); c.beginPath(); c.roundRect(-0.3, -0.15, 0.6, 0.3, 0.12); c.clip();
    c.strokeStyle = '#e4e6e8'; c.lineWidth = 0.05; c.beginPath();
    const off = o.busy ? (o.t * 0.5) % 0.2 : 0.05;
    for (let i = -3; i < 4; i++) { const a = i * 0.2 + off; c.moveTo(a - 0.06, -0.17); c.lineTo(a + 0.06, 0.17); }
    c.stroke(); c.restore();
  },
  gear(c, o) {
    c.save(); c.rotate(o.busy ? o.t * 2 : 0);
    c.fillStyle = '#e4e6e8'; c.beginPath();
    for (let i = 0; i < 16; i++) { const a = i / 16 * 6.283 + ((i >> 1) % 2 ? 0 : 0), q = (i >> 1) % 2 ? 0.2 : 0.28; c.lineTo(Math.cos(a) * q, Math.sin(a) * q); }
    c.closePath(); c.fill(); c.strokeStyle = EDGE; c.stroke(); c.restore();
    c.fillStyle = '#3c4046'; c.font = '700 0.26px ui-rounded, system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(o.letter, 0, 0.02);
  },
};

// what this page knows by name; anything else is found from what it is
const KINDS = {
  woodcutter: { glyph: 'axe' }, sawmill: { glyph: 'saw' }, farm: { glyph: 'rows' }, bakery: { glyph: 'oven' },
  fishery: { glyph: 'fish' }, claypit: { glyph: 'pit' }, kiln: { glyph: 'dome' }, coalmine: { glyph: 'frame' }, oremine: { glyph: 'frame' },
  smelter: { glyph: 'pour', body: '#8f9aa8' }, toolworks: { glyph: 'hammer', body: '#d6d2c6' }, workshop: { glyph: 'chair' }, cementworks: { glyph: 'drum', body: '#c1c4c8' },
};
const NEAR = { forest: 'axe', field: 'rows', water: 'fish', clay: 'pit' };

const seen = {};
function kind(name, K, goods) {
  if (seen[name]) return seen[name];
  const over = KINDS[name] || {};
  const out = Object.keys(K.out || {})[0] || Object.keys(K.brings || {})[0];
  const body = over.body || (K.shop ? '#e2604a' : K.builder ? '#e9c24a' : K.harbour ? '#4f7fa8' : K.garage ? '#5b616b' : out && goods[out] ? goods[out].col : '#c9ccd0');
  const glyph = GLYPHS[over.glyph || (K.near && !K.ins ? NEAR[K.near] || 'frame' : 'gear')];
  return seen[name] = { body, dark: lum(body) < 0.45, glyph, letter: (K.name || name)[0].toUpperCase() };
}

// ---- homes: each level a little larger and its own roof ----------------

const ROOFS = ['#e0745a', '#e0a13e', '#d25f6f', '#8e6bc4', '#4f86c6', '#3fa58f'];
function home(level, levels) {
  const f = levels > 1 ? level / (levels - 1) : 0;
  return { size: 0.54 + 0.34 * f, roof: ROOFS[level % ROOFS.length], floors: level };
}

const Look = { ground, land, kind, home, rr, disc, mix, lum, EDGE };
if (typeof module !== 'undefined') module.exports = Look; else root.Look = Look;
})(this);
