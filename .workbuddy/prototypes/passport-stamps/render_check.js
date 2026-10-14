const { chromium } = require('/Users/wyc/.workbuddy/binaries/node/workspace/node_modules/playwright');
const fs = require('fs');

const FILE = 'file:///Users/wyc/Documents/da_Project/Docker/travelmap/.workbuddy/prototypes/passport-stamps/postmarks.html';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--force-color-profile=srgb'],
  });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(FILE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  // bbox of each stamp
  const stamps = await page.$$eval('.stamp', els => els.map((el, i) => {
    const r = el.getBoundingClientRect();
    return { i, x: r.x, y: r.y, w: r.width, h: r.height };
  }));
  console.log('STAMPS=' + JSON.stringify(stamps));

  // text bbox via getBBox on each .nm text
  const texts = await page.$$eval('.stamp', els => els.map((el) => {
    const svg = el.querySelector('svg');
    const ts = [...svg.querySelectorAll('text.nm')];
    return ts.map(t => { const b = t.getBBox(); return { x: +b.x.toFixed(2), y: +b.y.toFixed(2), w: +b.width.toFixed(2), h: +b.height.toFixed(2) }; });
  }));
  console.log('TEXTS=' + JSON.stringify(texts));

  // full page screenshot
  await page.screenshot({ path: '/tmp/pm_full.png', fullPage: true });

  // per-stamp screenshots
  const dir = '/tmp/pm_stamps';
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < stamps.length; i++) {
    const el = (await page.$$('.stamp'))[i];
    await el.screenshot({ path: `${dir}/s${i}.png` });
  }
  console.log('DONE');
  await browser.close();
})().catch(e => { console.error('ERR', e); process.exit(1); });
