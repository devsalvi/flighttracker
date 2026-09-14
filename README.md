# What's That Plane? ✈️

Point your phone at a plane and find out which flight it is. A kid-friendly AR flight
tracker: camera + compass + GPS + free ADS-B data, in one static page. No build step, no backend.

## Try it

Open the deployed page on your phone (see *Deploy*), tap **Start looking**, allow camera,
motion/compass and location, then point at the sky. The plane nearest the dashed circle gets a
big yellow label and a card with the airline, flight number, route, altitude, distance, speed and
aircraft type. Tap 🔊 to have it read aloud. Planes off-screen show as edge arrows telling you
which way to turn. **High flyers** filters to aircraft above 28,000 ft — the contrail makers.

No phone handy? Add `?demo=1` (or tap *Try with pretend planes*) and drag to look around.

## Deploy (GitHub Pages)

The app needs HTTPS for the camera and compass. GitHub Pages is the easiest:

1. Repo → **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch `main`, folder `/ (root)`.
2. Wait a minute, then open `https://devsalvi.github.io/flighttracker/` on your phone.
3. Share → **Add to Home Screen** to get a full-screen app icon.

Any static host works (Vercel, Netlify, Amplify) — it's just files.

## How it works

- **Data**: polls [airplanes.live](https://airplanes.live) (falls back to [adsb.lol](https://adsb.lol)) every 4 s
  for aircraft within the search radius (default 100 nm). Both are free community ADS-B feeds with
  CORS enabled. Positions lag a few seconds, so each aircraft is dead-reckoned to "now" from its last
  position, ground speed, track and vertical rate.
- **Routes** ("Amsterdam → Orlando"): looked up by callsign from adsb.lol's `routeset` API, cached per flight.
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
- Aircraft without ADS-B (some military, some older GA) never appear. Birds also do not appear.

## Roadmap

- **v1 – contrails**: sky-arc view of high flyers sorted by elevation; match on track direction, not just compass.
- **v2 – "a plane is passing over"**: notifications. A PWA can't run in the background on iOS, so this is either a
  native app or, better, a home ADS-B receiver (RTL-SDR + Raspberry Pi + `readsb`) pushing via ntfy/Pushover.
