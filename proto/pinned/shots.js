// Photograph the prototype as the bot plays it: node shots.js [out dir] [minutes...]
// Canvas 2D, so headless Chromium draws it at full speed.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const out = process.argv[2] || path.join(__dirname, '.shots');
const marks = (process.argv.slice(3).length ? process.argv.slice(3) : ['0', '0.5', '2', '4', '7', '11']).map(Number);
const size = process.env.SIZE ? process.env.SIZE.split('x').map(Number) : [1280, 800];
fs.mkdirSync(out, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 2 });
  page.on('pageerror', e => console.log('PAGE ERROR', e.message));
  page.on('console', m => { if (m.type() === 'error') console.log('console', m.text()); });
  const url = 'file://' + path.join(__dirname, 'index.html') + '?auto' + (process.env.SEED ? '&seed=' + process.env.SEED : '');
  await page.goto(url);
  await page.addScriptTag({ path: path.join(__dirname, 'brain.js') });
  await page.evaluate(() => {
    window.botThink = window.makeBot(window.sim, window.SprawlPinned, () => {});
    document.querySelector('#speed button[data-s="0"]').click();
  });
  for (const m of marks) {
    await page.evaluate(async (until) => {
      const s = window.sim;
      let k = 0;
      while (s.time < until * 60) { s.step(1 / 30); if (++k % 15 === 0 && !window.noBot) window.botThink(); }
    }, m);
    await page.waitForTimeout(700);
    const f = path.join(out, `t${String(m).replace('.', '_')}.png`);
    await page.screenshot({ path: f });
    console.log('shot', f, await page.evaluate(() => `people ${sim.people()} coins ${sim.coins}`));
  }
  await browser.close();
})();
