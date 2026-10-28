/* Plane Transit prediction engine: where a plane appears from the observer, where
 * the moon or the sun is, and when (and how close) the two meet. Pure maths, no DOM,
 * no network. Shared by the page (app.js, loaded as a plain <script>) and the server
 * (serve.js's always-on watcher, via require) so both make the same prediction.
 *
 * Nothing here reads global settings: an observer is a `site` (makeSite), a body's
 * position is a `target` (bodyTarget), and a tracked aircraft is a plane record
 * (upsertPlane). All angles in degrees, distances in metres, speeds m/s. Heights are
 * metres above the WGS84 ellipsoid.
 * SUN SAFETY: predicting sun transits means aiming a camera at the sun. A certified
 * front-mounted solar filter is mandatory. */
(function (root, factory) {
  const A = root.Astronomy || (typeof require === 'function' ? require('./astronomy.browser.min.js') : null);
  const E = factory(A);
  if (typeof module === 'object' && module.exports) module.exports = E;
  else root.PlaneTransitEngine = E;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Astronomy) {
  'use strict';

  const PREDICT_S = 90;          // dead-reckoning horizon, seconds
  const STALE_MS = 30000;        // a plane not reported for this long is dropped
  const KM_PER_AU = 149597870.7;
  const FT = 0.3048, KT = 0.514444, FPM = 0.00508;
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const WGS_A = 6378137, WGS_E2 = 6.69437999014e-3;

  // The geometry of each target. The two angular radii land within 2% of each other
  // (~0.26 deg), which is why one set of thresholds serves both.
  const BODIES = {
    moon: { label: 'Moon', engine: 'Moon', radiusKm: 1737.4, hasIllum: true },
    sun: { label: 'Sun', engine: 'Sun', radiusKm: 695700, hasIllum: false },
  };

  // ---------- geodesy ----------
  function geodeticToECEF(lat, lon, h) {
    const s = Math.sin(lat * D2R), c = Math.cos(lat * D2R);
    const sl = Math.sin(lon * D2R), cl = Math.cos(lon * D2R);
    const N = WGS_A / Math.sqrt(1 - WGS_E2 * s * s);
    return [(N + h) * c * cl, (N + h) * c * sl, (N * (1 - WGS_E2) + h) * s];
  }

  // An observer. `elev` is the eye above sea level, `geoidM` sea level above the WGS84
  // ellipsoid. Aircraft GNSS heights (alt_geom) are above the ellipsoid; skipping the
  // geoid put an Amsterdam observer 43 m low — every plane drawn 43 m / range too
  // high (0.12 deg at 20 km, half a disc radius).
  function makeSite({ lat, lon, elev = 0, geoidM = 0 }) {
    const h = elev + geoidM;
    return { lat, lon, elev, geoidM, h,
      observer: new Astronomy.Observer(lat, lon, elev), ecef: geodeticToECEF(lat, lon, h) };
  }

  // Refraction. Sun/moon light crosses the whole atmosphere and is lifted by the full
  // astronomical refraction (~10' at 5 deg elevation). A plane's light only crosses
  // the air below it, so it gets a fraction: for refractivity falling off
  // exponentially with scale height H, a target dh above the observer is lifted by
  //   f(x) = 1 - e^-x - (1 - e^-x (1+x)) / x,   x = dh / H
  // of the full amount — ~6% at 1 km, ~17% at 3 km, ~43% at 10 km. The old
  // "refraction cancels" shortcut left low planes ~0.15 deg too high vs a low target.
  const REFR_SCALE_M = 8000;
  function refrShare(dh) {
    const x = Math.max(dh, 1) / REFR_SCALE_M, e = Math.exp(-x);
    return 1 - e - (1 - e * (1 + x)) / x;
  }

  // apparent az/el and range of a point at ellipsoidal height h, from the site
  function azElRange(site, lat, lon, h) {
    const [x, y, z] = geodeticToECEF(lat, lon, h);
    const dx = x - site.ecef[0], dy = y - site.ecef[1], dz = z - site.ecef[2];
    const sf = Math.sin(site.lat * D2R), cf = Math.cos(site.lat * D2R);
    const sl = Math.sin(site.lon * D2R), cl = Math.cos(site.lon * D2R);
    const E = -sl * dx + cl * dy;
    const N = -sf * cl * dx - sf * sl * dy + cf * dz;
    const U = cf * cl * dx + cf * sl * dy + sf * dz;
    const range = Math.hypot(E, N, U);
    const el = Math.asin(U / range) * R2D;
    return {
      az: (Math.atan2(E, N) * R2D + 360) % 360,
      el: el + Astronomy.Refraction('normal', el) * refrShare(h - site.h),
      range,
    };
  }

  // inverse: point at az/el/range from the site -> geodetic (used by mock mode).
  // Geometric: it ignores the plane's small refraction lift, so mock aim points sit
  // a few arcminutes high at low elevation. Harmless for a demo.
  function pointAt(site, az, el, range) {
    const E = range * Math.cos(el * D2R) * Math.sin(az * D2R);
    const N = range * Math.cos(el * D2R) * Math.cos(az * D2R);
    const U = range * Math.sin(el * D2R);
    const lat = site.lat + (N / 111320);
    const lon = site.lon + (E / (111320 * Math.cos(site.lat * D2R)));
    // curvature correction: a level path drops below the tangent plane
    const h = site.h + U + (E * E + N * N) / (2 * 6371e3);
    return { lat, lon, h };
  }

  function wrapDeg(d) { return ((d + 540) % 360) - 180; }

  function angularSep(az1, el1, az2, el2) {
    const s = Math.sin(el1 * D2R) * Math.sin(el2 * D2R) +
      Math.cos(el1 * D2R) * Math.cos(el2 * D2R) * Math.cos((az1 - az2) * D2R);
    return Math.acos(Math.min(1, Math.max(-1, s))) * R2D;
  }

  // ---------- target body (moon or sun) ----------
  function bodyAzEl(site, key, date) {
    const eq = Astronomy.Equator((BODIES[key] || BODIES.moon).engine, date, site.observer, true, true);
    const hor = Astronomy.Horizon(date, site.observer, eq.ra, eq.dec);   // geometric
    const el = hor.altitude + Astronomy.Refraction('normal', hor.altitude);   // as seen
    return { az: hor.azimuth, el, distKm: eq.dist * KM_PER_AU };
  }

  // Where the body is now, how big, and how it drifts (linear rates, fine over the
  // two-minute prediction window).
  function bodyTarget(site, key, date) {
    const B = BODIES[key] || BODIES.moon;
    const a = bodyAzEl(site, key, date);
    const b = bodyAzEl(site, key, new Date(date.getTime() + 120000));
    return {
      body: BODIES[key] ? key : 'moon',
      az: a.az, el: a.el,
      angR: Math.asin(B.radiusKm / a.distKm) * R2D,
      azRate: wrapDeg(b.az - a.az) / 120,
      elRate: (b.el - a.el) / 120,
      // phase is meaningless for the sun
      illum: B.hasIllum
        ? Astronomy.Illumination(Astronomy.Body[B.engine], date).phase_fraction : null,
      limb: B.hasIllum ? limbAngle(a, bodyAzEl(site, 'sun', date)) : null,
    };
  }
  // Direction of the sun as seen from the target, in the sky view's own frame: degrees
  // from "up" (towards the zenith) towards increasing azimuth (screen right). The bright
  // limb faces it, so this orients the phase. Great-circle bearing, with el as latitude
  // and az as longitude; fine with the sun below the horizon.
  function limbAngle(m, s) {
    const e1 = m.el * D2R, e2 = s.el * D2R, dA = wrapDeg(s.az - m.az) * D2R;
    return Math.atan2(Math.sin(dA) * Math.cos(e2),
      Math.cos(e1) * Math.sin(e2) - Math.sin(e1) * Math.cos(e2) * Math.cos(dA)) * R2D;
  }
  function targetAt(target, tSec) { // linear over the prediction window (fine for <2 min)
    return { az: target.az + target.azRate * tSec, el: target.el + target.elRate * tSec };
  }

  // ---------- plane ingestion ----------
  // One aggregator record → the fix the tracker flies, or null for anything it can't
  // fly (no position, on the ground, no speed/track/altitude). alt_geom is GNSS height
  // above the ellipsoid; alt_baro is pressure altitude, roughly above sea level, so it
  // needs the geoid added to share the frame.
  function aircraftFix(ac, geoidM, includeLow) {
    if (ac.lat == null || ac.lon == null) return null;
    if (ac.alt_baro === 'ground') return null;
    const geom = typeof ac.alt_geom === 'number';
    if (!geom && typeof ac.alt_baro !== 'number') return null;
    if (ac.gs == null || ac.track == null) return null;
    const altM = geom ? ac.alt_geom * FT : ac.alt_baro * FT + geoidM;
    if (!includeLow && altM - geoidM < 1000) return null;
    const vr = ((typeof ac.geom_rate === 'number') ? ac.geom_rate
              : (typeof ac.baro_rate === 'number') ? ac.baro_rate : 0) * FPM;
    return {
      hex: ac.hex, flight: ac.flight, type: typeof ac.t === 'string' ? ac.t : null,
      lat: ac.lat, lon: ac.lon, altM, gs: ac.gs * KT, track: ac.track, vr,
      ageS: ac.seen_pos == null ? 0 : ac.seen_pos, altSrc: geom ? 'geom' : 'baro',
      feed: ac._src || 'public',
    };
  }

  function upsertPlane(planes, f, nowMs) {
    let p = planes.get(f.hex);
    if (!p) { p = { hex: f.hex, hist: [] }; planes.set(f.hex, p); }
    // maneuver detection from recent track / vertical-rate changes
    const last = p.hist[p.hist.length - 1];
    if (!last || last.track !== f.track || last.vr !== f.vr) {
      p.hist.push({ track: f.track, vr: f.vr, t: nowMs });
      if (p.hist.length > 4) p.hist.shift();
    }
    let maneuvering = false;
    for (let i = 1; i < p.hist.length; i++) {
      if (Math.abs(wrapDeg(p.hist[i].track - p.hist[i - 1].track)) > 4 ||
          Math.abs(p.hist[i].vr - p.hist[i - 1].vr) > 3) maneuvering = true;
    }
    // A poll that returns the same position again still re-derives its timestamp
    // from seen_pos, and network latency makes that jitter by up to ~1 s — enough to
    // shove the dot and its line along by a second of flight. Latency can only make a
    // fix look newer than it is, so the earliest estimate of a given fix is the best.
    const posTime = nowMs - f.ageS * 1000;
    const sameFix = p.lat === f.lat && p.lon === f.lon && p.altM === f.altM;
    Object.assign(p, {
      flight: (f.flight || f.hex).trim(), type: f.type || p.type || null,
      lat: f.lat, lon: f.lon, altM: f.altM, altSrc: f.altSrc, feed: f.feed,
      gs: f.gs, track: f.track, vr: f.vr,
      posTime: sameFix ? Math.min(p.posTime, posTime) : posTime,
      lastSeen: nowMs, maneuvering,
    });
    return p;
  }

  function dropStalePlanes(planes, nowMs) {
    for (const [hex, p] of planes)
      if (nowMs - p.lastSeen > STALE_MS) planes.delete(hex);
  }

  // dead-reckoned geodetic position of plane p at dtS seconds after its fix
  function planeAt(p, dtS) {
    const vN = p.gs * Math.cos(p.track * D2R), vE = p.gs * Math.sin(p.track * D2R);
    const lat = p.lat + vN * dtS / 111320;
    const lon = p.lon + vE * dtS / (111320 * Math.cos(p.lat * D2R));
    return { lat, lon, h: p.altM + p.vr * dtS };
  }

  // ---------- prediction ----------
  // where plane p is t s from now (its fix being `age` s old), and how far that is
  // from where the target will be at the same moment
  function sepAt(site, target, p, age, t) {
    const pos = planeAt(p, age + t);
    const ae = azElRange(site, pos.lat, pos.lon, pos.h);
    const m = targetAt(target, t);
    ae.sep = angularSep(ae.az, ae.el, m.az, m.el);
    return ae;
  }

  // A closest approach still ahead and inside the window. At either end the "minimum"
  // is only where the search stopped: a plane that has passed, or is still coming.
  const realMin = t => t > 0.5 && t < PREDICT_S - 1;

  // Plane p against one target, `nowMs` being the wall-clock time t = 0 refers to.
  // Returns what the caller merges into its own record (the page) or keeps per body
  // (the server); p itself is not touched.
  function predictPlane(site, target, p, nowMs) {
    const age = (nowMs - p.posTime) / 1000;
    // Everything drawn as "now" is the dead-reckoned position, never the raw fix.
    // The fix is `age` s old; drawing it left the dot behind the start of its own
    // predicted line by age × speed — degrees, for a close plane with a stale fix.
    const cur = sepAt(site, target, p, age, 0);

    // ADS-B velocity is good to ~1-2 m/s in steady flight; turns are the real risk
    const growth = p.maneuvering ? 25 : 3;    // m per second of extrapolation
    const errAt = (t, range) => Math.atan2(60 + p.gs * 0.3 + growth * (age + t), range) * R2D;
    const samples = [];
    let best = null;
    for (let t = 0; t <= PREDICT_S; t += 1) {
      const s = sepAt(site, target, p, age, t);
      if (t % 2 === 0) samples.push({ t, az: s.az, el: s.el, range: s.range, delta: errAt(t, s.range) });
      if (!best || s.sep < best.sep) best = { t, sep: s.sep };
    }
    // Refine to 0.05 s around the coarse minimum. At 1 s steps a close jet moves
    // ~1.8 deg per step against a 0.53 deg disc, so a dead-centre transit landing
    // between two samples was reported as a 1.4 R near miss — and made no sound.
    const t0 = best.t;
    for (let i = -20; i <= 20; i++) {
      const t = t0 + i * 0.05;
      if (t < 0 || t > PREDICT_S) continue;
      const sep = sepAt(site, target, p, age, t).sep;
      if (sep < best.sep) best = { t, sep };
    }
    const closest = sepAt(site, target, p, age, best.t);
    const r = target.angR;
    // nominal disc entry / exit, to 0.02 s: the page's audio cue holds a tone between
    // them. Searched no further than that tone can reach (±2.5 s).
    let tIn = null, tOut = null;
    if (best.sep <= r) {
      tIn = tOut = best.t;
      while (tIn > best.t - 2.5 && sepAt(site, target, p, age, tIn - 0.02).sep <= r) tIn -= 0.02;
      while (tOut < best.t + 2.5 && sepAt(site, target, p, age, tOut + 0.02).sep <= r) tOut += 0.02;
    }
    const delta = errAt(best.t, closest.range);
    // Which way the plane crosses the sky at closest approach, relative to the target
    // (the camera follows it): degrees from "up" towards screen right, the sky view's
    // own frame. With the plane off screen, this is what says which side of the frame
    // it will come in from — the opposite one.
    const a = sepAt(site, target, p, age, best.t - 0.5), b = sepAt(site, target, p, age, best.t + 0.5);
    const dir = Math.atan2(wrapDeg(b.az - a.az) * Math.cos(closest.el * D2R) - target.azRate * Math.cos(target.el * D2R),
      b.el - a.el - target.elRate) * R2D;
    return {
      az: cur.az, el: cur.el, range: cur.range, sepNow: cur.sep, age,
      trust: (age < 6 && !p.maneuvering) ? 'high' : (age < 15 ? 'med' : 'low'),
      // transit = nominal path crosses the disc; near = close pass, or a possible
      // transit once position uncertainty is taken into account
      klass: (best.sep <= r && closest.el > 0) ? 'transit'
        : ((best.sep <= 3 * r || best.sep <= r + delta) && closest.el > 0) ? 'near' : 'far',
      pred: {
        at: nowMs,                     // wall-clock ms that t = 0 refers to
        samples, tBest: best.t, tMin: Math.round(best.t),
        azMin: closest.az, elMin: closest.el, rangeMin: closest.range,
        sepMin: best.sep, delta, tIn, tOut, dir,
        // the same uncertainty without the extrapolation ahead: what the fix itself is
        // good for at that range
        delta0: errAt(0, closest.range),
      },
    };
  }

  return {
    PREDICT_S, STALE_MS, KM_PER_AU, FT, KT, FPM, D2R, R2D, WGS_A, WGS_E2, BODIES,
    geodeticToECEF, makeSite, refrShare, azElRange, pointAt, wrapDeg, angularSep,
    bodyAzEl, bodyTarget, limbAngle, targetAt,
    aircraftFix, upsertPlane, dropStalePlanes, planeAt, sepAt, realMin, predictPlane,
  };
});
