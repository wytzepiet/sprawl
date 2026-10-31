// Replays .replay.json in the page and photographs where it ends.
const { chromium } = require('playwright');
const path = require('path'), fs = require('fs');
(async () => {
  const log = JSON.parse(fs.readFileSync(path.join(__dirname, '.replay.json'), 'utf8'));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  page.on('pageerror', e => console.log('PAGE ERROR', e.message));
  await page.goto('file://' + path.join(__dirname, 'index.html') + '?auto');
  await page.evaluate(log => {
    document.querySelector('#speed button[data-s="0"]').click();
    const S = window.SprawlRouted, s = window.sim, T = t => S.at(...t.split(',').map(Number)), R = n => s.routes[+n];
    for (const c of log) {
      const [op, ...a] = c.trim().split(/\s+/);
      if (op === 'route') s.newRoute(T(a[0]), T(a[1]));
      else if (op === 'extend') s.extend(R(a[0]), +a[1], T(a[2]));
      else if (op === 'truck') s.addTruck(R(a[0]), false, a[1] === 'big');
      else if (op === 'trim') s.trim(R(a[0]), +a[1]);
      else if (op === 'remove') s.removeRoute(R(a[0]));
      else if (op === 'depot') s.placeDepot(T(a[0]));
      else if (op === 'pick') s.pick(+a[0]);
      else if (op === 'run') { const u = s.time + +a[0]; while (s.time < u - 1e-9 && !s.offer) s.step(1 / 30); }
    }
    s.events.length = 0;
  }, log);
  await page.waitForTimeout(700);
  await page.screenshot({ path: process.argv[2] });
  console.log('shot', process.argv[2]);
  await browser.close();
})();
