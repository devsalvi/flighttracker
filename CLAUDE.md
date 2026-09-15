# What's That Plane? — project guide for Claude Code

Kid-friendly AR flight tracker: point the phone at a plane, see which flight it is. Pet project, not a
business. Owner: Dev (devsalvi). Test user: his son.

## What exists (v0, working)

Static PWA, **no build step, no framework, no backend**. Everything the browser needs is six files:

| file | role |
|---|---|
| `index.html` | start screen + AR screen markup, settings sheet |
| `app.js` | the whole app in one IIFE (~600 lines) — sections are marked with `// ----- name` comments |
| `style.css` | dark, big-type, kid-friendly styling; markers, edge arrows, card |
| `manifest.webmanifest`, `icon.svg`, `icon-*.png` | PWA/home-screen bits |

Deploy plumbing: `infra/deploy.sh` (Amplify manual deployment — zip upload, no build minutes),
`infra/custom-headers.yml`, `infra/deploy-policy.json` (least-privilege IAM), `.github/workflows/deploy.yml`
(runs the script on push to `main`; needs `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` repo secrets).

## How app.js works (read this before touching it)

Pipeline per animation frame: **sensors → camera basis → per-aircraft ENU direction → project → pick lock → DOM**.

- **Sensors**: `onOrient` normalises `deviceorientation`/`deviceorientationabsolute`; on iOS `webkitCompassHeading`
  is converted to `alpha = 360 - heading`. `startGeolocation` uses `watchPosition`; falls back to MCO coordinates.
- **Data**: `poll()` hits `SOURCES` in order — same-origin paths `/adsb/lol/v2/point/{lat}/{lon}/{nm}` (adsb.lol)
  then `/adsb/fi/api/v2/lat/{lat}/lon/{lon}/dist/{nm}` (adsb.fi). The feeds send **no CORS headers**, so the host must
  proxy those prefixes: Amplify does it via reverse-proxy rules (`infra/custom-rules.json`, applied by `deploy.sh`),
  `test/dev-server.py` does it locally. Both return readsb JSON (`ac[]` or `aircraft[]` with `hex, flight, r, t, desc,
  lat, lon, alt_baro, alt_geom, gs, track, baro_rate, seen_pos`; `now` is ms on adsb.lol, **seconds** on adsb.fi —
  `ingest()` normalises). `ingest()` fills `S.aircraft` (Map by hex). Routes come from `ROUTE_API` (adsb.im `routeset`,
  POST `{planes:[{callsign,lat,lng}]}`, CORS `*`; response rows have `callsign, airport_codes ("KMCO-KHOU" or "unknown"),
  _airports[] {iata, icao, location, name}, plausible`), cached in `S.routes` (`null` = looked up, unknown).
- **Geometry**: `propagate()` dead-reckons from `posAt` using gs/track/vertical rate (capped at 90 s).
  `ecef()`/`enu()` give azimuth, elevation, range in an East-North-Up frame — earth curvature is correct by construction.
  `cameraBasis()` builds forward/right/up from the W3C rotation matrix `Rz(α)·Rx(β)·Ry(γ)` (columns = device axes),
  rear camera = `-z`; screen rotation is applied to right/up. `project()` does a pinhole projection with `settings.fov`
  as the *horizontal* FOV (portrait short side); vertical FOV follows aspect ratio.
- **Lock**: nearest-to-centre aircraft within `LOCK_CONE_DEG` (14°), sticky to the previous lock to avoid flicker.
- **Calibration**: `onTap()` — direction under the finger → best ADS-B candidate by *elevation* (compass can't get
  elevation wrong) → adjust `settings.offset` (persisted in `localStorage.settings`).
- **Demo**: `demoAircraft()` synthesises six planes orbiting the observer; `?demo=1` or the start-screen link.
  Without a compass (desktop) the app falls back to drag-to-look (`S.mouseLook`).
- **Lookups**: `AIRLINES` (ICAO 3-letter → name) and `TYPES` (ICAO type → friendly name); `desc` from the feed is the fallback.

State lives in `S`; user settings in `settings` (offset, fov, radius, demo, debug). Keep it that way — no globals.

