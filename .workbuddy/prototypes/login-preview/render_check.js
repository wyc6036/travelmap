const { chromium } = require('playwright');
const URL = 'http://localhost:8123/index.html';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = '/Users/wyc/Documents/da_Project/Docker/travelmap/.workbuddy/prototypes/login-preview';

const VIEWPORTS = [
  { name: 'userwin', w: 1920, h: 916 },    // ← 用户窗口（截图对应）
  { name: 'desktop', w: 1920, h: 1080 },
  { name: 'shortwin', w: 1512, h: 700 },
  { name: 'laptop',  w: 1440, h: 900 },
  { name: 'tablet',  w: 768,  h: 1024 },
  { name: 'mobile',  w: 390,  h: 844 },
];

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'load' });
    await page.evaluate(() => {
      document.getElementById('tm-login').hidden = false;
      document.getElementById('tm-setup').hidden = true;
    });
    await page.waitForTimeout(900);
    const d = await page.evaluate(() => {
      const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect();
        return { x:+b.x.toFixed(1), y:+b.y.toFixed(1), w:+b.width.toFixed(1), h:+b.height.toFixed(1), cx:+(b.x+b.width/2).toFixed(1), cy:+(b.y+b.height/2).toFixed(1), by:+(b.y+b.height).toFixed(1) }; };
      const vp = { w: innerWidth, h: innerHeight };
      const card = r('#tm-login .login__card'), img = r('#tm-login .login__art img');
      // 整组（卡片顶 → 插画底）的垂直中心
      const groupTop = Math.min(card.y, img.y), groupBottom = Math.max(card.by, img.by);
      return {
        vp,
        card, img,
        imgPctW: +(img.w / vp.w * 100).toFixed(1),
        imgPctH: +(img.h / vp.h * 100).toFixed(1),
        groupCenterY: +((groupTop + groupBottom) / 2).toFixed(1),
        vpCenterY: vp.h / 2,
        groupBias: +(((groupTop + groupBottom) / 2) - vp.h / 2).toFixed(1),
        imgBottomGap: +(vp.h - img.by).toFixed(1),
        overflowY: document.documentElement.scrollHeight > vp.h,
        imgBoxFit: getComputedStyle(document.querySelector('#tm-login .login__art img')).objectFit,
      };
    });
    console.log(`=== ${vp.name} ${vp.w}x${vp.h} ===`);
    console.log(JSON.stringify(d));
    await page.screenshot({ path: `${OUT}/fix_${vp.name}.png` });
    await ctx.close();
  }
  await browser.close();
})();
