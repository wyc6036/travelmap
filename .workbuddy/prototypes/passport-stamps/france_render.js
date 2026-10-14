const { chromium } = require('/Users/wyc/.workbuddy/binaries/node/workspace/node_modules/playwright');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  for (const on of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 320, height: 320 }, deviceScaleFactor: 2 });
    await page.goto('file:///tmp/fr_' + on + '.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    const el = await page.$('svg');
    await el.screenshot({ path: `/tmp/fr_${on}.png` });
    await page.close();
  }
  console.log('DONE');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