## Running and testing

- Local: `python3 test/dev-server.py` then `http://localhost:8765/` (real planes via the built-in proxy, drag to look)
  or `?demo=1` for pretend planes. Camera/compass need HTTPS, so on a desktop it's data + drag only.
- Headless smoke test: `node test/smoke.js` with the dev server running (needs `npm i -D playwright && npx playwright
  install chromium` once; uses the demo, drags to aim at the first plane, asserts the card shows "Delta 88", saves
  screenshots to `test/out/`). Run it after any change to geometry, projection or the card. There are no unit tests;
  the smoke test is the regression check. It passes as of 2026-09-14.
- Phone: open https://main.dul2l469locqb.amplifyapp.com/ (redeploy with `./infra/deploy.sh`). Turn on ⚙︎ → "Show debug numbers" to see
  observer, α/β/γ, camera az/el, lock candidate and source status.

## Verified vs. unverified — important

Checked live on 2026-09-14 (curl, real Chrome, Playwright, and a real Amplify deploy):

1. ✅ **Feeds**: airplanes.live now returns 403 for unregistered clients (they want an email) — dropped. adsb.lol and
   adsb.fi work and have the fields above, but **neither sends `Access-Control-Allow-Origin`**, so a browser can't call
   them cross-origin. Hence the same-origin `/adsb/…` proxy paths (see *Data* above). Verified both locally through
   `test/dev-server.py` and on Amplify: `/adsb/lol/…` and `/adsb/fi/…` return JSON, `Cache-Control: no-store`,
   `x-cache: Miss from cloudfront`, `now` changes between calls. adsb.lol 429s under a burst; fallback to adsb.fi
   and recovery back to adsb.lol both observed.
2. ✅ **Routes**: adsb.lol's `/api/0/routeset` is broken (HTTP 201, empty text/html). adsb.im's identical endpoint works
   with CORS `*`; shape confirmed and handled (incl. `airport_codes: "unknown"` for GA → `null` route).
3. ❓ iOS compass sign: if labels move the *wrong way* as you pan (mirrored, not merely offset), flip the sign in
   `onOrient` (`alpha = e.webkitCompassHeading` instead of `360 - …`). A constant offset is expected — use tap-to-calibrate.
4. ❓ Default FOV 50° is a guess for a phone main camera in portrait; tune in ⚙︎, then change the default in `settings`.
5. ✅ **Deploy**: `infra/deploy.sh` works end to end (two bugs fixed: paginated `list-apps` query, `--no-enable-auto-build`).
   App `whats-that-plane` = `dul2l469locqb`, us-east-1, **https://main.dul2l469locqb.amplifyapp.com/**. It was deployed
   from a local root-credential CLI; the GitHub workflow still needs the `flighttracker-deploy` IAM user + repo secrets.

Items 3–4 need a phone. Also fixed: `touch-action: none` on `#overlay` (touch drags were being cancelled by the
browser — the smoke test caught it and it would have hit real phones too).

## Conventions

- Vanilla JS, ES2020+, no bundler, no dependencies at runtime. Keep the site deployable as static files.
- Kid-first UI: one screen, big yellow label, short sentences, no jargon on the main screen. Nerd data goes in ⚙︎/debug.
- Don't add a service worker without a versioned cache and `skipWaiting` — stale caches have bitten this owner before.
- Commit messages: imperative, one line + body when needed.

## Roadmap (owner's intent)

- **v1 – contrails**: filter to >28 kft (chip exists), sky-arc view sorted by elevation, match on *track direction* as
  well as compass (contrails show heading).
- **v2 – "a plane is passing over"** notification: PWAs can't run in the background on iOS. Preferred plan is a home
  ADS-B receiver (RTL-SDR + Raspberry Pi + `readsb`) with a small script pushing via ntfy/Pushover; that feed can also
  serve the AR app at home with zero latency. Native iOS app is the alternative.
- Nice-to-haves: aircraft-type emoji/illustrations, sighting log, "which way to look" arrows scaled by distance,
  voice auto-announce when a new plane gets locked (function `speakLocked(false)` exists but isn't wired to auto).
