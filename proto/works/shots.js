// Photographs the page after the bot's works has run a while: node shots.js [seconds]
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const b = await chromium.launch(), p = await b.newPage({ viewport: process.env.PHONE ? { width: 400, height: 780 } : { width: 1280, height: 800 } });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message)); p.on('console', m => m.type() === 'error' && errs.push(m.text()));
  await p.goto('file://' + path.join(__dirname, 'index.html'));
  await p.screenshot({ path: path.join(__dirname, '.shots-start.png') });
  await p.evaluate(secs => {
    const s = window.sim, W = Sim.W;
    const put = (k, x, y) => s.place(k, x, y);
    const x = 7, y = 9;
    for (let i = 0; i < 3; i++) put('harvester', (x + i) * 2, y * 2);
    for (let i = 0; i < 6; i++) s.place('belt', x * 2 + i, y * 2 + 2, 0);
    put('mill', x * 2 + 6, y * 2 + 2); put('oven', x * 2 + 8, y * 2 + 2); put('dock', x * 2 + 10, y * 2 + 2);
    const road = (x0, y0, x1, y1) => { let a = x0, c = y0; s.setRoad(a, c); while (a !== x1) { a += Math.sign(x1 - a); s.setRoad(a, c); } while (c !== y1) { c += Math.sign(y1 - c); s.setRoad(a, c); } };
    road(12, 11, 19, 11); road(19, 11, 19, 18); road(19, 18, 27, 18); road(27, 18, 27, 14); road(25, 14, 27, 14); road(22, 10, 22, 13); road(15, 14, 19, 14);
    s.run(secs);
  }, +process.argv[2] || 200);
  await p.waitForTimeout(1500);
  await p.screenshot({ path: path.join(__dirname, '.shots-town.png') });
  await p.mouse.wheel(0, -600); await p.waitForTimeout(600);
  await p.screenshot({ path: path.join(__dirname, '.shots-near.png') });
  console.log(errs.length ? errs : 'no errors', await p.evaluate(() => [sim.pop, sim.houses.length, sim.stats]));
  await b.close();
})();
