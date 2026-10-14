const { chromium } = require('playwright');
const URL = 'http://localhost:8123/index.html';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const WIDTHS = [320, 360, 375, 390, 414, 480, 600, 768, 834, 1024, 1180, 1280, 1366, 1440, 1536, 1680, 1728, 1920, 2560];

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'load' });
  await page.evaluate(() => {
    document.getElementById('tm-login').hidden = false;
    document.getElementById('tm-setup').hidden = true;
  });
  await page.waitForTimeout(500);

  console.log('width | vpCx | card.x..w (cx) | dCard | input.x..w (cx) | dInput | overflowX');
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(120);
    const r = await page.evaluate(() => {
      const rect = (sel) => {
        const el = document.querySelector(sel);
        const b = el.getBoundingClientRect();
        return { x: +b.x.toFixed(1), w: +b.width.toFixed(1), cx: +(b.x + b.width / 2).toFixed(1) };
      };
      const vp = window.innerWidth;
      const de = document.documentElement;
      return {
        vp,
        card: rect('#tm-login .login__card'),
        input: rect('#tm-login-password'),
        art: rect('#tm-login .login__art'),
        scrollW: de.scrollWidth, clientW: de.clientWidth,
      };
    });
    const dCard = +(r.card.cx - r.vp / 2).toFixed(1);
    const dInput = +(r.input.cx - r.vp / 2).toFixed(1);
    console.log(
      String(w).padStart(5),
      '|', String(r.vp / 2).padStart(6),
      '|', `${r.card.x}..${r.card.w}(${r.card.cx})`.padEnd(22),
      '|', String(dCard).padStart(5),
      '|', `${r.input.x}..${r.input.w}(${r.input.cx})`.padEnd(24),
      '|', String(dInput).padStart(5),
      '|', r.scrollW > r.clientW ? 'YES ' + r.scrollW + '>' + r.clientW : 'no'
    );
  }
  await browser.close();
})();
