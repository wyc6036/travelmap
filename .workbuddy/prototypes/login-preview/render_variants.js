const { chromium } = require('playwright');
const URL = 'http://localhost:8123/index.html';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = '/Users/wyc/Documents/da_Project/Docker/travelmap/.workbuddy/prototypes/login-preview';

// Mobile variants: inject a <style> override after load and screenshot.
const VARIANTS = {
  A_contain_center:
    `#tm-login .login__art{flex:0 0 auto;align-items:center;}
     #tm-login .login__art img{width:100%;height:auto;object-fit:contain;}`,
  B_cover_fill:
    `#tm-login .login__art{flex:1 1 auto;align-items:flex-end;}
     #tm-login .login__art img{width:100%;height:100%;object-fit:cover;object-position:center 55%;}`,
  C_cover_short:
    `#tm-login .login__art{flex:0 0 auto;align-items:flex-end;}
     #tm-login .login__art img{width:100%;height:auto;aspect-ratio:4/3;object-fit:cover;object-position:center 58%;}`,
  D_contain_bottom:
    `#tm-login .login__art{flex:1 1 auto;align-items:flex-end;}
     #tm-login .login__art img{width:100%;height:auto;object-fit:contain;}`,
};

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  for (const [name, css] of Object.entries(VARIANTS)) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'load' });
    await page.evaluate(() => {
      document.getElementById('tm-login').hidden = false;
      document.getElementById('tm-setup').hidden = true;
    });
    await page.addStyleTag({ content: css });
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${OUT}/variant_mobile_${name}.png` });
    console.log('rendered', name);
    await ctx.close();
  }
  await browser.close();
})();
