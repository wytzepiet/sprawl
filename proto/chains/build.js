// One file to publish: index.html with its scripts inlined.   node build.js
const fs = require('fs'), path = require('path');
const here = f => path.join(__dirname, f);
const html = fs.readFileSync(here('index.html'), 'utf8')
  .replace(/<script src="([^"]+)"><\/script>/g, (_, f) => `<script>\n${fs.readFileSync(here(f), 'utf8').replace(/<\/script/g, '<\\/script')}</script>`);
if (/<script src=|<link /.test(html)) throw new Error('something is still fetched');
fs.writeFileSync(here('dist.html'), html);
console.log('dist.html', (html.length / 1024).toFixed(0) + ' KB');
