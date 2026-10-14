const { chromium } = require('playwright');

const URL = 'http://localhost:8123/index.html';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const VIEWPORTS = [
  { name: 'desktop', width: 1920, height: 1080 },
  { name: 'laptop',  width: 1440, height: 900 },
  { name: 'mobile',  width: 390,  height: 844 },
];

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'load' });
    // force-show the login overlay, hide the setup wizard
    await page.evaluate(() => {
      const login = document.getElementById('tm-login');
      const setup = document.getElementById('tm-setup');
      if (login) login.hidden = false;
      if (setup) setup.hidden = true;
    });
    await page.waitForTimeout(900); // let animations settle

    const data = await page.evaluate(() => {
      const pick = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          sel,
          x: +r.x.toFixed(1), y: +r.y.toFixed(1),
          w: +r.width.toFixed(1), h: +r.height.toFixed(1),
          cx: +(r.x + r.width / 2).toFixed(1),
          cy: +(r.y + r.height / 2).toFixed(1),
          alignSelf: cs.alignSelf,
          marginLeft: cs.marginLeft, marginRight: cs.marginRight,
          width: cs.width, boxSizing: cs.boxSizing,
          justifyContent: cs.justifyContent,
        };
      };
      const vpCenterX = window.innerWidth / 2;
      const out = {
        viewport: { w: window.innerWidth, h: window.innerHeight, centerX: vpCenterX },
        overlay: pick('#tm-login'),
        card: pick('#tm-login .login__card'),
        form: pick('#tm-login-form'),
        input: pick('#tm-login-password'),
        btn: pick('#tm-login .login__btn'),
        art: pick('#tm-login .login__art'),
        img: pick('#tm-login .login__art img'),
      };
      // deltas vs viewport center
      const d = (o) => o ? +(o.cx - vpCenterX).toFixed(1) : null;
      out.delta = {
        card: d(out.card), form: d(out.form), input: d(out.input),
        btn: d(out.btn), art: d(out.art), img: d(out.img),
      };
      return out;
    });

    console.log('=== ' + vp.name + ' (' + vp.width + 'x' + vp.height + ') ===');
    console.log(JSON.stringify(data, null, 2));

    await page.screenshot({ path: `/Users/wyc/Documents/da_Project/Docker/travelmap/.workbuddy/prototypes/login-preview/measure_${vp.name}.png` });
    await ctx.close();
  }
  await browser.close();
})();
