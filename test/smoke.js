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

  const readCard = () => page.evaluate(() => (document.getElementById('card').hidden ? null : document.getElementById('card').innerText));
  const card = await readCard();
  const markers = await page.evaluate(() => [...document.querySelectorAll('.marker')].map((m) => m.innerText.trim()));
  const status = await page.textContent('#status');
  const dragOk = !errors.length && card && /Delta\s*88/.test(card) && /Amsterdam/.test(card) && markers.includes('DAL88');

  // Scenario 2: phone sensors (iOS style: relative alpha + webkitCompassHeading). Point the phone at DAL88's
  // elevation (beta = 90 + el) but with a compass that reads 30° too high: the app locks the wrong plane (SWA1234,
  // 12° off). Tap the plane at screen centre (where it "really" is) -> tap-to-calibrate must shift the heading
  // by -30 and lock DAL88.
  const orient = (heading, beta) => page.evaluate(([heading, beta]) => {
    const e = new Event('deviceorientation');
    Object.assign(e, { alpha: 123, beta, gamma: 0, absolute: false, webkitCompassHeading: heading });
    window.dispatchEvent(e);
  }, [heading, beta]);
  await page.reload();
  await page.click('#btn-demo');
  await page.waitForTimeout(300);
  for (let i = 0; i < 20; i++) { await orient(20 + 30, 90 + 14.7); await page.waitForTimeout(30); }
  const before = { status: await page.textContent('#status'), card: await readCard() };
  await page.evaluate(() => {
    const ov = document.getElementById('overlay');
    ov.dispatchEvent(new PointerEvent('pointerdown', { clientX: ov.clientWidth / 2, clientY: ov.clientHeight / 2, bubbles: true }));
  });
  for (let i = 0; i < 20; i++) { await orient(20 + 30, 90 + 14.7); await page.waitForTimeout(30); }
  await page.screenshot({ path: path.join(OUT, '3-sensor-calibrated.png') });
  const after = { status: await page.textContent('#status'), card: await readCard(), offset: await page.textContent('#v-offset') };
  const sensorOk = !errors.length && /NE 15°/.test(before.status) && !/Delta/.test(before.card || '') && /N 15°/.test(after.status)
    && after.card && /Delta\s*88/.test(after.card) && after.offset === '-30°';

  await browser.close();

  const ok = dragOk && sensorOk;
  console.log(JSON.stringify({ ok, dragOk, sensorOk, status, markers, card: card && card.replace(/\n+/g, ' | '),
    sensor: { before: { ...before, card: before.card && before.card.split('\n')[0] }, after: { ...after, card: after.card && after.card.split('\n')[0] } }, errors }, null, 2));
  process.exit(ok ? 0 : 1);
})();
