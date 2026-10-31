// Replays .replay.json in the page and photographs the end state.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
(async () => {
  const out = process.argv[2];
  const log = JSON.parse(fs.readFileSync(path.join(__dirname, '.replay.json'), 'utf8'));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  page.on('pageerror', e => console.log('PAGE ERROR', e.message));
  await page.goto('file://' + path.join(__dirname, 'index.html') + '?auto');
  await page.evaluate((log) => {
    document.querySelector('#speed button[data-s="0"]').click();
    const S = window.SprawlPinned, s = window.sim, { xy, at } = S;
    const T = t => at(...t.split(',').map(Number));
    const line8 = (a, b) => { const o = []; let [x, y] = xy(a); const [tx, ty] = xy(b); while (x !== tx || y !== ty) { x += Math.sign(tx - x); y += Math.sign(ty - y); o.push(at(x, y)); } return o; };
    for (const c of log) {
      const [op, ...a] = c.trim().split(/\s+/);
      if (op === 'road') for (let k = 0; k < a.length - 1; k++) { let p = T(a[k]); for (const j of line8(p, T(a[k + 1]))) { s.addRoad(p, j); p = j; } }
      else if (op === 'place') s.place(a[0], T(a[1]));
      else if (op === 'truck') s.addTruck(s.B(s.tileB.get(T(a[0]))));
      else if (op === 'round') s.addRoundabout(T(a[0]));
      else if (op === 'erase') s.removeRoadTile(T(a[0]));
      else if (op === 'remove') s.removeBuilding(s.tileB.get(T(a[0])));
      else if (op === 'pick') s.pick(+a[0]);
      else if (op === 'run') { const u = s.time + +a[0]; while (s.time < u - 1e-9 && !s.offer) s.step(1 / 30); }
    }
  }, log);
  await page.waitForTimeout(600);
  await page.screenshot({ path: out });
  console.log('shot', out);
  await browser.close();
})();
