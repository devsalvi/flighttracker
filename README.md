# What's That Plane? ✈️

Point your phone at a plane and find out which flight it is. A kid-friendly AR flight
tracker: camera + compass + GPS + free ADS-B data, in one static page. No build step, no backend.

## Try it

Open https://main.dul2l469locqb.amplifyapp.com/ on your phone, tap **Start looking**, allow camera,
motion/compass and location, then point at the sky. The plane nearest the dashed circle gets a
big yellow label and a card with the airline, flight number, route, altitude, distance, speed and
aircraft type. Tap 🔊 to have it read aloud. Planes off-screen show as edge arrows telling you
which way to turn. **High flyers** filters to aircraft above 28,000 ft — the contrail makers.

No phone handy? Add `?demo=1` (or tap *Try with pretend planes*) and drag to look around.

Locally: `python3 test/dev-server.py` then open `http://localhost:8765/` — the dev server also proxies the ADS-B
feeds, so real planes work on a desktop too (drag to look; no camera/compass without HTTPS).

## Deploy

The app needs HTTPS for the camera and compass. Amplify Hosting gives you that for free on `*.amplifyapp.com`.

### AWS Amplify — manual deployments (the cheapest way to use Amplify)

`infra/deploy.sh` zips the six site files and pushes them straight to Amplify Hosting as a **manual deployment**:
no Git connection, no build container, so **zero build minutes are billed**. What's left is storage
(~250 KB → $0.00) and data served ($0.15/GB after the 15 GB/month free tier in year one). For a pet project that
is $0.00–0.05/month. No Route 53, no ACM, no CloudFront to manage.

**Automatic (recommended):** every push to `main` runs `.github/workflows/deploy.yml`, which calls the same script.

1. In IAM create a user `flighttracker-deploy` (no console access) with the policy in `infra/deploy-policy.json`,
   and create an access key for it.
2. In the GitHub repo → Settings → Secrets and variables → Actions, add secrets `AWS_ACCESS_KEY_ID` and
   `AWS_SECRET_ACCESS_KEY` (optional variable `AWS_REGION`, default `us-east-1`).
3. Push. The job summary shows the URL: `https://main.<app-id>.amplifyapp.com/`. Live within a minute.

Prefer no long-lived keys? Create an OIDC role and flip to Option B in the workflow.

**Manual:** with the AWS CLI configured locally, `./infra/deploy.sh` does the same thing from your machine.

**Custom domain later:** Amplify console → App settings → Domain management; the certificate is free.

**Tear down:** `aws amplify delete-app --app-id <id>` — nothing else is created.

*Why not connect the GitHub repo in the Amplify console?* That works too, but each push then runs a build
container for ~1 minute ($0.01/min after the first year's 1,000 free minutes). Manual deployments skip that entirely.

### GitHub Pages (free, but demo only)

Settings → Pages → Deploy from branch `main`, folder `/ (root)` → `https://devsalvi.github.io/flighttracker/`.
Pages can't proxy `/adsb/…`, so only pretend planes work there; live data needs Amplify (or any host with a reverse proxy).

On the phone: Share → **Add to Home Screen** for a full-screen app icon.

## How it works

- **Data**: polls [adsb.lol](https://adsb.lol) (falls back to [adsb.fi](https://adsb.fi)) every 4 s
  for aircraft within the search radius (default 100 nm). Both are free community ADS-B feeds, but neither
  sends CORS headers, so the page fetches `/adsb/lol/…` and `/adsb/fi/…` on its own origin and the host proxies
  them (Amplify reverse-proxy rules in `infra/custom-rules.json`; `test/dev-server.py` locally). Positions lag a
  few seconds, so each aircraft is dead-reckoned to "now" from its last position, ground speed, track and vertical rate.
- **Routes** ("Amsterdam → Orlando"): looked up by callsign from [adsb.im](https://adsb.im)'s `routeset` API
  (the same service adsb.lol runs, with CORS), cached per flight.
- **Where is the phone pointing**: `DeviceOrientationEvent` (absolute on Android, `webkitCompassHeading` on iOS)
  → W3C rotation matrix → camera forward/right/up vectors in an East-North-Up frame.
- **Where is the plane**: observer and aircraft positions → ECEF → ENU → azimuth/elevation/range.
  Earth curvature is handled for free by doing it in ECEF (matters for high-altitude aircraft far away).
- **Matching**: every aircraft direction is projected through the camera's field of view. The one closest to
  the screen centre within a 14° cone is "locked" (with a little hysteresis so it doesn't flicker).
- **Compass fix**: phone compasses are routinely 10–20° off. Tap the real plane on screen and the app finds the
  ADS-B aircraft with the matching *elevation* (which the compass can't get wrong) and shifts the heading to match.
  The offset is remembered. There's also a manual slider in ⚙︎.

## Known limits

- iOS Safari only delivers a compass heading over HTTPS, after a tap-triggered permission prompt, and Low Power
  Mode throttles sensor events. Hold the phone in portrait.
- Field of view defaults to 50° horizontal (typical main camera in portrait). If labels drift as you tilt, adjust it in ⚙︎.
- Free feeds rate-limit; if a source fails the app falls back to the next one and shows "offline" in ⚙︎.
  airplanes.live was dropped: it now returns 403 unless you email them for access.
- Aircraft without ADS-B (some military, some older GA) never appear. Birds also do not appear.

## Roadmap

- **v1 – contrails**: sky-arc view of high flyers sorted by elevation; match on track direction, not just compass.
- **v2 – "a plane is passing over"**: notifications. A PWA can't run in the background on iOS, so this is either a
  native app or, better, a home ADS-B receiver (RTL-SDR + Raspberry Pi + `readsb`) pushing via ntfy/Pushover.
