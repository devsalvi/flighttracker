// Headless smoke test: demo mode, aim at the first pretend plane, expect the card to identify it.
//   npm i -D playwright   (once; downloads Chromium — or set PW_CHROMIUM to an existing binary)
//   python3 -m http.server 8765 &   then   node test/smoke.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://localhost:8765';
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const launch = process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {};
  const browser = await chromium.launch(launch);
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    geolocation: { latitude: 28.53, longitude: -81.38 }, permissions: ['geolocation'],
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`${BASE}/?demo=1`);
  await page.screenshot({ path: path.join(OUT, '1-start.png') });
  await page.click('#btn-demo');
  await page.waitForTimeout(3000);                         // desktop fallback kicks in after 2.5 s

  // demo plane DAL88 sits at az ~20°, el ~15°; drag-look starts at az 0, el 20 (0.25°/px)
  await page.mouse.move(195, 500); await page.mouse.down();
  await page.mouse.move(195 - 80, 500 - 20, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, '2-locked.png') });

  const card = await page.evaluate(() => (document.getElementById('card').hidden ? null : document.getElementById('card').innerText));
  const markers = await page.evaluate(() => [...document.querySelectorAll('.marker')].map((m) => m.innerText.trim()));
  const status = await page.textContent('#status');

  await browser.close();

  const ok = !errors.length && card && /Delta\s*88/.test(card) && /Amsterdam/.test(card) && markers.includes('DAL88');
  console.log(JSON.stringify({ ok, status, markers, card: card && card.replace(/\n+/g, ' | '), errors }, null, 2));
  process.exit(ok ? 0 : 1);
})();
