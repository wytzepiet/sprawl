// Photographs the page after the bot has played a while:   node shots.js [minutes] [seed]
// Builds dist.html first, so what is photographed is what is published.
const { chromium } = require('playwright');
const path = require('path');
require('./build.js');
const minutes = +process.argv[2] || 12, seed = +process.argv[3] || 7;
const out = f => path.join(__dirname, f);
(async () => {
  const b = await chromium.launch(), errs = [];
  const open = async (width, height) => {
    const p = await b.newPage({ viewport: { width, height }, deviceScaleFactor: width < 600 ? 2 : 1, hasTouch: width < 600 });
    p.on('pageerror', e => errs.push(e.message)); p.on('console', m => m.type() === 'error' && errs.push(m.text()));
    await p.goto('file://' + out('dist.html') + `?bot=clever&speed=8&seed=${seed}`);
    await p.evaluate(mins => { for (let i = 0; i < mins * 20; i++) { sim.run(3); bot.step(); } }, minutes);
    await p.waitForTimeout(1200);
    return p;
  };
  const desk = await open(1280, 800);
  await desk.screenshot({ path: out('.shots-desktop.png') });
  // the busiest part: the six by four tiles with most at work in them
  const at = await desk.evaluate(() => {
    let best = [0, 0], bn = -1;
    for (let y = 0; y < Sim.H - 4; y++) for (let x = 0; x < Sim.W - 6; x++) {
      const n = sim.parts.filter(p => p.K.time && p.x >= x && p.x < x + 6 && p.y >= y && p.y < y + 4).length;
      if (n > bn) { bn = n; best = [x + 3, y + 2]; }
    }
    cam.x = best[0]; cam.y = best[1]; cam.s = 96;
    const p = sim.parts.filter(p => p.K.time && !p.site && p.fleet.length).sort((a, b) => Math.hypot(a.x - cam.x, a.y - cam.y) - Math.hypot(b.x - cam.x, b.y - cam.y))[0];
    if (p) look(p.x + 0.5, p.y + 0.5);
    return best;
  });
  await desk.waitForTimeout(1500);
  await desk.screenshot({ path: out('.shots-near.png') });
  await desk.evaluate(() => { cam.x = Sim.W / 2; cam.y = Sim.H / 2; cam.s = 1280 / Sim.W; look(-1, -1); });
  await desk.waitForTimeout(600);
  await desk.screenshot({ path: out('.shots-wide.png') });
  const phone = await open(390, 800);
  await phone.screenshot({ path: out('.shots-phone.png') });
  console.log(errs.length ? errs : 'no page errors', 'busiest at', at, await desk.evaluate(() => ({ minutes: Math.round(sim.time / 60), pop: sim.pop, homes: sim.houses.length, parts: sim.parts.length, tier: sim.tier })));
  await b.close();
})();
