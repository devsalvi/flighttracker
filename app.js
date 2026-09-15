/* What's That Plane? — v0 point-and-identify AR flight tracker.
   Single-file app: sensors → geometry → matching → DOM overlay. No build step. */
(() => {
  'use strict';

  // ------------------------------------------------------------------ config
  // Position feeds send no CORS headers (verified 2026-09: adsb.lol, adsb.fi; airplanes.live now needs an
  // approved key), so the browser can't call them directly. The page fetches same-origin paths instead and
  // the host proxies them: Amplify reverse-proxy rules in infra/custom-rules.json, test/dev-server.py locally.
  const SOURCES = [
    { name: 'adsb.lol', url: (lat, lon, r) => `/adsb/lol/v2/point/${lat}/${lon}/${r}` },
    { name: 'adsb.fi',  url: (lat, lon, r) => `/adsb/fi/api/v2/lat/${lat}/lon/${lon}/dist/${r}` },
  ];
  const ROUTE_API = 'https://adsb.im/api/0/routeset';   // same routeset API as adsb.lol's, but with CORS * (adsb.lol's is broken)
  const POLL_MS = 4000;          // ADS-B poll interval
  const LOCK_CONE_DEG = 14;      // how close to screen centre an aircraft must be to get "locked"
  const HIGH_FT = 28000;         // "High flyers" filter threshold (contrail territory)
  const MAX_EDGE_ARROWS = 3;
  const FT = 0.3048, KT = 0.514444, NM = 1852, MI = 1609.344;

  const settings = load('settings', { v: 2, offset: 0, fov: 50, radius: 100, demo: false, debug: false, mirror: false });
  if (settings.v !== 2) { settings.offset = 0; settings.v = 2; save(); }   // v1 stored the offset with the opposite sign

  // ------------------------------------------------------------------ state
  const S = {
    started: false,
    filter: 'all',
    obs: null,                // { lat, lon, alt(m) }
    orient: null,             // { alpha, beta, gamma, absolute, heading }
    orientSeen: false,
    yawFix: null,             // deg to rotate the gyro frame so it agrees with the compass (iOS); low-passed
    mouseLook: null,          // desktop fallback { az, el }
    aircraft: new Map(),      // hex -> record
    fetchedAt: 0,
    source: '—',
    routes: new Map(),        // callsign -> { from, to, fromCity, toCity }
    routePending: new Set(),
    locked: null,             // hex
    lastSpoken: null,
    markers: new Map(),       // hex -> element
    edges: [],                // pooled edge-arrow elements
  };

  // ------------------------------------------------------------------ DOM
  const $ = (id) => document.getElementById(id);
  const el = {
    start: $('start'), ar: $('ar'), cam: $('cam'), overlay: $('overlay'), status: $('status'),
    hint: $('hint'), card: $('card'), settings: $('settings'), debug: $('debug'), startError: $('start-error'),
  };

  // ------------------------------------------------------------------ boot
  $('btn-start').addEventListener('click', () => start(false));
  $('btn-demo').addEventListener('click', () => start(true));
  $('btn-settings').addEventListener('click', () => { el.settings.hidden = !el.settings.hidden; });
  $('btn-settings-close').addEventListener('click', () => { el.settings.hidden = true; });
  $('btn-speak').addEventListener('click', () => speakLocked(true));
  document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === c));
    S.filter = c.dataset.filter;
  }));
  bindRange('s-offset', 'v-offset', 'offset', (v) => `${v}°`);
  bindRange('s-fov', 'v-fov', 'fov', (v) => `${v}°`);
  bindRange('s-radius', 'v-radius', 'radius', (v) => `${v} nm`);
  $('s-demo').checked = settings.demo;
  $('s-demo').addEventListener('change', (e) => { settings.demo = e.target.checked; save(); S.aircraft.clear(); poll(); });
  $('s-mirror').checked = settings.mirror;
  $('s-mirror').addEventListener('change', (e) => { settings.mirror = e.target.checked; settings.offset = 0; S.yawFix = null; save(); });
  $('s-debug').checked = settings.debug;
  $('s-debug').addEventListener('change', (e) => { settings.debug = e.target.checked; save(); el.debug.hidden = !settings.debug; });
  el.debug.hidden = !settings.debug;
  if (new URLSearchParams(location.search).has('demo')) { settings.demo = true; $('s-demo').checked = true; }

  // tap on the sky: calibrate compass against the nearest candidate
  el.overlay.addEventListener('pointerdown', onTap);
  // desktop fallback: drag to look around
  let dragging = null;
  el.overlay.addEventListener('pointerdown', (e) => { dragging = { x: e.clientX, y: e.clientY }; });
  window.addEventListener('pointermove', (e) => {
    if (!dragging || S.orientSeen) return;
    S.mouseLook ??= { az: 0, el: 20 };
    S.mouseLook.az = (S.mouseLook.az - (e.clientX - dragging.x) * 0.25 + 360) % 360;
    S.mouseLook.el = clamp(S.mouseLook.el + (e.clientY - dragging.y) * 0.25, -20, 89);
    dragging = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('pointerup', () => { dragging = null; });

  async function start(demo) {
    if (demo) { settings.demo = true; $('s-demo').checked = true; }
    el.startError.hidden = true;
    const problems = [];
    // each sensor is independent: a missing camera or compass still leaves a usable (if less magical) app
    try { await requestOrientation(); } catch (err) { console.warn(err); problems.push(`compass: ${err.message || err}`); }
    try { await startCamera(); } catch (err) { console.warn(err); problems.push(`camera: ${err.message || err}`); }
    startGeolocation();
    if (problems.length && !demo) hint(`Some things didn't start — ${problems.join('; ')}`, 6000);
    S.started = true;
    el.start.hidden = true;
    el.ar.hidden = false;
    setTimeout(() => { if (!S.orientSeen) { S.mouseLook = { az: 0, el: 20 }; hint('No compass on this device — drag to look around.', 4000); } }, 2500);
    requestAnimationFrame(frame);
    setInterval(poll, POLL_MS);
  }

  // ------------------------------------------------------------------ sensors
  async function requestOrientation() {
    let res = 'granted';
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      try { res = await DeviceOrientationEvent.requestPermission(); }   // iOS 13+, must be inside a user gesture
      catch (e) { res = e.message || String(e); }
    }
    // Listen regardless: a "denied" browser simply never fires, and it lets synthetic events through in tests.
    if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', onOrient, true);
    }
    window.addEventListener('deviceorientation', onOrient, true);
    if (res !== 'granted') throw new Error(`compass permission ${res}`);
  }

  function onOrient(e) {
    if (e.alpha == null && e.webkitCompassHeading == null) return;
    // Prefer absolute events; ignore relative ones once we've had an absolute one.
    if (e.type === 'deviceorientation' && S.orient && S.orient.absolute && e.webkitCompassHeading == null) return;
    const heading = e.webkitCompassHeading != null && Number.isFinite(e.webkitCompassHeading) ? e.webkitCompassHeading : null;
    // Keep alpha/beta/gamma exactly as the gyro fusion gives them (they only make sense as a set — near an upright
    // pose alpha and gamma jump together). iOS's alpha is relative; the compass heading pins it down in cameraBasis().
    S.orient = { alpha: e.alpha || 0, beta: e.beta || 0, gamma: e.gamma || 0,
      absolute: e.absolute === true || e.type === 'deviceorientationabsolute' || heading != null, heading };
    S.orientSeen = true;
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('camera not available (needs https)');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
    });
    el.cam.srcObject = stream;
  }

  function startGeolocation() {
    if (!navigator.geolocation) { S.obs = { lat: 28.4312, lon: -81.3081, alt: 30 }; return; } // MCO, as a fallback
    navigator.geolocation.watchPosition((p) => {
      const first = !S.obs;
      S.obs = { lat: p.coords.latitude, lon: p.coords.longitude, alt: (p.coords.altitude ?? 20) + 1.5 };
      if (first) poll();
    }, (err) => {
      console.warn('geolocation', err);
      if (!S.obs) { S.obs = { lat: 28.4312, lon: -81.3081, alt: 30 }; hint('No location — pretending you are at Orlando airport.', 5000); poll(); }
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
  }

  // ------------------------------------------------------------------ data
  let polling = false;
  async function poll() {
    if (!S.started || !S.obs || polling) return;
    polling = true;
    try {
      if (settings.demo) { ingest(demoAircraft(), 'pretend planes'); return; }
      let lastErr;
      for (const src of SOURCES) {
        try {
          const r = await fetch(src.url(S.obs.lat.toFixed(4), S.obs.lon.toFixed(4), settings.radius), { cache: 'no-store' });
          if (!r.ok) throw new Error(`${src.name} HTTP ${r.status}`);
          const j = await r.json();
          ingest(j.ac || j.aircraft || [], src.name, j.now);
          return;
        } catch (e) { lastErr = e; }
      }
      S.source = `offline (${lastErr?.message || 'no data'})`;
    } finally { polling = false; }
  }

  function ingest(list, source, serverNow) {
    const now = Date.now();
    if (serverNow && serverNow < 1e12) serverNow *= 1000;   // adsb.fi reports seconds, readsb (adsb.lol) milliseconds
    const skew = serverNow ? clamp(now - serverNow, 0, 15000) : 0;   // server "now" lags a little; a big gap is a bad phone clock, ignore it
    const seen = new Set();
    for (const a of list) {
      if (a.lat == null || a.lon == null) continue;
      const altFt = numOr(a.alt_geom, numOr(a.alt_baro, null));
      if (altFt == null || a.alt_baro === 'ground') continue;
      const rec = S.aircraft.get(a.hex) || { hex: a.hex };
      Object.assign(rec, {
        callsign: (a.flight || '').trim(),
        reg: a.r || '',
        type: a.t || '',
        desc: a.desc || '',
        lat: a.lat, lon: a.lon, altFt,
        gs: numOr(a.gs, 0), track: numOr(a.track, numOr(a.true_heading, null)),
        vr: numOr(a.baro_rate, numOr(a.geom_rate, 0)),
        posAt: now - ((a.seen_pos || 0) * 1000) - skew,
      });
      S.aircraft.set(a.hex, rec);
      seen.add(a.hex);
      if (rec.callsign && !S.routes.has(rec.callsign) && !S.routePending.has(rec.callsign)) S.routePending.add(rec.callsign);
    }
    for (const hex of [...S.aircraft.keys()]) if (!seen.has(hex)) S.aircraft.delete(hex);
    S.fetchedAt = now;
    S.source = source;
    $('v-source').textContent = source;
    if (S.routePending.size && !settings.demo) lookupRoutes();
  }

  async function lookupRoutes() {
    const batch = [...S.routePending].slice(0, 50);
    batch.forEach((c) => S.routePending.delete(c));
    const planes = batch.map((callsign) => {
      const a = [...S.aircraft.values()].find((x) => x.callsign === callsign);
      return { callsign, lat: a?.lat ?? S.obs.lat, lng: a?.lon ?? S.obs.lon };
    });
    try {
      const r = await fetch(ROUTE_API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ planes }) });
      if (!r.ok) throw new Error(`route HTTP ${r.status}`);
      const j = await r.json();
      for (const row of (Array.isArray(j) ? j : [])) {
        const ap = row._airports || [];
        const codes = (row.airport_codes || '').split('-').filter((c) => c && c !== 'unknown');   // "unknown" for GA/unrouted
        const from = ap[0] || {}, to = ap[ap.length - 1] || {};
        if (!row.callsign) continue;
        const fromCode = from.iata || codes[0] || '', toCode = to.iata || codes[codes.length - 1] || '';
        S.routes.set(row.callsign, fromCode && toCode ? {
          from: fromCode, to: toCode,
          fromCity: from.location || from.name || '', toCity: to.location || to.name || '',
          plausible: row.plausible !== 0 && row.plausible !== false,
        } : null);                                          // null = looked up, no route known (most GA)
      }
      batch.forEach((c) => { if (!S.routes.has(c)) S.routes.set(c, null); });   // remember misses
    } catch (e) {
      console.warn('routes', e);
      batch.forEach((c) => S.routes.set(c, null));
    }
  }

  // ------------------------------------------------------------------ geometry
  // Dead-reckon an aircraft to "now" using ground speed / track / vertical rate.
  function propagate(a, now) {
    const dt = clamp((now - a.posAt) / 1000, 0, 90);
    const d = a.track == null ? 0 : a.gs * KT * dt;        // metres along track (unknown track: stay put)
    const tr = (a.track || 0) * Math.PI / 180;
    const lat = a.lat + (d * Math.cos(tr)) / 111320;
    const lon = a.lon + (d * Math.sin(tr)) / (111320 * Math.cos(a.lat * Math.PI / 180));
    const altFt = a.altFt + a.vr * dt / 60;
    return { lat, lon, altM: altFt * FT, altFt };
  }

  function ecef(latDeg, lonDeg, h) {
    const a = 6378137, e2 = 6.69437999014e-3;
    const lat = latDeg * Math.PI / 180, lon = lonDeg * Math.PI / 180;
    const sl = Math.sin(lat), cl = Math.cos(lat);
    const N = a / Math.sqrt(1 - e2 * sl * sl);
    return [(N + h) * cl * Math.cos(lon), (N + h) * cl * Math.sin(lon), (N * (1 - e2) + h) * sl];
  }

  // East/North/Up vector from observer to target, plus azimuth (deg, clockwise from N), elevation (deg), range (m).
  function enu(obs, tgt) {
    const o = ecef(obs.lat, obs.lon, obs.alt), t = ecef(tgt.lat, tgt.lon, tgt.altM);
    const dx = t[0] - o[0], dy = t[1] - o[1], dz = t[2] - o[2];
    const lat = obs.lat * Math.PI / 180, lon = obs.lon * Math.PI / 180;
    const sl = Math.sin(lat), cl = Math.cos(lat), so = Math.sin(lon), co = Math.cos(lon);
    const e = -so * dx + co * dy;
    const n = -sl * co * dx - sl * so * dy + cl * dz;
    const u = cl * co * dx + cl * so * dy + sl * dz;
    const range = Math.hypot(e, n, u);
    return { e: e / range, n: n / range, u: u / range, range,
      az: (Math.atan2(e, n) * 180 / Math.PI + 360) % 360, el: Math.asin(u / range) * 180 / Math.PI };
  }

  // Camera basis (forward/right/up as world ENU unit vectors) from device orientation.
  function cameraBasis() {
    if (!S.orient) {
      const ml = S.mouseLook || { az: 0, el: 20 };
      return basisFromAzEl(ml.az, ml.el);
    }
    const d = Math.PI / 180, o = S.orient;
    const A = o.alpha * d, B = o.beta * d, G = o.gamma * d;
    const cA = Math.cos(A), sA = Math.sin(A), cB = Math.cos(B), sB = Math.sin(B), cG = Math.cos(G), sG = Math.sin(G);
    // W3C rotation matrix R = Rz(alpha)·Rx(beta)·Ry(gamma); columns = device axes (x right, y top, z out of screen) in world (E,N,U).
    const R = [
      [cA * cG - sA * sB * sG, -cB * sA, cA * sG + cG * sA * sB],
      [cG * sA + cA * sB * sG,  cA * cB, sA * sG - cA * cG * sB],
      [-cB * sG,                sB,      cB * cG],
    ];
    const col = (i) => [R[0][i], R[1][i], R[2][i]];
    const X = col(0), Y = col(1), Z = col(2);
    const forward = [-Z[0], -Z[1], -Z[2]];                  // rear camera looks along -z of the device
    const th = ((screen.orientation && screen.orientation.angle) || window.orientation || 0) * d;
    const ct = Math.cos(th), st = Math.sin(th);
    const right = [X[0] * ct - Y[0] * st, X[1] * ct - Y[1] * st, X[2] * ct - Y[2] * st];
    const up    = [X[0] * st + Y[0] * ct, X[1] * st + Y[1] * ct, X[2] * st + Y[2] * ct];

    // Yaw: the gyro frame is smooth but (on iOS) relative; the compass is absolute but noisy. Rotate the whole
    // frame about "up" by the slowly-filtered difference, so panning is instant and drift is still removed.
    let yaw = settings.offset;                                // user/tap calibration, clockwise degrees
    if (o.heading != null) {
      // iOS reports the heading of the top edge when the phone is flat-ish and of the back camera when it's upright.
      // Use whichever of those is more horizontal so we compare like with like.
      const top = [Y[0], Y[1]], cam = [forward[0], forward[1]];
      const ref = Math.hypot(top[0], top[1]) >= Math.hypot(cam[0], cam[1]) ? top : cam;
      const azRef = Math.atan2(ref[0], ref[1]) / d;
      const corr = wrap180((settings.mirror ? -o.heading : o.heading) - azRef);
      S.yawFix = (S.yawFix == null || Math.abs(wrap180(corr - S.yawFix)) > 60)
        ? corr : S.yawFix + wrap180(corr - S.yawFix) * 0.05;   // ~0.3 s time constant at 60 fps
      yaw += S.yawFix;
    }
    const yr = yaw * d, cy = Math.cos(yr), sy = Math.sin(yr);
    const turn = (v) => [v[0] * cy + v[1] * sy, -v[0] * sy + v[1] * cy, v[2]];   // azimuth += yaw
    return { forward: turn(forward), right: turn(right), up: turn(up) };
  }

  function basisFromAzEl(azDeg, elDeg) {
    const az = azDeg * Math.PI / 180, elv = elDeg * Math.PI / 180;
    const forward = [Math.sin(az) * Math.cos(elv), Math.cos(az) * Math.cos(elv), Math.sin(elv)];
    const right = [Math.cos(az), -Math.sin(az), 0];
    const up = cross(right, forward);
    return { forward, right, up };
  }

  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

  // Project a world direction into normalised screen coords. Returns { x, y, inFront, off } with x/y in pixels.
  function project(dir, basis, w, h) {
    const f = dot(dir, basis.forward), r = dot(dir, basis.right), u = dot(dir, basis.up);
    const hFov = settings.fov * Math.PI / 180;
    const th = Math.tan(hFov / 2);                       // horizontal half-FOV (portrait: short side)
    const tv = th * (h / w);                             // vertical half-FOV keeps square pixels
    if (f <= 0.02) return { inFront: false, r, u, f };
    const xn = (r / f) / th, yn = (u / f) / tv;          // -1..1 inside the view
    const x = w / 2 + xn * w / 2, y = h / 2 - yn * h / 2;
    const off = Math.abs(xn) > 1 || Math.abs(yn) > 1;
    return { inFront: true, x, y, xn, yn, off, r, u, f };
  }

  // ------------------------------------------------------------------ frame loop
  function frame() {
    if (!S.started) return;
    const now = Date.now();
    const w = el.overlay.clientWidth, h = el.overlay.clientHeight;
    const basis = cameraBasis();
    const camAz = (Math.atan2(basis.forward[0], basis.forward[1]) * 180 / Math.PI + 360) % 360;
    const camEl = Math.asin(clamp(basis.forward[2], -1, 1)) * 180 / Math.PI;

    const visible = [], offscreen = [];
    if (S.obs) {
      for (const a of S.aircraft.values()) {
        if (S.filter === 'high' && a.altFt < HIGH_FT) continue;
        const p = propagate(a, now);
        const g = enu(S.obs, p);
        if (g.el < -2) continue;                           // below the horizon
        const pr = project([g.e, g.n, g.u], basis, w, h);
        const angle = Math.acos(clamp(dot([g.e, g.n, g.u], basis.forward), -1, 1)) * 180 / Math.PI; // off-centre angle
        const item = { a, p, g, pr, angle };
        if (pr.inFront && !pr.off) visible.push(item); else offscreen.push(item);
      }
    }

    // lock: the aircraft nearest the reticle, within the cone; sticky to avoid flicker
    visible.sort((x, y) => x.angle - y.angle);
    let lock = visible.find((v) => v.angle <= LOCK_CONE_DEG) || null;
    const prev = S.locked && visible.find((v) => v.a.hex === S.locked);
    if (prev && prev.angle <= LOCK_CONE_DEG * 1.5 && lock && lock.angle > prev.angle - 3) lock = prev;
    S.locked = lock ? lock.a.hex : null;

    // markers
    const live = new Set();
    for (const v of visible) {
      live.add(v.a.hex);
      let m = S.markers.get(v.a.hex);
      if (!m) {
        m = document.createElement('div'); m.className = 'marker';
        m.innerHTML = '<div class="dot"></div><div class="tag"></div>';
        el.overlay.appendChild(m); S.markers.set(v.a.hex, m);
      }
      m.style.transform = `translate(${v.pr.x.toFixed(1)}px, ${v.pr.y.toFixed(1)}px) translate(-50%, -50%)`;
      m.classList.toggle('locked', v.a.hex === S.locked);
      m.classList.toggle('high', v.a.altFt >= HIGH_FT);
      m.lastChild.textContent = label(v.a);
    }
    for (const [hex, m] of S.markers) if (!live.has(hex)) { m.remove(); S.markers.delete(hex); }

    // edge arrows for the nearest few off-screen aircraft
    offscreen.sort((x, y) => x.angle - y.angle);
    const edges = offscreen.slice(0, MAX_EDGE_ARROWS);
    while (S.edges.length < edges.length) { const e = document.createElement('div'); e.className = 'edge'; el.overlay.appendChild(e); S.edges.push(e); }
    S.edges.forEach((e, i) => {
      const v = edges[i];
      if (!v) { e.hidden = true; return; }
      e.hidden = false;
      // direction on screen: use projected right/up components (works even when behind the camera)
      const dx = v.pr.r, dy = v.pr.u;
      const len = Math.hypot(dx, dy) || 1;
      const nx = dx / len, ny = dy / len;
      const pad = 44;
      const sx = w / 2 + nx * (w / 2 - pad), sy = h / 2 - ny * (h / 2 - pad);
      const cx = clamp(sx, pad, w - pad), cy = clamp(sy, pad + 60, h - pad - 40);
      const ang = Math.atan2(-ny, nx) * 180 / Math.PI;
      e.style.transform = `translate(${cx.toFixed(1)}px, ${cy.toFixed(1)}px) translate(-50%, -50%)`;
      e.innerHTML = `<span class="arrow" style="transform:rotate(${ang.toFixed(0)}deg)">➜</span>${label(v.a)}`;
    });

    // card + status
    updateCard(lock);
    const n = S.aircraft.size, ageS = S.fetchedAt ? Math.round((now - S.fetchedAt) / 1000) : null;
    el.status.textContent = S.obs
      ? `${n} plane${n === 1 ? '' : 's'} · ${compass(camAz)} ${Math.round(camEl)}°${ageS != null && ageS > 15 ? ` · data ${ageS}s old` : ''}`
      : 'finding you…';
    if (settings.debug) {
      const o = S.orient;
      el.debug.textContent = `obs ${S.obs ? `${S.obs.lat.toFixed(4)},${S.obs.lon.toFixed(4)} ${S.obs.alt.toFixed(0)}m` : '—'}\n` +
        `orient ${o ? `α${o.alpha.toFixed(0)} β${o.beta.toFixed(0)} γ${o.gamma.toFixed(0)} ${o.absolute ? 'abs' : 'REL'}` : 'none'}` +
        ` hdg ${o && o.heading != null ? o.heading.toFixed(0) : '—'} fix ${S.yawFix == null ? '—' : S.yawFix.toFixed(0)} offset ${settings.offset}${settings.mirror ? ' mirrored' : ''}\n` +
        `cam az ${camAz.toFixed(1)} el ${camEl.toFixed(1)} · visible ${visible.length} off ${offscreen.length} · src ${S.source}\n` +
        (lock ? `lock ${lock.a.hex} az ${lock.g.az.toFixed(1)} el ${lock.g.el.toFixed(1)} rng ${(lock.g.range / MI).toFixed(1)}mi off ${lock.angle.toFixed(1)}°` : '');
    }
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ card
  function updateCard(lock) {
    if (!lock) { el.card.hidden = true; return; }
    const a = lock.a, r = S.routes.get(a.callsign);
    const al = airline(a.callsign);
    $('c-airline').textContent = al.name;
    $('c-flight').textContent = al.number ? `${al.number}` : (a.callsign || a.reg || a.hex.toUpperCase());
    $('c-route').textContent = r && r.from
      ? `${r.fromCity || r.from} → ${r.toCity || r.to}${r.plausible ? '' : ' (probably)'}`
      : (r === null ? 'Route unknown' : 'Looking up route…');
    $('c-alt').textContent = `${fmtNum(Math.round(lock.p.altFt / 100) * 100)} ft`;
    $('c-dist').textContent = `${(lock.g.range / MI).toFixed(lock.g.range / MI < 10 ? 1 : 0)} mi`;
    $('c-speed').textContent = `${Math.round(a.gs * KT / MI * 3600)} mph`;
    $('c-type').textContent = typeName(a);
    $('c-kid').textContent = kidSentence(a, lock, r);
    el.card.hidden = false;
  }

  function kidSentence(a, lock, r) {
    const al = airline(a.callsign);
    const who = al.number ? `${al.name} flight ${al.number}`
      : al.name === 'Private plane' ? 'a private plane'
      : al.name !== 'Unknown airline' ? `a ${al.name} plane` : 'a plane';
    const what = typeName(a);
    const where = r && r.from ? ` flying from ${r.fromCity || r.from} to ${r.toCity || r.to}` : '';
    const miles = lock.p.altFt / 5280;
    const up = miles >= 1 ? `${miles.toFixed(miles < 3 ? 1 : 0)} miles up` : `${Math.round(lock.p.altFt / 100) * 100} feet up`;
    const dist = (lock.g.range / MI).toFixed(0);
    const mph = Math.round(a.gs * KT / MI * 3600);
    const an = /^[aeiou]/i.test(what) ? 'an' : 'a';
    return `That's ${who}, ${an} ${what}${where}. It's ${up} and ${dist} miles away, going ${mph} miles an hour!`;
  }

  function speakLocked(force) {
    if (!S.locked || !('speechSynthesis' in window)) return;
    const txt = $('c-kid').textContent;
    if (!force && txt === S.lastSpoken) return;
    S.lastSpoken = txt;
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(txt));
  }

  // ------------------------------------------------------------------ calibration by tapping the plane
  function onTap(e) {
    if (!S.orientSeen || !S.obs || !el.settings.hidden) return;
    const w = el.overlay.clientWidth, h = el.overlay.clientHeight;
    const basis = cameraBasis();
    const now = Date.now();
    // direction under the finger
    const hFov = settings.fov * Math.PI / 180, th = Math.tan(hFov / 2), tv = th * (h / w);
    const xn = (e.clientX - w / 2) / (w / 2), yn = -(e.clientY - h / 2) / (h / 2);
    const d = norm([
      basis.forward[0] + basis.right[0] * xn * th + basis.up[0] * yn * tv,
      basis.forward[1] + basis.right[1] * xn * th + basis.up[1] * yn * tv,
      basis.forward[2] + basis.right[2] * xn * th + basis.up[2] * yn * tv,
    ]);
    const tapAz = (Math.atan2(d[0], d[1]) * 180 / Math.PI + 360) % 360;
    const tapEl = Math.asin(clamp(d[2], -1, 1)) * 180 / Math.PI;
    // best candidate: closest in elevation (compass error doesn't affect elevation), then in azimuth
    let best = null;
    for (const a of S.aircraft.values()) {
      const g = enu(S.obs, propagate(a, now));
      if (g.el < 0) continue;
      const dEl = Math.abs(g.el - tapEl), dAz = Math.abs(wrap180(g.az - tapAz));
      const score = dEl * 2 + dAz * 0.5;
      if (dEl < 15 && dAz < 90 && (!best || score < best.score)) best = { a, g, score, dAz: wrap180(g.az - tapAz) };
    }
    if (!best) { hint('No plane near there in the data. Maybe it is a bird. Or a very sneaky plane.', 3000); return; }
    settings.offset = Math.round(wrap180(settings.offset + best.dAz));
    $('s-offset').value = settings.offset; $('v-offset').textContent = `${settings.offset}°`;
    save();
    hint(`Compass fixed on ${label(best.a)} (${settings.offset > 0 ? '+' : ''}${settings.offset}°)`, 2500);
  }

  // ------------------------------------------------------------------ demo data
  let demoSeed = null, demoStart = Date.now();
  function demoAircraft() {
    const o = S.obs, t = (Date.now() - demoStart) / 1000;
    demoSeed ??= [
      { hex: 'd1', flight: 'DAL88',  t: 'A339', desc: 'AIRBUS A330-900', az0: 20,  gs: 470, alt: 36000, track: 200, r: 25 },
      { hex: 'd2', flight: 'SWA1234',t: 'B738', desc: 'BOEING 737-800',  az0: 60,  gs: 250, alt: 6000,  track: 180, r: 8 },
      { hex: 'd3', flight: 'JBU417', t: 'A321', desc: 'AIRBUS A321',     az0: 130, gs: 280, alt: 9000,  track: 350, r: 10 },
      { hex: 'd4', flight: 'BAW2037',t: 'B789', desc: 'BOEING 787-9',    az0: 280, gs: 480, alt: 39000, track: 90,  r: 30 },
      { hex: 'd5', flight: 'N734KA', t: 'C172', desc: 'CESSNA 172',      az0: 330, gs: 95,  alt: 2500,  track: 45,  r: 3 },
      { hex: 'd6', flight: 'FDX1408',t: 'B763', desc: 'BOEING 767-300',  az0: 200, gs: 300, alt: 15000, track: 300, r: 15 },
    ];
    if (!S.routes.size) {
      S.routes.set('DAL88', { from: 'AMS', to: 'ATL', fromCity: 'Amsterdam', toCity: 'Atlanta', plausible: true });
      S.routes.set('SWA1234', { from: 'BNA', to: 'MCO', fromCity: 'Nashville', toCity: 'Orlando', plausible: true });
      S.routes.set('JBU417', { from: 'MCO', to: 'JFK', fromCity: 'Orlando', toCity: 'New York', plausible: true });
      S.routes.set('BAW2037', { from: 'LGW', to: 'MCO', fromCity: 'London', toCity: 'Orlando', plausible: true });
      S.routes.set('N734KA', null);
      S.routes.set('FDX1408', { from: 'MEM', to: 'MIA', fromCity: 'Memphis', toCity: 'Miami', plausible: true });
    }
    return demoSeed.map((d) => {
      // orbit slowly around the observer so things move
      const az = (d.az0 + t * (d.gs / 60) / d.r) % 360;
      const dist = d.r * MI;
      const lat = o.lat + (dist * Math.cos(az * Math.PI / 180)) / 111320;
      const lon = o.lon + (dist * Math.sin(az * Math.PI / 180)) / (111320 * Math.cos(o.lat * Math.PI / 180));
      return { hex: d.hex, flight: d.flight, t: d.t, desc: d.desc, lat, lon, alt_baro: d.alt, alt_geom: d.alt, gs: d.gs, track: (az + 90) % 360, baro_rate: 0, seen_pos: 0 };
    });
  }

  // ------------------------------------------------------------------ lookups
  const AIRLINES = {
    AAL: 'American', DAL: 'Delta', UAL: 'United', SWA: 'Southwest', JBU: 'JetBlue', NKS: 'Spirit', FFT: 'Frontier',
    ASA: 'Alaska', AAY: 'Allegiant', SCX: 'Sun Country', MXY: 'Breeze', HAL: 'Hawaiian', SKW: 'SkyWest', EDV: 'Endeavor',
    RPA: 'Republic', ENY: 'Envoy', JIA: 'PSA', PDT: 'Piedmont', ASH: 'Mesa', GJS: 'GoJet', CPZ: 'Compass',
    FDX: 'FedEx', UPS: 'UPS', GTI: 'Atlas Air', ABX: 'ABX Air', CKS: 'Kalitta', SWQ: 'Swift Air',
    BAW: 'British Airways', VIR: 'Virgin Atlantic', DLH: 'Lufthansa', KLM: 'KLM', AFR: 'Air France', IBE: 'Iberia',
    ICE: 'Icelandair', EIN: 'Aer Lingus', NAX: 'Norwegian', NSZ: 'Norse Atlantic', TOM: 'TUI', EXS: 'Jet2', EZY: 'easyJet',
    RYR: 'Ryanair', SWR: 'Swiss', AUA: 'Austrian', EWG: 'Eurowings', CFG: 'Condor', DLA: 'Discover', EDW: 'Edelweiss',
    ITY: 'ITA Airways', AZA: 'Alitalia', TAP: 'TAP Portugal', FIN: 'Finnair', SAS: 'SAS', LOT: 'LOT Polish',
    UAE: 'Emirates', QTR: 'Qatar Airways', ETD: 'Etihad', THY: 'Turkish', ELY: 'El Al', SVA: 'Saudia',
    ACA: 'Air Canada', WJA: 'WestJet', TSC: 'Air Transat', POE: 'Porter', ROU: 'Air Canada Rouge', SWG: 'Sunwing',
    AMX: 'Aeroméxico', VOI: 'Volaris', VIV: 'Viva Aerobus', CMP: 'Copa', AVA: 'Avianca', LAN: 'LATAM', TAM: 'LATAM',
    ARG: 'Aerolíneas Argentinas', GLO: 'GOL', AZU: 'Azul', BWA: 'Caribbean Airlines', CAY: 'Cayman Airways', BHS: 'Bahamasair',
    JAL: 'Japan Airlines', ANA: 'ANA', KAL: 'Korean Air', CPA: 'Cathay Pacific', SIA: 'Singapore Airlines', QFA: 'Qantas',
    ANZ: 'Air New Zealand', AIC: 'Air India', ETH: 'Ethiopian', SAA: 'South African', CCA: 'Air China', CES: 'China Eastern',
    CSN: 'China Southern', EVA: 'EVA Air', CAL: 'China Airlines', PAL: 'Philippine Airlines', MAS: 'Malaysia', THA: 'Thai',
    NJE: 'NetJets', EJA: 'NetJets', XOJ: 'XOJet', LXJ: 'Flexjet', JTL: 'Jet Linx', VJA: 'Vista', WUP: 'Wheels Up',
    RCH: 'US Air Force (Air Mobility)', CNV: 'US Navy', PAT: 'US Army', CG: 'Coast Guard', NASA: 'NASA',
  };
  const TYPES = {
    A319: 'Airbus A319', A320: 'Airbus A320', A321: 'Airbus A321', A20N: 'Airbus A320neo', A21N: 'Airbus A321neo',
    A306: 'Airbus A300', A310: 'Airbus A310', A332: 'Airbus A330-200', A333: 'Airbus A330-300', A339: 'Airbus A330-900',
    A342: 'Airbus A340', A343: 'Airbus A340', A346: 'Airbus A340-600', A359: 'Airbus A350-900', A35K: 'Airbus A350-1000',
    A388: 'Airbus A380', A225: 'Antonov An-225', A124: 'Antonov An-124',
    B712: 'Boeing 717', B722: 'Boeing 727', B732: 'Boeing 737-200', B733: 'Boeing 737-300', B734: 'Boeing 737-400',
    B735: 'Boeing 737-500', B736: 'Boeing 737-600', B737: 'Boeing 737-700', B738: 'Boeing 737-800', B739: 'Boeing 737-900',
    B37M: 'Boeing 737 MAX 7', B38M: 'Boeing 737 MAX 8', B39M: 'Boeing 737 MAX 9', B3XM: 'Boeing 737 MAX 10',
    B741: 'Boeing 747-100', B742: 'Boeing 747-200', B743: 'Boeing 747-300', B744: 'Boeing 747-400', B748: 'Boeing 747-8',
    B752: 'Boeing 757-200', B753: 'Boeing 757-300', B762: 'Boeing 767-200', B763: 'Boeing 767-300', B764: 'Boeing 767-400',
    B772: 'Boeing 777-200', B773: 'Boeing 777-300', B77L: 'Boeing 777-200LR', B77W: 'Boeing 777-300ER', B778: 'Boeing 777-8', B779: 'Boeing 777-9',
    B788: 'Boeing 787-8 Dreamliner', B789: 'Boeing 787-9 Dreamliner', B78X: 'Boeing 787-10 Dreamliner',
    MD11: 'McDonnell Douglas MD-11', MD82: 'McDonnell Douglas MD-82', MD83: 'McDonnell Douglas MD-83', MD88: 'McDonnell Douglas MD-88', MD90: 'McDonnell Douglas MD-90',
    DC10: 'McDonnell Douglas DC-10', DC93: 'McDonnell Douglas DC-9',
    E170: 'Embraer 170', E175: 'Embraer 175', E75L: 'Embraer 175', E75S: 'Embraer 175', E190: 'Embraer 190', E195: 'Embraer 195',
    E290: 'Embraer E190-E2', E295: 'Embraer E195-E2', E135: 'Embraer ERJ-135', E145: 'Embraer ERJ-145', E45X: 'Embraer ERJ-145',
    CRJ2: 'Bombardier CRJ-200', CRJ7: 'Bombardier CRJ-700', CRJ9: 'Bombardier CRJ-900', CRJX: 'Bombardier CRJ-1000',
    BCS1: 'Airbus A220-100', BCS3: 'Airbus A220-300', DH8A: 'Dash 8-100', DH8B: 'Dash 8-200', DH8C: 'Dash 8-300', DH8D: 'Dash 8-400',
    AT43: 'ATR 42', AT45: 'ATR 42', AT46: 'ATR 42', AT72: 'ATR 72', AT75: 'ATR 72', AT76: 'ATR 72', SF34: 'Saab 340',
    C130: 'C-130 Hercules', C17: 'C-17 Globemaster', K35R: 'KC-135 Stratotanker', C5M: 'C-5 Galaxy', E3TF: 'E-3 Sentry', P8: 'P-8 Poseidon',
    C172: 'Cessna 172', C152: 'Cessna 152', C182: 'Cessna 182', C206: 'Cessna 206', C208: 'Cessna Caravan', C210: 'Cessna 210',
    PA28: 'Piper Cherokee', PA32: 'Piper Saratoga', PA34: 'Piper Seneca', PA44: 'Piper Seminole', P28A: 'Piper Cherokee', P28R: 'Piper Arrow',
    SR20: 'Cirrus SR20', SR22: 'Cirrus SR22', SR22T: 'Cirrus SR22', BE20: 'King Air 200', BE9L: 'King Air 90', B350: 'King Air 350', BE36: 'Beechcraft Bonanza',
    PC12: 'Pilatus PC-12', PC24: 'Pilatus PC-24', TBM7: 'TBM 700', TBM8: 'TBM 850', TBM9: 'TBM 900', DA40: 'Diamond DA40', DA42: 'Diamond DA42', DA62: 'Diamond DA62',
    C25A: 'Cessna Citation CJ2', C25B: 'Cessna Citation CJ3', C25C: 'Cessna Citation CJ4', C25M: 'Citation M2', C510: 'Citation Mustang', C525: 'Citation CJ1',
    C550: 'Citation II', C560: 'Citation V', C56X: 'Citation Excel', C650: 'Citation III', C680: 'Citation Sovereign', C68A: 'Citation Latitude', C700: 'Citation Longitude', C750: 'Citation X',
    CL30: 'Challenger 300', CL35: 'Challenger 350', CL60: 'Challenger 600', GL5T: 'Global 5000', GLEX: 'Global Express', GL7T: 'Global 7500',
    GLF2: 'Gulfstream II', GLF3: 'Gulfstream III', GLF4: 'Gulfstream IV', GLF5: 'Gulfstream V', GLF6: 'Gulfstream G650', GA5C: 'Gulfstream G500', GA6C: 'Gulfstream G600', G280: 'Gulfstream G280', G150: 'Gulfstream G150',
    E50P: 'Embraer Phenom 100', E55P: 'Embraer Phenom 300', E545: 'Embraer Legacy 450', E550: 'Embraer Legacy 500', PRM1: 'Premier 1', BE40: 'Beechjet 400',
    LJ31: 'Learjet 31', LJ35: 'Learjet 35', LJ45: 'Learjet 45', LJ60: 'Learjet 60', LJ75: 'Learjet 75', H25B: 'Hawker 800', H25C: 'Hawker 1000', HA4T: 'Hawker 4000',
    F900: 'Falcon 900', F2TH: 'Falcon 2000', FA7X: 'Falcon 7X', FA8X: 'Falcon 8X', FA50: 'Falcon 50', FA10: 'Falcon 10', FA20: 'Falcon 20',
    R44: 'Robinson R44', R22: 'Robinson R22', R66: 'Robinson R66', EC35: 'Airbus H135 helicopter', EC45: 'Airbus H145 helicopter', EC30: 'Airbus H130 helicopter', AS50: 'Airbus H125 helicopter',
    B06: 'Bell 206 helicopter', B407: 'Bell 407 helicopter', B429: 'Bell 429 helicopter', S76: 'Sikorsky S-76 helicopter', H60: 'Black Hawk helicopter', UH1: 'Huey helicopter', A139: 'AW139 helicopter',
    GLID: 'glider', BALL: 'balloon', PARA: 'paraglider', ULAC: 'ultralight', DRON: 'drone', SHIP: 'airship',
  };

  function airline(callsign) {
    const m = /^([A-Z]{3})(\d[\dA-Z]*)$/.exec(callsign || '');
    if (m && AIRLINES[m[1]]) return { name: AIRLINES[m[1]], code: m[1], number: m[2] };
    if (m) return { name: m[1], code: m[1], number: m[2] };
    if (/^N\d/.test(callsign || '')) return { name: 'Private plane', code: '', number: '' };
    return { name: callsign ? callsign : 'Unknown airline', code: '', number: '' };
  }
  function typeName(a) {
    if (TYPES[a.type]) return TYPES[a.type];
    if (a.desc) return a.desc.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    return a.type || 'plane';
  }
  function label(a) { return a.callsign || a.reg || a.hex.toUpperCase(); }

  // ------------------------------------------------------------------ util
  function bindRange(inputId, valueId, key, fmt) {
    const i = $(inputId), v = $(valueId);
    i.value = settings[key]; v.textContent = fmt(settings[key]);
    i.addEventListener('input', () => { settings[key] = Number(i.value); v.textContent = fmt(settings[key]); save(); });
  }
  function load(k, def) { try { return { ...def, ...(JSON.parse(localStorage.getItem(k) || '{}')) }; } catch { return { ...def }; } }
  function save() { try { localStorage.setItem('settings', JSON.stringify(settings)); } catch { /* private mode */ } }
  let hintTimer;
  function hint(msg, ms) { el.hint.textContent = msg; el.hint.hidden = false; clearTimeout(hintTimer); hintTimer = setTimeout(() => { el.hint.hidden = true; }, ms); }
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const wrap180 = (d) => ((d + 540) % 360) - 180;
  const numOr = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const fmtNum = (n) => n.toLocaleString('en-US');
  const norm = (v) => { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  function compass(az) { return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(az / 45) % 8]; }
})();
