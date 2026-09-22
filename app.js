/* Plane Transit — predicts planes passing in front of (or near) the moon or the sun.
 * All angles in degrees unless noted. Distances in meters, speeds m/s.
 * Frame note: everything is placed where it APPEARS — the target with full
 * astronomical refraction, each plane with only the share of it that the air
 * below the plane produces. Heights are metres above the WGS84 ellipsoid.
 * SUN SAFETY: sun mode aims a camera at the sun. A certified front-mounted solar
 * filter is mandatory; the UI carries a banner saying so. */
'use strict';

// ---------- config ----------
// No default location: a guessed one gives confidently wrong predictions, so the
// first run opens the setup panel and nothing runs until a position is set.
const DEFAULTS = {
  lat: null, lon: null,
  groundM: 0, aboveM: 1.5,               // elev = ground above sea level + eye above ground
  elev: 1.5,
  geoidM: null, geoidAuto: true,         // geoid above WGS84 ellipsoid, from geoid.js
  body: 'moon',
  source: 'adsbfi', radiusNm: 30, spanDeg: 20, includeLow: false, showNear: true,
  sound: true, soundVol: 1,
  showMap: null,                         // null = by screen width
};
const LS_KEY = 'plane-transit-cfg';
let saved = {};
try { saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (e) { /* keep defaults */ }
let cfg = { ...DEFAULTS, ...saved };
const hasLocation = () => Number.isFinite(cfg.lat) && Number.isFinite(cfg.lon);
// settings saved before the ground/above split and the geoid model: the old single
// elevation becomes the ground figure, and a hand-entered geoid that agrees with the
// model (NL's 43 m) switches to the model
if (!('groundM' in saved) && hasLocation()) {
  cfg.groundM = cfg.elev; cfg.aboveM = 0;
  cfg.geoidAuto = !Number.isFinite(cfg.geoidM) || Math.abs(cfg.geoidM - geoidAt(cfg.lat, cfg.lon)) < 2;
}
if (hasLocation() && (cfg.geoidAuto || !Number.isFinite(cfg.geoidM))) cfg.geoidM = geoidAt(cfg.lat, cfg.lon);
if (!Number.isFinite(cfg.geoidM)) cfg.geoidM = 0;
if (cfg.showMap == null) cfg.showMap = window.innerWidth > 800;
function saveCfg() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch (e) { /* private mode */ }
}

const PREDICT_S = 90;          // dead-reckoning horizon, seconds
const HIDDEN_GRACE_MS = 60000; // keep polling this long after the page is hidden
const BELOW_HORIZON_DEG = -2;  // target this far down = nothing to photograph
const GHOST_S = 10;            // how long a superseded fix's predicted track stays visible
const FETCH_MS = 3000;
const KM_PER_AU = 149597870.7;
const FT = 0.3048, KT = 0.514444, FPM = 0.00508;

// Everything that differs between the two targets lives here; the rest of the
// tool only talks to `target`, which is whichever one is selected. The two
// angular radii land within 2% of each other (~0.26 deg), which is why one set
// of view spans, ring sizes and alert thresholds serves both.
// `sky` is the canvas half of the theme; the DOM half is the `body.sun` block in
// index.html. Both halves must be switched together or the page and the canvas
// disagree — moon reads cold (blue-black, steel greys), sun reads warm (dark
// sepia, sand, faded-ink reds), so the two modes are never mistaken for each other.
const BODIES = {
  moon: {
    label: 'Moon', engine: 'Moon', radiusKm: 1737.4,
    disc: '#f5e9c8', accent: '#ffd97a', glow: null, hasIllum: true,   // glow: "r,g,b"
    sky: {
      grid: '#1d2431', gridText: '#5a6377',
      ground: 'rgba(40,60,45,0.25)', horizon: '#3f5a46', horizonText: '#5f7a66',
      transit: '#ff5c5c', near: '#ffa94d', far: '#7d8aa5',
      mapFilter: 'invert(1) hue-rotate(180deg) brightness(0.85) saturate(0.4)',
      mapDim: 'rgba(11,14,20,0.35)', mapRing: 'rgba(150,160,180,0.35)',
      mapText: '#aab3c5', observer: '#ffffff',
      unlit: 'rgba(245,233,200,0.13)',   // the moon's dark part: faint, so the disc stays whole
    },
  },
  sun: {
    label: 'Sun', engine: 'Sun', radiusKm: 695700,
    disc: '#ffd24a', accent: '#f0b429', glow: '255,190,60', hasIllum: false,
    sky: {
      grid: '#302416', gridText: '#836d47',
      ground: 'rgba(84,68,36,0.32)', horizon: '#67532f', horizonText: '#9a8352',
      // vermillion over amber over sand: the same urgency ladder as the moon's
      // red/orange/grey, re-picked so nothing goes muddy against a sepia ground
      transit: '#ff6448', near: '#ffa33c', far: '#8a7a5e',
      mapFilter: 'invert(1) hue-rotate(180deg) brightness(0.85) sepia(0.6) saturate(0.8)',
      mapDim: 'rgba(21,16,10,0.38)', mapRing: 'rgba(190,168,120,0.32)',
      mapText: '#bda87e', observer: '#fff3dc',
    },
  },
};
const body = () => BODIES[cfg.body] || BODIES.moon;

let observer = hasLocation() ? new Astronomy.Observer(cfg.lat, cfg.lon, cfg.elev) : null;

// ---------- state ----------
const planes = new Map();      // hex -> plane record
let target = null;             // {az, el, angR, illum (null for the sun), azRate, elRate}
let srcStatus = { ok: false, msg: 'connecting…', t: 0 };
let mockWorld = [];            // truth records for mock planes

// ---------- geodesy ----------
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const WGS_A = 6378137, WGS_E2 = 6.69437999014e-3;

function geodeticToECEF(lat, lon, h) {
  const s = Math.sin(lat * D2R), c = Math.cos(lat * D2R);
  const sl = Math.sin(lon * D2R), cl = Math.cos(lon * D2R);
  const N = WGS_A / Math.sqrt(1 - WGS_E2 * s * s);
  return [(N + h) * c * cl, (N + h) * c * sl, (N * (1 - WGS_E2) + h) * s];
}
// Aircraft GNSS heights (alt_geom) are above the WGS84 ellipsoid; the observer's
// elevation is entered above sea level. Around Amsterdam sea level sits ~43 m above
// the ellipsoid, and skipping that put the observer 43 m low — every plane drawn
// 43 m / range too high (0.12 deg at 20 km, half a disc radius).
const obsHeight = () => cfg.elev + cfg.geoidM;
let obsECEF = hasLocation() ? geodeticToECEF(cfg.lat, cfg.lon, obsHeight()) : null;

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

// apparent az/el and range of a point at ellipsoidal height h, from the observer
function azElRange(lat, lon, h) {
  const [x, y, z] = geodeticToECEF(lat, lon, h);
  const dx = x - obsECEF[0], dy = y - obsECEF[1], dz = z - obsECEF[2];
  const sf = Math.sin(cfg.lat * D2R), cf = Math.cos(cfg.lat * D2R);
  const sl = Math.sin(cfg.lon * D2R), cl = Math.cos(cfg.lon * D2R);
  const E = -sl * dx + cl * dy;
  const N = -sf * cl * dx - sf * sl * dy + cf * dz;
  const U = cf * cl * dx + cf * sl * dy + sf * dz;
  const range = Math.hypot(E, N, U);
  const el = Math.asin(U / range) * R2D;
  return {
    az: (Math.atan2(E, N) * R2D + 360) % 360,
    el: el + Astronomy.Refraction('normal', el) * refrShare(h - obsHeight()),
    range,
  };
}

// inverse: point at az/el/range from observer -> geodetic (used by mock mode).
// Geometric: it ignores the plane's small refraction lift, so mock aim points sit
// a few arcminutes high at low elevation. Harmless for a demo.
function pointAt(az, el, range) {
  const E = range * Math.cos(el * D2R) * Math.sin(az * D2R);
  const N = range * Math.cos(el * D2R) * Math.cos(az * D2R);
  const U = range * Math.sin(el * D2R);
  const lat = cfg.lat + (N / 111320);
  const lon = cfg.lon + (E / (111320 * Math.cos(cfg.lat * D2R)));
  // curvature correction: a level path drops below the tangent plane
  const h = obsHeight() + U + (E * E + N * N) / (2 * 6371e3);
  return { lat, lon, h };
}

function wrapDeg(d) { return ((d + 540) % 360) - 180; }

function angularSep(az1, el1, az2, el2) {
  const s = Math.sin(el1 * D2R) * Math.sin(el2 * D2R) +
    Math.cos(el1 * D2R) * Math.cos(el2 * D2R) * Math.cos((az1 - az2) * D2R);
  return Math.acos(Math.min(1, Math.max(-1, s))) * R2D;
}

// ---------- target body (moon or sun) ----------
function bodyAzEl(date, key = cfg.body) {
  const eq = Astronomy.Equator((BODIES[key] || BODIES.moon).engine, date, observer, true, true);
  const hor = Astronomy.Horizon(date, observer, eq.ra, eq.dec);   // geometric
  const el = hor.altitude + Astronomy.Refraction('normal', hor.altitude);   // as seen
  return { az: hor.azimuth, el, distKm: eq.dist * KM_PER_AU };
}

function updateTarget(now) {
  const B = body();
  const a = bodyAzEl(now);
  const b = bodyAzEl(new Date(now.getTime() + 120000));
  target = {
    az: a.az, el: a.el,
    angR: Math.asin(B.radiusKm / a.distKm) * R2D,
    azRate: wrapDeg(b.az - a.az) / 120,
    elRate: (b.el - a.el) / 120,
    // phase is meaningless for the sun, so that header stat is hidden there
    illum: B.hasIllum
      ? Astronomy.Illumination(Astronomy.Body[B.engine], now).phase_fraction : null,
    limb: B.hasIllum ? limbAngle(a, bodyAzEl(now, 'sun')) : null,
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
function targetAt(tSec) { // linear over the prediction window (fine for <2 min)
  return { az: target.az + target.azRate * tSec, el: target.el + target.elRate * tSec };
}

// ---------- plane ingestion ----------
function upsertPlane(hex, flight, lat, lon, altM, gs, track, vr, ageS, altSrc, feed) {
  let p = planes.get(hex);
  if (!p) { p = { hex, hist: [], trail: [], ghosts: [] }; planes.set(hex, p); }
  // maneuver detection from recent track / vertical-rate changes
  const last = p.hist[p.hist.length - 1];
  if (!last || last.track !== track || last.vr !== vr) {
    p.hist.push({ track, vr, t: Date.now() });
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
  const now = Date.now(), posTime = now - ageS * 1000;
  const sameFix = p.lat === lat && p.lon === lon && p.altM === altM;
  Object.assign(p, {
    flight: (flight || hex).trim(), lat, lon, altM, altSrc, feed, gs, track, vr,
    posTime: sameFix ? Math.min(p.posTime, posTime) : posTime,
    lastSeen: now, maneuvering,
  });
}

function dropStalePlanes() {
  const now = Date.now();
  for (const [hex, p] of planes)
    if (now - p.lastSeen > 30000) planes.delete(hex);
}

// dead-reckoned geodetic position of plane p at ageS seconds after its fix
function planeAt(p, dtS) {
  const vN = p.gs * Math.cos(p.track * D2R), vE = p.gs * Math.sin(p.track * D2R);
  const lat = p.lat + vN * dtS / 111320;
  const lon = p.lon + vE * dtS / (111320 * Math.cos(p.lat * D2R));
  return { lat, lon, h: p.altM + p.vr * dtS };
}

// ---------- prediction ----------
// where plane p is t s from now (its fix being `age` s old), and how far that is
// from where the target will be at the same moment
function sepAt(p, age, t) {
  const pos = planeAt(p, age + t);
  const ae = azElRange(pos.lat, pos.lon, pos.h);
  const m = targetAt(t);
  ae.sep = angularSep(ae.az, ae.el, m.az, m.el);
  return ae;
}

function predict(p, nowMs) {
  const age = (nowMs - p.posTime) / 1000;
  // Everything drawn as "now" is the dead-reckoned position, never the raw fix.
  // The fix is `age` s old; drawing it left the dot behind the start of its own
  // predicted line by age × speed — degrees, for a close plane with a stale fix.
  const cur = sepAt(p, age, 0);
  p.az = cur.az; p.el = cur.el; p.range = cur.range; p.sepNow = cur.sep;
  p.age = age;

  p.trail.push({ az: cur.az, el: cur.el, t: nowMs });
  while (p.trail.length && nowMs - p.trail[0].t > 20000) p.trail.shift();

  // ADS-B velocity is good to ~1-2 m/s in steady flight; turns are the real risk
  const growth = p.maneuvering ? 25 : 3;    // m per second of extrapolation
  const errAt = (t, range) => Math.atan2(60 + p.gs * 0.3 + growth * (age + t), range) * R2D;
  const samples = [];
  let best = null;
  for (let t = 0; t <= PREDICT_S; t += 1) {
    const s = sepAt(p, age, t);
    if (t % 2 === 0) samples.push({ t, az: s.az, el: s.el, delta: errAt(t, s.range) });
    if (!best || s.sep < best.sep) best = { t, sep: s.sep };
  }
  // Refine to 0.05 s around the coarse minimum. At 1 s steps a close jet moves
  // ~1.8 deg per step against a 0.53 deg disc, so a dead-centre transit landing
  // between two samples was reported as a 1.4 R near miss — and made no sound.
  const t0 = best.t;
  for (let i = -20; i <= 20; i++) {
    const t = t0 + i * 0.05;
    if (t < 0 || t > PREDICT_S) continue;
    const sep = sepAt(p, age, t).sep;
    if (sep < best.sep) best = { t, sep };
  }
  const closest = sepAt(p, age, best.t);
  const r = target.angR;
  // nominal disc entry / exit, to 0.02 s: the audio cue holds a tone between them.
  // Searched no further than the tone can reach (toneWindow caps it at ±2.5 s).
  let tIn = null, tOut = null;
  if (best.sep <= r) {
    tIn = tOut = best.t;
    while (tIn > best.t - 2.5 && sepAt(p, age, tIn - 0.02).sep <= r) tIn -= 0.02;
    while (tOut < best.t + 2.5 && sepAt(p, age, tOut + 0.02).sep <= r) tOut += 0.02;
  }
  const delta = errAt(best.t, closest.range);
  p.pred = {
    at: nowMs,                     // wall-clock ms that t = 0 refers to
    samples, tBest: best.t, tMin: Math.round(best.t),
    azMin: closest.az, elMin: closest.el, sepMin: best.sep, delta, tIn, tOut,
  };
  p.trust = (age < 6 && !p.maneuvering) ? 'high' : (age < 15 ? 'med' : 'low');
  // transit = nominal path crosses the disc; near = close pass, or a possible
  // transit once position uncertainty is taken into account
  p.klass = (best.sep <= r && closest.el > 0) ? 'transit'
          : ((best.sep <= 3 * r || best.sep <= r + delta) && closest.el > 0) ? 'near' : 'far';

  // Prediction history. Each distinct fix gives its own track, fixed in wall-clock
  // time; tracks from the last GHOST_S seconds are drawn fading behind the current
  // one. A steady plane's tracks lie on top of each other; feed jitter or a turn
  // fans them out — the spread is the deviation you can actually see.
  const fixKey = [p.lat, p.lon, p.altM, p.gs, p.track, p.vr].join();
  if (fixKey !== p.fixKey) {
    p.fixKey = fixKey;
    if (p.curve) p.ghosts.push(p.curve);
    p.curve = { seen: nowMs, pts: samples.map(s => ({ T: nowMs + s.t * 1000, az: s.az, el: s.el })) };
  }
  p.ghosts = p.ghosts.filter(g => nowMs - g.seen < GHOST_S * 1000);
}

// ---------- live data ----------
// Nothing is fetched unless someone is actually watching: the aggregator should cost
// nothing while this page sits in a background tab or the target is down. The server
// polls upstream only when asked (see serve.js), so not asking is the whole mechanism.
let hiddenSince = 0;
document.addEventListener('visibilitychange', () => {
  hiddenSince = document.hidden ? Date.now() : 0;
  if (!document.hidden) fetchLive();            // back on screen: refresh at once
});

function pollPause() {
  // A countdown that is already running keeps its data alive: you may well have
  // switched to the camera app for the last 30 seconds of it.
  if (hiddenSince && Date.now() - hiddenSince > HIDDEN_GRACE_MS && !armed.size)
    return 'page hidden';
  if (target && target.el < BELOW_HORIZON_DEG)
    return `${body().label.toLowerCase()} below horizon`;
  return null;
}

let backoffUntil = 0;
let fetchGen = 0;              // bumped by restartFetch(); stale responses are dropped
async function fetchLive() {
  if (!hasLocation() || Date.now() < backoffUntil) return;
  const paused = pollPause();
  if (paused) {
    planes.clear();
    srcStatus = { idle: true, msg: `paused — ${paused}`, t: Date.now() };
    return;
  }
  // Routed through serve.js because the ADS-B APIs don't send CORS headers. The
  // aggregator only needs the area, not the doorstep: the position goes out rounded
  // to 0.01 deg (≤ 0.8 km off) and the radius grows by 1 nm to cover the difference.
  const url = `/api/planes?src=${cfg.source}&lat=${cfg.lat.toFixed(2)}&lon=${cfg.lon.toFixed(2)}&r=${cfg.radiusNm + 1}`;
  const gen = fetchGen;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    // restartFetch() ran while this was in flight (new source or position): its
    // answer belongs to the old settings, and would mix real planes into mock ones
    if (gen !== fetchGen) return;
    if (resp.status === 429) {   // rate limited: pause polling briefly
      backoffUntil = Date.now() + 15000;
      srcStatus = { ok: false, msg: 'rate limited (429), pausing 15 s', t: Date.now() };
      return;
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (gen !== fetchGen) return;
    const list = data.ac || data.aircraft || [];   // adsb.lol uses "ac", adsb.fi "aircraft"
    const meta = data._meta || {};
    for (const ac of list) {
      if (ac.lat == null || ac.lon == null) continue;
      if (ac.alt_baro === 'ground') continue;
      // alt_geom is GNSS height above the ellipsoid; alt_baro is pressure altitude,
      // roughly above sea level, so it needs the geoid added to share the frame
      const geom = typeof ac.alt_geom === 'number';
      if (!geom && typeof ac.alt_baro !== 'number') continue;
      if (ac.gs == null || ac.track == null) continue;
      const altM = geom ? ac.alt_geom * FT : ac.alt_baro * FT + cfg.geoidM;
      if (!cfg.includeLow && altM - cfg.geoidM < 1000) continue;
      const vr = ((typeof ac.geom_rate === 'number') ? ac.geom_rate
                : (typeof ac.baro_rate === 'number') ? ac.baro_rate : 0) * FPM;
      upsertPlane(ac.hex, ac.flight, ac.lat, ac.lon, altM,
                  ac.gs * KT, ac.track, vr, ac.seen_pos ?? 0, geom ? 'geom' : 'baro',
                  ac._src || 'public');
    }
    // the server merges a local receiver in per aircraft when one is configured
    const L = meta.local;
    const localBit = L && (L.fresher || L.extra) ? ` · local ${L.fresher}↑ ${L.extra}+` : '';
    srcStatus = meta.publicError
      ? { idle: true, msg: `local receiver only (${list.length} ac) — ${meta.publicError}`, t: Date.now() }
      : { ok: true, msg: `live ok (${list.length} ac)${localBit}`, t: Date.now() };
  } catch (e) {
    srcStatus = { ok: false, msg: `fetch failed: ${e.message}`, t: Date.now() };
  }
}

// ---------- mock data ----------
// Each mock plane is defined by one reference point it passes through (`ref`, at
// `tRef` s after spawning) and flies a constant-rate turn through it (`omega`
// deg/s, 0 = straight). Crossing planes use the aim point on/near the disc as the
// reference, so a turning plane still really does pass there — but straight-line
// dead reckoning from its early fixes drifts, which is what the fading prediction
// lines exist to show.
function spawnMockPlane(crossing) {
  const id = 'mk' + Math.random().toString(16).slice(2, 6);
  const v = 120 + Math.random() * 130;
  const vr = (Math.random() - 0.5) * 6;
  const omega = Math.random() < 0.4
    ? (Math.random() < 0.5 ? -1 : 1) * (0.15 + Math.random() * 0.45) : 0;
  const hRef = Math.random() * 360;
  let ref, tRef;
  if (crossing && target.el > 2) {
    tRef = 25 + Math.random() * 50;
    const range = 8000 + Math.random() * 22000;
    const tg = targetAt(tRef);               // not `target`: that is the body
    // Offset the aim point ACROSS the plane's apparent motion. An azimuth-only
    // offset merely changes when a plane crosses — and with the target low, most
    // planes move sideways across the sky — so nearly every one was a transit.
    const [ux, uy] = skyDir({ ref: pointAt(tg.az, tg.el, range), tRef, hRef, omega, v, vr });
    const miss = (Math.random() - 0.5) * 4 * target.angR;  // some hit, some near-miss
    ref = pointAt(tg.az - miss * uy / Math.cos(tg.el * D2R), tg.el + miss * ux, range);
  } else {
    tRef = 0;
    const az = Math.random() * 360, el = 5 + Math.random() * 40;
    ref = pointAt(az, el, 10000 + Math.random() * 30000);
  }
  mockWorld.push({ id, flight: 'MOCK' + id.slice(2).toUpperCase(),
    ref, tRef, hRef, omega, v, vr, t0: Date.now() });
}

// true state of mock plane m, s seconds after it spawned
function mockTruth(m, s) {
  const u = s - m.tRef;
  const hdg = m.hRef + m.omega * u;
  let N, E;
  if (m.omega === 0) {
    N = m.v * Math.cos(m.hRef * D2R) * u;
    E = m.v * Math.sin(m.hRef * D2R) * u;
  } else {                                   // integral of v·(cos, sin)(heading)
    const w = m.omega * D2R;
    N = m.v * (Math.sin(hdg * D2R) - Math.sin(m.hRef * D2R)) / w;
    E = -m.v * (Math.cos(hdg * D2R) - Math.cos(m.hRef * D2R)) / w;
  }
  return {
    lat: m.ref.lat + N / 111320,
    lon: m.ref.lon + E / (111320 * Math.cos(cfg.lat * D2R)),
    h: m.ref.h + m.vr * u,
    track: ((hdg % 360) + 360) % 360,
  };
}

// unit vector of mock plane m's apparent motion at its reference point, in sky
// degrees (x = along azimuth, scaled by cos el; y = up)
function skyDir(m) {
  const a = mockTruth(m, m.tRef - 0.5), b = mockTruth(m, m.tRef + 0.5);
  const pa = azElRange(a.lat, a.lon, a.h), pb = azElRange(b.lat, b.lon, b.h);
  const x = wrapDeg(pb.az - pa.az) * Math.cos(pa.el * D2R), y = pb.el - pa.el;
  const n = Math.hypot(x, y) || 1;
  return [x / n, y / n];
}

function updateMock() {
  if (mockWorld.length < 5 && Math.random() < 0.25)
    spawnMockPlane(Math.random() < 0.6);
  const now = Date.now();
  mockWorld = mockWorld.filter(m => now - m.t0 < 180000);
  const jitter = () => (Math.random() - 0.5) * 3e-5;
  for (const m of mockWorld) {
    // simulated feed latency: report where the plane WAS `age` s ago, stamped as
    // such. (Reporting the current truth with an old stamp made dead reckoning
    // overshoot by age × speed, so the dot jittered by degrees from tick to tick.)
    const age = 1 + Math.random() * 2;
    const s = mockTruth(m, (now - m.t0) / 1000 - age);
    upsertPlane(m.id, m.flight, s.lat + jitter(), s.lon + jitter(), s.h,
                m.v, s.track, m.vr, age, 'mock', 'mock');
  }
  srcStatus = { ok: true, msg: `mock (${mockWorld.length} planes)`, t: now };
}

// ---------- canvas ----------
const canvas = document.getElementById('sky');
const ctx = canvas.getContext('2d');

function project(az, el, cx, cy, ppd) {
  return [
    cx + wrapDeg(az - target.az) * Math.cos(target.el * D2R) * ppd,
    cy - (el - target.el) * ppd,
  ];
}

function render() {
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
    canvas.width = W * dpr; canvas.height = H * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2;
  const ppd = Math.min(W, H) / cfg.spanDeg;
  const B = body(), sky = B.sky;

  // grid
  const step = cfg.spanDeg <= 20 ? 5 : 10;
  ctx.strokeStyle = sky.grid; ctx.fillStyle = sky.gridText;
  ctx.lineWidth = 1; ctx.font = '11px system-ui';
  const azHalf = cfg.spanDeg / (2 * Math.cos(target.el * D2R));
  for (let a = Math.floor((target.az - azHalf) / step) * step; a <= target.az + azHalf; a += step) {
    const [x] = project(a, target.el, cx, cy, ppd);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    ctx.fillText(`${((a % 360) + 360) % 360}°`, x + 3, H - 6);
  }
  for (let e = Math.floor((target.el - cfg.spanDeg / 2) / step) * step; e <= target.el + cfg.spanDeg / 2; e += step) {
    const [, y] = project(target.az, e, cx, cy, ppd);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    ctx.fillText(`${e}°`, 6, y - 3);
  }

  // horizon
  const [, yHor] = project(target.az, 0, cx, cy, ppd);
  if (yHor < H + 50) {
    ctx.fillStyle = sky.ground;
    ctx.fillRect(0, yHor, W, H - yHor);
    ctx.strokeStyle = sky.horizon; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, yHor); ctx.lineTo(W, yHor); ctx.stroke();
    ctx.fillStyle = sky.horizonText; ctx.fillText('horizon', W - 55, yHor - 5);
  }

  // target drift line (where it will be in 5 min) + 3-radii ring
  const rDisc = Math.max(target.angR * ppd, 2.5);
  const m5 = targetAt(300);
  const [mx5, my5] = project(m5.az, m5.el, cx, cy, ppd);
  ctx.strokeStyle = B.disc + '59'; ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(mx5, my5); ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = B.disc + '66';
  ctx.beginPath(); ctx.arc(cx, cy, 3 * target.angR * ppd, 0, 2 * Math.PI); ctx.stroke();

  // planes: paths first, then the target disc over them, then dots + labels on top
  const colors = sky;   // keyed by klass: transit / near / far
  // with "show near misses" off, near passes are drawn as ordinary far traffic
  const kOf = p => (p.klass === 'near' && !cfg.showNear) ? 'far' : p.klass;
  ctx.font = '12px system-ui';
  for (const p of planes.values()) {
    if (!p.pred) continue;
    const k = kOf(p);
    const col = colors[k];
    // trail
    ctx.strokeStyle = col + '55'; ctx.lineWidth = 1;
    ctx.beginPath();
    p.trail.forEach((s, i) => {
      const [x, y] = project(s.az, s.el, cx, cy, ppd);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
    // earlier fixes' predictions, from now onward, fading with the age of the fix.
    // Drawn under the current line, so they only show where they disagree with it.
    const nowMs = p.pred.at;
    ctx.lineWidth = 1;
    for (const g of p.ghosts) {
      const fade = 1 - (nowMs - g.seen) / (GHOST_S * 1000);
      const i = g.pts.findIndex(s => s.T > nowMs);
      if (fade <= 0 || i < 1) continue;
      const a = g.pts[i - 1], b = g.pts[i], f = (nowMs - a.T) / (b.T - a.T);
      ctx.strokeStyle = col + Math.round(fade * (k === 'far' ? 70 : 150)).toString(16).padStart(2, '0');
      ctx.beginPath();
      ctx.moveTo(...project(a.az + wrapDeg(b.az - a.az) * f, a.el + (b.el - a.el) * f, cx, cy, ppd));
      for (let j = i; j < g.pts.length; j++) ctx.lineTo(...project(g.pts[j].az, g.pts[j].el, cx, cy, ppd));
      ctx.stroke();
    }
    // predicted path with ETA ticks
    ctx.strokeStyle = col; ctx.lineWidth = k === 'far' ? 1 : 1.8;
    ctx.beginPath();
    p.pred.samples.forEach((s, i) => {
      const [x, y] = project(s.az, s.el, cx, cy, ppd);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = col;
    for (const s of p.pred.samples) {
      if (s.t === 30 || s.t === 60) {
        const [x, y] = project(s.az, s.el, cx, cy, ppd);
        ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
        ctx.fillText(`+${s.t}s`, x + 4, y - 4);
      }
    }
    // uncertainty circle + miss-distance label at closest approach
    if (k !== 'far') {
      const [x, y] = project(p.pred.azMin, p.pred.elMin, cx, cy, ppd);
      ctx.setLineDash([3, 3]); ctx.strokeStyle = col + '99';
      ctx.beginPath(); ctx.arc(x, y, Math.max(p.pred.delta * ppd, 3), 0, 2 * Math.PI);
      ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = col;
      ctx.fillText(`${(p.pred.sepMin / target.angR).toFixed(1)}R @+${p.pred.tMin}s`, x + 6, y - 6);
    }
  }

  // target disc above the path clutter so it stays visible.
  // The sun gets a soft halo out to ~3 radii: it distinguishes the two modes at a
  // glance and roughly matches the glare you actually see around the filtered disc.
  if (B.glow) {
    const rGlow = Math.max(rDisc * 3, 12);
    const g = ctx.createRadialGradient(cx, cy, rDisc, cx, cy, rGlow);
    g.addColorStop(0, `rgba(${B.glow},0.30)`);
    g.addColorStop(1, `rgba(${B.glow},0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, rGlow, 0, 2 * Math.PI); ctx.fill();
  }
  if (target.limb == null) {
    ctx.fillStyle = B.disc;
    ctx.beginPath(); ctx.arc(cx, cy, rDisc, 0, 2 * Math.PI); ctx.fill();
  } else drawPhase(cx, cy, rDisc, target.illum, target.limb, B.disc, sky.unlit);

  for (const p of planes.values()) {
    if (!p.pred) continue;
    const [x, y] = project(p.az, p.el, cx, cy, ppd);
    ctx.fillStyle = colors[kOf(p)];
    ctx.beginPath(); ctx.arc(x, y, 3.5, 0, 2 * Math.PI); ctx.fill();
    ctx.fillText(`${p.flight} ${(p.altM / 1000).toFixed(1)}km`, x + 6, y + 12);
  }

  if (cfg.showMap) renderMap(colors, kOf);
}

// The moon as it looks: a faint full disc (a plane still crosses the dark part, it
// just will not show as a silhouette there), then the lit part. Drawn in a frame
// rotated so +x points at the sun: the half disc facing it, closed by the terminator,
// an ellipse of half-width r·|2k − 1| — bulging away from the sun when gibbous
// (k > ½), towards it when a crescent.
function drawPhase(cx, cy, r, k, limbDeg, lit, unlit) {
  ctx.fillStyle = unlit;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.fill();
  if (k < 0.005) return;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((limbDeg - 90) * D2R);   // limb 0° = up = canvas −y
  ctx.fillStyle = lit;
  ctx.beginPath();
  ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2);
  const rx = r * Math.abs(2 * k - 1);
  if (k >= 0.5) ctx.ellipse(0, 0, rx, r, 0, Math.PI / 2, 3 * Math.PI / 2, false);
  else ctx.ellipse(0, 0, rx, r, 0, Math.PI / 2, -Math.PI / 2, true);
  ctx.fill();
  ctx.restore();
}

// ---------- top-down map inset (OpenStreetMap tiles + overlay) ----------
const mapCanvas = document.getElementById('map');
const mctx = mapCanvas.getContext('2d');
const MERC_R = 6378137;
const mercX = lon => MERC_R * lon * D2R;
const mercY = lat => MERC_R * Math.log(Math.tan(Math.PI / 4 + lat * D2R / 2));
const tileCache = new Map();   // "z/x/y" -> Image (CORS-enabled so canvas stays clean)

function getTile(z, x, y) {
  const n = 1 << z;
  x = ((x % n) + n) % n;
  if (y < 0 || y >= n) return null;
  const key = `${z}/${x}/${y}`;
  let img = tileCache.get(key);
  if (!img) {
    if (tileCache.size > 120) tileCache.clear();
    img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = `https://tile.openstreetmap.org/${key}.png`;
    tileCache.set(key, img);
  }
  return (img.complete && img.naturalWidth) ? img : null;
}

function renderMap(colors, kOf) {
  const dpr = window.devicePixelRatio || 1;
  const S = mapCanvas.clientWidth;                 // css square
  if (mapCanvas.width !== S * dpr) { mapCanvas.width = S * dpr; mapCanvas.height = S * dpr; }
  mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mctx.clearRect(0, 0, S, S);
  const B = body(), sky = B.sky;
  const c = S / 2;
  const Rm = cfg.radiusNm * 1852;                  // map edge = search radius
  const cosLat = Math.cos(cfg.lat * D2R);
  // px per Mercator meter; Mercator inflates ground distance by 1/cos(lat)
  const scale = (c - 6) / (Rm / cosLat);
  const toXY = (lat, lon) =>
    [c + (mercX(lon) - mercX(cfg.lon)) * scale, c - (mercY(lat) - mercY(cfg.lat)) * scale];

  // OSM tiles, darkened to match the UI
  const z = Math.max(3, Math.min(17, Math.round(Math.log2(2 * Math.PI * MERC_R * scale / 320))));
  const tilePx = 2 * Math.PI * MERC_R * scale / (1 << z);   // drawn size of one tile
  const tx0 = (mercX(cfg.lon) - c / scale + Math.PI * MERC_R) / (2 * Math.PI * MERC_R) * (1 << z);
  const ty0 = (Math.PI * MERC_R - (mercY(cfg.lat) + c / scale)) / (2 * Math.PI * MERC_R) * (1 << z);
  mctx.save();
  mctx.filter = sky.mapFilter;   // sun mode adds sepia so the tiles match the UI
  for (let i = Math.floor(tx0); (i - tx0) * tilePx < S; i++)
    for (let j = Math.floor(ty0); (j - ty0) * tilePx < S; j++) {
      const img = getTile(z, i, j);
      if (img) mctx.drawImage(img, (i - tx0) * tilePx, (j - ty0) * tilePx, tilePx + 0.5, tilePx + 0.5);
    }
  mctx.restore();
  mctx.fillStyle = sky.mapDim;                   // dim for overlay contrast
  mctx.fillRect(0, 0, S, S);

  // range rings
  const ringKm = Rm > 60000 ? 25 : 10;
  mctx.strokeStyle = sky.mapRing; mctx.fillStyle = sky.mapText;
  mctx.font = '9px system-ui'; mctx.lineWidth = 1;
  for (let r = ringKm * 1000; r <= Rm; r += ringKm * 1000) {
    const rp = (r / cosLat) * scale;
    mctx.beginPath(); mctx.arc(c, c, rp, 0, 2 * Math.PI); mctx.stroke();
    mctx.fillText(`${r / 1000}`, c + rp - 12, c - 3);
  }
  mctx.fillText('N', c - 3, 10);
  mctx.fillText('km', S - 18, c - 3);
  const osm = '© OpenStreetMap contributors';
  mctx.fillText(osm, S - mctx.measureText(osm).width - 4, S - 5);

  // observation cone: the azimuth range covered by the sky view
  const azHalf = Math.min(cfg.spanDeg / (2 * Math.cos(target.el * D2R)), 90);
  const a0 = (target.az - azHalf - 90) * D2R, a1 = (target.az + azHalf - 90) * D2R;
  mctx.fillStyle = B.accent + '1a';
  mctx.beginPath(); mctx.moveTo(c, c); mctx.arc(c, c, c - 10, a0, a1); mctx.closePath();
  mctx.fill();

  // target bearing ray
  const mx = c + Math.sin(target.az * D2R) * (c - 10);
  const my = c - Math.cos(target.az * D2R) * (c - 10);
  mctx.strokeStyle = B.disc + '99'; mctx.setLineDash([4, 3]);
  mctx.beginPath(); mctx.moveTo(c, c); mctx.lineTo(mx, my); mctx.stroke();
  mctx.setLineDash([]);
  mctx.fillStyle = B.disc;
  mctx.beginPath(); mctx.arc(mx, my, 3, 0, 2 * Math.PI); mctx.fill();

  // planes: predicted ground track (+90 s) and current dot
  for (const p of planes.values()) {
    if (!p.pred) continue;
    const col = colors[kOf(p)];
    mctx.strokeStyle = col + 'aa'; mctx.lineWidth = 1;
    mctx.beginPath();
    for (let t = 0; t <= PREDICT_S; t += 15) {
      const pos = planeAt(p, p.age + t);
      const [x, y] = toXY(pos.lat, pos.lon);
      t ? mctx.lineTo(x, y) : mctx.moveTo(x, y);
    }
    mctx.stroke();
    const now = planeAt(p, p.age);            // same dead-reckoned "now" as the sky view
    const [x, y] = toXY(now.lat, now.lon);
    mctx.fillStyle = col;
    mctx.beginPath(); mctx.arc(x, y, 2.5, 0, 2 * Math.PI); mctx.fill();
  }

  // observer
  mctx.fillStyle = sky.observer;
  mctx.beginPath(); mctx.arc(c, c, 2.5, 0, 2 * Math.PI); mctx.fill();
}

// ---------- tables & header ----------
const $ = id => document.getElementById(id);
function fmtSep(sep) { return (sep / target.angR).toFixed(1) + ' R'; }

function renderTables() {
  const list = [...planes.values()].filter(p => p.pred);

  const passes = list.filter(p => cfg.showNear
      ? p.pred.sepMin < 5 * target.angR && p.pred.samples.some(s => s.el > 0)
      : p.klass === 'transit')
    .sort((a, b) => a.pred.tMin - b.pred.tMin);
  const pb = $('passTable').tBodies[0];
  pb.innerHTML = passes.map(p => `<tr class="${p.klass}">
    <td>${p.flight}${alerted.has(p.hex) ? ' ♪' : ''}</td><td>${p.pred.tMin}s</td>
    <td>${fmtSep(p.pred.sepMin)}</td><td>${fmtSep(p.pred.delta)}</td>
    <td>${p.trust}${p.maneuvering ? ' ⚠' : ''}</td></tr>`).join('');
  $('passEmpty').style.display = passes.length ? 'none' : '';

  const all = list.sort((a, b) => a.sepNow - b.sepNow).slice(0, 25);
  const ab = $('allTable').tBodies[0];
  ab.innerHTML = all.map(p => `<tr class="${p.klass === 'far' ? 'dim' : p.klass}">
    <td>${p.flight}</td><td>${p.sepNow.toFixed(1)}°</td>
    <td>${(p.altM / 1000).toFixed(1)}km</td>
    <td>${(p.range / 1000).toFixed(0)}km</td>
    <td>${p.age.toFixed(0)}s</td></tr>`).join('');
  $('allEmpty').style.display = all.length ? 'none' : '';

  const B = body();
  document.title = `Plane Transit · ${B.label}`;
  for (const b of $('bodySeg').children) b.classList.toggle('active', b.dataset.body === cfg.body);
  // where to point, in words a photographer uses; the precise numbers are one hover away
  $('bodyPos').textContent = `${compass(target.az)} ${target.az.toFixed(0)}° · `
    + (target.el >= 0 ? `${target.el.toFixed(1)}° up` : `${(-target.el).toFixed(1)}° below`);
  $('posStat').title = `${B.label}: azimuth ${target.az.toFixed(1)}°, elevation `
    + `${target.el.toFixed(1)}°, diameter ${(2 * target.angR).toFixed(2)}°`
    + (skyTimes.set && target.el >= 0 ? `\nsets ${fmtWhen(skyTimes.set.date)}` : '');
  $('illumStat').style.display = B.hasIllum ? '' : 'none';
  if (B.hasIllum) $('bodyIllum').textContent = (target.illum * 100).toFixed(0) + '%';
  $('sunWarn').style.display = cfg.body === 'sun' ? '' : 'none';
  document.body.classList.toggle('sun', cfg.body === 'sun');
  $('planeCount').textContent = `· ${planes.size}`;
  const st = $('srcStatus');
  $('srcText').textContent = srcStatus.msg;
  st.title = srcStatus.msg;
  st.className = 'stat ' + (srcStatus.ok ? 'ok' : srcStatus.idle ? '' : 'err');
  renderSoundBtn();
  $('clock').textContent = new Date().toLocaleTimeString();
  renderPassLog();
  renderSkyState();
  pickCardPlane(passes);
}

// ---------- next-pass card ----------
// The one thing to read from a metre away with the camera up: which plane, how long,
// how good. The countdown's lead plane if one is armed, else the first transit (or
// near miss, when those are shown). Redrawn at 10 Hz so the seconds run smoothly.
let cardPlane = null;
function pickCardPlane(passes) {
  let best = null;
  for (const hex of armed) {
    const p = planes.get(hex);
    if (p && p.pred && (!best || p.pred.tBest < best.pred.tBest)) best = p;
  }
  cardPlane = best
    || passes.find(p => p.klass === 'transit' || (cfg.showNear && p.klass === 'near')) || null;
  renderNextCard();
}
function renderNextCard() {
  const card = $('nextCard'), p = cardPlane;
  if (!p || !p.pred || !target || planes.get(p.hex) !== p) { card.hidden = true; return; }
  const pr = p.pred, now = (Date.now() - pr.at) / 1000, s = pr.tBest - now;
  if (s < -3) { card.hidden = true; return; }
  const onDisc = pr.tIn != null && now >= pr.tIn - 0.1 && now <= pr.tOut + 0.1;
  card.hidden = false;
  card.className = 'glass ' + p.klass;
  $('ncFlight').textContent = p.flight;
  $('ncBadge').textContent = p.klass === 'transit' ? 'TRANSIT' : 'NEAR MISS';
  $('ncArmed').textContent = armed.has(p.hex) ? '♪ countdown' : '';
  $('ncEta').textContent = onDisc ? 'NOW' : s > 0 ? `in ${s < 10 ? s.toFixed(1) : Math.round(s)} s` : 'passed';
  $('ncSub').textContent = `miss ${(pr.sepMin / target.angR).toFixed(1)} R ± `
    + `${(pr.delta / target.angR).toFixed(1)} · trust ${p.trust}${p.maneuvering ? ' ⚠ turning' : ''}`
    + ` · ${(p.range / 1000).toFixed(0)} km away, ${(p.altM / 1000).toFixed(1)} km up`;
}

// ---------- when the target is down ----------
// An empty sky with "paused" says nothing useful. Say when it is worth coming back:
// rise time and direction, and when it clears GOOD_EL (above most rooftops and
// haze). Searched at most once a minute; the header tooltip borrows the set time.
const GOOD_EL = 10;
let skyTimes = { at: 0 };
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
function compass(az) { return COMPASS[Math.round((((az % 360) + 360) % 360) / 22.5) % 16]; }
function fmtWhen(d) {
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 864e5);
  return days === 0 ? t : days === 1 ? `${t} tomorrow` : `${t} ${d.toLocaleDateString([], { weekday: 'short' })}`;
}
function updateSkyTimes() {
  const now = Date.now(), key = [cfg.body, cfg.lat, cfg.lon].join();
  if (skyTimes.key === key && now - skyTimes.at < 60000) return;
  const B = body(), t = new Date(now);
  const find = fn => { try { return fn(); } catch (e) { return null; } };
  const rise = find(() => Astronomy.SearchRiseSet(B.engine, observer, +1, t, 3));
  skyTimes = {
    key, at: now, rise,
    set: find(() => Astronomy.SearchRiseSet(B.engine, observer, -1, t, 3)),
    good: find(() => Astronomy.SearchAltitude(B.engine, observer, +1, t, 3, GOOD_EL)),
    riseAz: rise ? bodyAzEl(rise.date).az : null,
  };
}
function renderSkyState() {
  const box = $('skyState');
  if (!hasLocation()) { box.hidden = true; return; }
  updateSkyTimes();
  if (target.el >= 0) { box.hidden = true; return; }
  const B = body(), T = skyTimes;
  const other = cfg.body === 'moon' ? 'sun' : 'moon';
  const otherEl = bodyAzEl(new Date(), other).el;
  const html = [`<h3>${B.label} is below the horizon</h3>`];
  html.push(T.rise
    ? `<p>Rises <b>${fmtWhen(T.rise.date)}</b> in the <b>${compass(T.riseAz)}</b> (${T.riseAz.toFixed(0)}°)</p>`
    : `<p>It does not rise in the next 3 days here.</p>`);
  if (T.good && (!T.rise || T.good.date > T.rise.date))
    html.push(`<p>${GOOD_EL}° up — clear of most rooftops — by <b>${fmtWhen(T.good.date)}</b></p>`);
  if (B.hasIllum) html.push(`<p>${(target.illum * 100).toFixed(0)}% lit</p>`);
  html.push(`<p>Not fetching planes until then.</p>`);
  if (otherEl > 3) html.push(`<div class="row"><button type="button" data-switch="${other}">`
    + `Switch to the ${BODIES[other].label.toLowerCase()} — ${otherEl.toFixed(0)}° up now</button></div>`);
  const out = html.join('');
  if (box.dataset.html !== out) { box.innerHTML = out; box.dataset.html = out; }   // keep the button clickable
  box.hidden = false;
}
$('skyState').addEventListener('click', e => {
  const b = e.target.closest('[data-switch]');
  if (b) chooseBody(b.dataset.switch);
});

// ---------- target choice (sun asks first) ----------
// Sun mode aims a camera at the sun: on top of the permanent banner, the first
// switch in each browser session asks for the filter explicitly.
const SUN_ACK_KEY = 'plane-transit-sunack';
function sunAcked() { try { return sessionStorage.getItem(SUN_ACK_KEY) === '1'; } catch (e) { return false; } }
function chooseBody(b) {
  if (b === 'sun' && !sunAcked()) { askSun(); return; }
  setBody(b);
}
function setBody(b) {
  if (b === cfg.body) { tick(); return; }
  cfg.body = b;
  saveCfg();
  // a different target is a different geometry: nothing already announced for the
  // old body should stay announced (or keep its ♪) against the new one
  alerted.clear(); resetCountdown();
  if (started) { updateTarget(new Date()); tick(); fetchLive(); }
}
function askSun() {
  $('sunAckBox').checked = false; $('sunAckOk').disabled = true;
  $('sunAck').hidden = false;
}
$('bodySeg').addEventListener('click', e => {
  const b = e.target.closest('[data-body]');
  if (b) chooseBody(b.dataset.body);
});
$('sunAckBox').addEventListener('change', () => { $('sunAckOk').disabled = !$('sunAckBox').checked; });
$('sunAckOk').addEventListener('click', () => {
  try { sessionStorage.setItem(SUN_ACK_KEY, '1'); } catch (e) { /* asked again next time */ }
  $('sunAck').hidden = true;
  setBody('sun');
});
$('sunAckCancel').addEventListener('click', () => {
  $('sunAck').hidden = true;
  if (cfg.body === 'sun') setBody('moon');
});

// ---------- sky view controls ----------
// Zoom and the near-miss filter are used mid-session, so they live on the view.
const SPANS = [10, 20, 40, 90];
function setSpan(dir) {
  const i = SPANS.indexOf(cfg.spanDeg);
  cfg.spanDeg = SPANS[Math.max(0, Math.min(SPANS.length - 1, (i < 0 ? 1 : i) + dir))];
  saveCfg(); renderSkyCtl();
  if (started) render();
}
function renderSkyCtl() {
  $('spanVal').textContent = cfg.spanDeg + '°';
  $('spanIn').disabled = cfg.spanDeg === SPANS[0];
  $('spanOut').disabled = cfg.spanDeg === SPANS[SPANS.length - 1];
  $('btnNear').classList.toggle('on', cfg.showNear);
  $('btnMapToggle').classList.toggle('on', cfg.showMap);
  $('map').hidden = !cfg.showMap;
}
$('spanIn').addEventListener('click', () => setSpan(-1));
$('spanOut').addEventListener('click', () => setSpan(+1));
let wheelAcc = 0;   // trackpads send a stream of small deltas: one step per ~a notch
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  wheelAcc += e.deltaY;
  if (Math.abs(wheelAcc) < 60) return;
  setSpan(Math.sign(wheelAcc)); wheelAcc = 0;
}, { passive: false });
$('btnNear').addEventListener('click', () => {
  cfg.showNear = !cfg.showNear; saveCfg(); renderSkyCtl();
  if (started) tick();
});
$('btnMapToggle').addEventListener('click', () => {
  cfg.showMap = !cfg.showMap; saveCfg(); renderSkyCtl();
  if (started) render();
});
$('btnLegend').addEventListener('click', () => {
  $('legend').hidden = !$('legend').hidden;
  $('btnLegend').classList.toggle('on', !$('legend').hidden);
});

// ---------- sound button (header) ----------
function renderSoundBtn() {
  const b = $('soundBtn'), running = audioCtx && audioCtx.state === 'running';
  b.className = !cfg.sound ? 'off' : running ? '' : 'locked';
  b.textContent = !cfg.sound ? '🔇 off' : running ? '🔊 on' : '🔊 tap to enable';
  b.title = !cfg.sound ? 'Sound cue is off — click to turn it on'
    : running ? 'Sound cue is on — click to turn it off'
    : 'Browsers block sound until you press something — click to enable it';
}
$('soundBtn').addEventListener('click', () => {
  const running = audioCtx && audioCtx.state === 'running';
  if (!cfg.sound) cfg.sound = true;
  else if (running) cfg.sound = false;
  ensureAudio();
  $('cfgSound').checked = cfg.sound;
  applyCfg();
  renderSoundBtn();
});

// ---------- main loops ----------
function tick() {
  if (!started) return;            // no position yet: the setup panel is open
  const now = new Date();
  updateTarget(now);
  if (cfg.source === 'mock') updateMock();
  dropStalePlanes();
  for (const p of planes.values()) predict(p, now.getTime());
  checkAlerts();
  render();
  renderTables();
}

let fetchTimer = null;
function restartFetch() {
  clearInterval(fetchTimer);
  fetchGen++;
  planes.clear(); mockWorld = [];
  resetCountdown();
  if (cfg.source !== 'mock') {
    fetchLive();
    fetchTimer = setInterval(fetchLive, FETCH_MS);
  }
}

// ---------- setup & settings ----------
// One panel: opened as a three-step setup on the first run (nothing runs until a
// position is set) and as Settings from the ⚙ button later. Every field applies as
// soon as it changes; there is no separate Apply.
let started = false, lastFeed = '';
const feedKey = () => [cfg.lat, cfg.lon, cfg.source, cfg.radiusNm, cfg.includeLow].join();

function start() {
  started = true;
  lastFeed = feedKey();
  updateTarget(new Date());
  restartFetch();
  syncWakeLock();
  tick();
  if (cfg.body === 'sun' && !sunAcked()) askSun();
}

function loadCfgUI() {
  $('cfgLat').value = hasLocation() ? cfg.lat : '';
  $('cfgLon').value = hasLocation() ? cfg.lon : '';
  $('cfgGround').value = cfg.groundM; $('cfgAbove').value = cfg.aboveM;
  $('cfgGeoid').value = cfg.geoidM.toFixed(1); $('cfgGeoidAuto').checked = cfg.geoidAuto;
  $('cfgGeoid').disabled = cfg.geoidAuto;
  $('cfgSource').value = cfg.source; $('cfgRadius').value = cfg.radiusNm;
  $('cfgLowAlt').checked = cfg.includeLow;
  $('cfgSound').checked = cfg.sound;
  for (const b of $('volSeg').children) b.classList.toggle('active', +b.dataset.vol === cfg.soundVol);
  $('eyeElev').textContent = +cfg.elev.toFixed(1);
}

// cfg → everything derived from it. Handlers write cfg, then call this.
function applyCfg() {
  if (hasLocation() && cfg.geoidAuto) cfg.geoidM = +geoidAt(cfg.lat, cfg.lon).toFixed(1);
  cfg.elev = (cfg.groundM || 0) + (cfg.aboveM || 0);
  saveCfg();
  loadCfgUI();
  $('btnSetupDone').disabled = !hasLocation();
  renderSoundBtn();
  if (!hasLocation()) return;
  observer = new Astronomy.Observer(cfg.lat, cfg.lon, cfg.elev);
  obsECEF = geodeticToECEF(cfg.lat, cfg.lon, obsHeight());
  syncWakeLock();
  if (!started) return;
  updateTarget(new Date());
  if (feedKey() !== lastFeed) { lastFeed = feedKey(); restartFetch(); }   // display-only changes keep the planes
  tick();
}

function openSetup(first) {
  const dlg = $('setup').querySelector('.dialog');
  dlg.classList.toggle('first', first);
  $('setupTitle').textContent = first ? 'Set up Plane Transit' : 'Settings';
  $('setupLead').hidden = !first;
  $('btnSetupClose').hidden = first;
  $('btnSetupDone').textContent = first ? 'Start watching' : 'Done';
  $('btnSetupDone').disabled = !hasLocation();
  $('btnGeo').hidden = !window.isSecureContext || !navigator.geolocation;
  loadCfgUI();
  $('setup').hidden = false;
  showPicker();
}
function closeSetup() {
  if (!hasLocation()) return;
  $('setup').hidden = true;
  if (!started) start();
}
$('btnSettings').addEventListener('click', () => openSetup(false));
$('btnSetupClose').addEventListener('click', closeSetup);
$('btnSetupDone').addEventListener('click', closeSetup);
$('setup').addEventListener('click', e => { if (e.target === $('setup')) closeSetup(); });
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$('sunAck').hidden) $('sunAckCancel').click();
  else if (!$('setup').hidden) closeSetup();
  else $('legend').hidden = true;
});

function geoNote(msg, tone) {
  const n = $('geoNote');
  n.textContent = msg;
  n.className = 'note' + (tone ? ' ' + tone : '');
}

// Every way of giving a position ends here — GPS, a pasted link, a tap on the map,
// the lat/lon fields — and re-derives what follows from it: geoid, ground height,
// the picker map.
function setLocation(lat, lon) {
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) {   // also false for NaN
    geoNote('That is not a valid position.', 'bad');
    return false;
  }
  cfg.lat = +lat.toFixed(6); cfg.lon = +lon.toFixed(6);
  applyCfg();
  showPicker();
  lookupGround();
  return true;
}

// Ground height from a terrain model (Copernicus 90 m DEM via open-meteo.com: free, no
// key, sends CORS headers), so nobody has to know their elevation. Asked once per
// position change, never while watching. Overwrites a hand-typed ground figure only
// when the position itself changes.
let groundReq = 0;
function lookupGround() {
  const id = ++groundReq, lat = cfg.lat, lon = cfg.lon;
  $('groundNote').textContent = 'looking up…';
  fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`,
    { signal: AbortSignal.timeout(8000) })
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
    .then(d => {
      if (id !== groundReq) return;
      const h = d.elevation && d.elevation[0];
      if (!Number.isFinite(h)) throw new Error('no data');
      cfg.groundM = Math.round(h);
      applyCfg();
      $('groundNote').textContent = 'from terrain data (open-meteo.com) — correct it if you know better';
    })
    .catch(() => { if (id === groundReq) $('groundNote').textContent = 'lookup failed — enter it by hand (0 is fine near the coast)'; });
}

// Coordinates as people actually have them: "51.4778, -0.0014", "51°28'40"N 0°00'05"W",
// or a Google Maps / OpenStreetMap / Apple Maps / geo: link.
function parseLatLon(text) {
  let s = text.trim();
  try { s = decodeURIComponent(s); } catch (e) { /* keep as is */ }
  const ok = (la, lo) => (Math.abs(la) <= 90 && Math.abs(lo) <= 180 ? [la, lo] : null);
  const N = '(-?\\d{1,3}(?:\\.\\d+)?)';
  let m;
  // Google place links carry the pin as !3d…!4d…; the @… part is only the viewport
  if ((m = s.match(new RegExp(`!3d${N}!4d${N}`)))) return ok(+m[1], +m[2]);
  if ((m = s.match(new RegExp(`mlat=${N}.*?mlon=${N}`)))) return ok(+m[1], +m[2]);
  if ((m = s.match(new RegExp(`#map=\\d+/${N}/${N}`)))) return ok(+m[1], +m[2]);
  if ((m = s.match(new RegExp(`[?&](?:q|query|ll|sll|daddr|center|coordinate)=${N}\\s*,\\s*${N}`)))) return ok(+m[1], +m[2]);
  if ((m = s.match(new RegExp(`@${N},${N}`)))) return ok(+m[1], +m[2]);
  // degrees[/minutes/seconds] with a hemisphere letter, in either order
  const dms = [...s.matchAll(/([NSEW])?\s*(\d{1,3}(?:\.\d+)?)\s*°\s*(?:(\d{1,2}(?:\.\d+)?)\s*['′’]\s*)?(?:(\d{1,2}(?:\.\d+)?)\s*(?:["″”]|''))?\s*([NSEW])?/gi)]
    .filter(x => x[1] || x[5]);
  if (dms.length >= 2) {
    let la = null, lo = null;
    for (const x of dms.slice(0, 2)) {
      const h = (x[1] || x[5]).toUpperCase();
      const v = (+x[2] + (+x[3] || 0) / 60 + (+x[4] || 0) / 3600) * (h === 'S' || h === 'W' ? -1 : 1);
      if (h === 'N' || h === 'S') la = v; else lo = v;
    }
    if (la != null && lo != null) return ok(la, lo);
  }
  // plain decimals, optionally with hemisphere letters: "51.48 N, 0.01 W"
  const nums = [...s.matchAll(/(-?\d{1,3}\.\d+)\s*([NSEW])?/gi)];
  if (nums.length >= 2) {
    const v = nums.slice(0, 2).map(x => +x[1] * (/[SW]/i.test(x[2] || '') ? -1 : 1));
    if (/[EW]/i.test(nums[0][2] || '') && /[NS]/i.test(nums[1][2] || '')) v.reverse();
    return ok(v[0], v[1]);
  }
  return null;
}
let pasteTimer = null;   // typed by hand: wait for a pause, not every keystroke
$('locPaste').addEventListener('input', e => {
  clearTimeout(pasteTimer);
  pasteTimer = setTimeout(usePaste, e.inputType === 'insertFromPaste' ? 0 : 600);
});
function usePaste() {
  const t = $('locPaste').value;
  if (t.trim().length < 5) return;
  const ll = parseLatLon(t);
  if (ll && setLocation(ll[0], ll[1]))
    geoNote(`Got ${ll[0].toFixed(5)}, ${ll[1].toFixed(5)} — check the pin below.`, 'good');
  else geoNote('No coordinates found in that yet. Try "51.4778, -0.0014" or a map link.', 'bad');
}

// Accuracy is the whole question here: every ~200 m of position error sideways to the
// target is about a second of transit timing, and a wifi-only fix is often worse than
// that. So ask for GPS, report what came back, and show the pin for a final nudge.
let gpsAcc = null;
$('btnGeo').addEventListener('click', () => {
  geoNote('asking for a GPS fix…');
  navigator.geolocation.getCurrentPosition(pos => {
    const c = pos.coords, acc = Math.round(c.accuracy);
    gpsAcc = c.accuracy;
    setLocation(c.latitude, c.longitude);
    geoNote(`position ±${acc} m` + (acc > 50
      ? ` — ≈${(acc / 200).toFixed(1)} s of possible timing error. Go outside or wait for GPS and retry, or tap the map where you stand.`
      : ' — good.'), acc > 50 ? 'bad' : 'good');
  }, err => geoNote(`location failed: ${err.message}. Paste coordinates or a map link instead.`, 'bad'),
  { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
});

$('cfgLat').addEventListener('change', () => {
  const la = parseFloat($('cfgLat').value), lo = parseFloat($('cfgLon').value);
  if (Number.isFinite(la) && Number.isFinite(lo)) { gpsAcc = null; setLocation(la, lo); }
});
$('cfgLon').addEventListener('change', () => $('cfgLat').dispatchEvent(new Event('change')));
// Open the position on OpenStreetMap at street level, marker on the spot, so a wrong
// position is obvious at a glance — the same ~200 m that costs a second of timing is
// a whole block on the map.
$('btnMap').addEventListener('click', () => {
  if (!hasLocation()) { geoNote('Set a position first.', 'bad'); return; }
  const la = cfg.lat.toFixed(5), lo = cfg.lon.toFixed(5);
  window.open(`https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=18/${la}/${lo}`,
    '_blank', 'noopener');
});

$('cfgGround').addEventListener('change', () => {
  cfg.groundM = parseFloat($('cfgGround').value) || 0;
  $('groundNote').textContent = '';
  applyCfg();
});
$('cfgAbove').addEventListener('change', () => { cfg.aboveM = Math.max(0, parseFloat($('cfgAbove').value) || 0); applyCfg(); });
for (const b of document.querySelectorAll('[data-above]'))
  b.addEventListener('click', () => { cfg.aboveM = +b.dataset.above; applyCfg(); });
$('cfgGeoidAuto').addEventListener('change', () => { cfg.geoidAuto = $('cfgGeoidAuto').checked; applyCfg(); });
$('cfgGeoid').addEventListener('change', () => {
  const g = parseFloat($('cfgGeoid').value);
  if (Number.isFinite(g)) { cfg.geoidM = g; cfg.geoidAuto = false; }
  applyCfg();
});
$('cfgSource').addEventListener('change', () => { cfg.source = $('cfgSource').value; applyCfg(); });
$('cfgRadius').addEventListener('change', () => { cfg.radiusNm = parseInt($('cfgRadius').value, 10); applyCfg(); });
$('cfgLowAlt').addEventListener('change', () => { cfg.includeLow = $('cfgLowAlt').checked; applyCfg(); });
$('cfgSound').addEventListener('change', () => { cfg.sound = $('cfgSound').checked; ensureAudio(); applyCfg(); });
$('volSeg').addEventListener('click', e => {
  const b = e.target.closest('[data-vol]');
  if (b) { cfg.soundVol = +b.dataset.vol; applyCfg(); }
});
// doubles as the gesture that unlocks audio, so the cue can be proven before
// going out — a silent alert you only discover during the transit is useless
$('btnSoundTest').addEventListener('click', () => {
  const ok = chime(HEADS_UP, 0.06);
  if (ok) {                                // then a ~4 s compressed countdown
    const ac = audioCtx;
    let t = ac.currentTime + 0.9, gap = 0.6;
    while (gap >= 0.15) { blip(ac, t); t += gap; gap *= 0.8; }
    holdTone(ac, t, 0.7);
  }
  $('soundTestNote').textContent = ok
    ? 'Played heads-up → countdown blips → on-disc tone. Too quiet? Pick a louder level and test again.'
    : 'No audio: the browser is blocking it, or this device has no output.';
});
document.addEventListener('click', ensureAudio);   // browsers need a gesture first

// ---------- position picker map ----------
// OSM tiles around the position with a pin; a tap moves the pin there. For the last
// correction a GPS fix or a pasted link can't give: which side of the building.
const pick = $('pick'), pctx = pick.getContext('2d');
let pickZ = 16, pickRetry = null;
function showPicker() {
  $('pickWrap').hidden = $('pickHint').hidden = !hasLocation();
  drawPicker();
}
function pickWorld() {   // centre in world pixels at zoom pickZ (256 px tiles)
  const n = 256 * (1 << pickZ);
  return [(cfg.lon + 180) / 360 * n,
    (1 - Math.log(Math.tan(Math.PI / 4 + cfg.lat * D2R / 2)) / Math.PI) / 2 * n, n];
}
function drawPicker() {
  clearTimeout(pickRetry);
  if ($('setup').hidden || !hasLocation()) return;
  const dpr = window.devicePixelRatio || 1, W = pick.clientWidth, H = pick.clientHeight;
  if (pick.width !== W * dpr || pick.height !== H * dpr) { pick.width = W * dpr; pick.height = H * dpr; }
  pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  pctx.fillStyle = '#222'; pctx.fillRect(0, 0, W, H);
  const [wx, wy] = pickWorld(), sky = body().sky;
  let missing = false;
  pctx.save();
  pctx.filter = sky.mapFilter;
  for (let tx = Math.floor((wx - W / 2) / 256); tx * 256 < wx + W / 2; tx++)
    for (let ty = Math.floor((wy - H / 2) / 256); ty * 256 < wy + H / 2; ty++) {
      const img = getTile(pickZ, tx, ty);
      if (img) pctx.drawImage(img, tx * 256 - wx + W / 2, ty * 256 - wy + H / 2, 256.5, 256.5);
      else missing = true;
    }
  pctx.restore();
  const cx = W / 2, cy = H / 2;
  if (gpsAcc) {   // GPS accuracy circle
    const mPerPx = 40075016.7 * Math.cos(cfg.lat * D2R) / (256 * (1 << pickZ));
    pctx.fillStyle = body().accent + '22'; pctx.strokeStyle = body().accent + '88';
    pctx.beginPath(); pctx.arc(cx, cy, gpsAcc / mPerPx, 0, 2 * Math.PI); pctx.fill(); pctx.stroke();
  }
  pctx.fillStyle = body().accent; pctx.strokeStyle = '#000'; pctx.lineWidth = 2;
  pctx.beginPath(); pctx.arc(cx, cy, 6, 0, 2 * Math.PI); pctx.fill(); pctx.stroke();
  pctx.fillStyle = sky.mapText; pctx.font = '10px system-ui';
  const osm = '© OpenStreetMap contributors';
  pctx.fillText(osm, W - pctx.measureText(osm).width - 5, H - 5);
  if (missing) pickRetry = setTimeout(drawPicker, 300);   // tiles still loading
}
pick.addEventListener('click', e => {
  const r = pick.getBoundingClientRect();
  const [wx, wy, n] = pickWorld();
  const x = wx + e.clientX - r.left - r.width / 2, y = wy + e.clientY - r.top - r.height / 2;
  const lon = x / n * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * R2D;
  gpsAcc = null;
  if (setLocation(lat, lon)) geoNote(`Pin moved to ${lat.toFixed(5)}, ${lon.toFixed(5)}.`, 'good');
});
$('pickIn').addEventListener('click', () => { pickZ = Math.min(19, pickZ + 1); drawPicker(); });
$('pickOut').addEventListener('click', () => { pickZ = Math.max(3, pickZ - 1); drawPicker(); });
window.addEventListener('resize', drawPicker);

// ---------- audio cue (optional) ----------
// Built for the moment you are behind the camera and not looking at the screen.
//  1. heads-up: a two-note chime when a plane first becomes a confident transit
//     under 30 s out (once per plane);
//  2. countdown: parking-sensor blips, one pitch, spacing shrinking with the time
//     left (2 s apart at 20 s+, 1 s at 10 s, 0.5 s at 5 s, never under 0.15 s);
//  3. on the disc: a steady tone held from predicted entry to exit — "shoot now";
//  4. called off: a soft falling two-note if the prediction drifts to a clear miss
//     before the pass, so silence never has to be interpreted.
// cfg.sound off means no audio node is created at all; cfg.soundVol scales every
// gain, because a level that is a gentle nudge indoors is inaudible outdoors.
let audioCtx = null;
const alerted = new Map();     // hex -> 1 once the heads-up has played (drives the ♪)
const armed = new Set();       // hexes currently counted down
const BEEP_HZ = 880;
const LOOKAHEAD_S = 0.12;      // how far ahead the 50 ms scheduler commits sound
const cd = { lastBeep: -Infinity, toneFor: null };   // countdown scheduler state

function ensureAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) {
    audioCtx = new AC();
    audioCtx.addEventListener('statechange', renderSoundBtn);   // "tap to enable" → "on"
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx.state === 'running' ? audioCtx : null;
}

// one sine note at AudioContext time `when`, with click-free ramps; `hold` keeps
// it at full level until a short release instead of decaying like a bell
function note(ac, freq, when, dur, peak, attack, hold = false) {
  peak = Math.min(peak * (cfg.soundVol || 1), 0.5);   // stay clear of clipping
  const osc = ac.createOscillator(), gain = ac.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(peak, when + attack);
  if (hold) gain.gain.setValueAtTime(peak, when + dur - 0.06);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  osc.connect(gain).connect(ac.destination);
  osc.start(when); osc.stop(when + dur + 0.02);
}

function chime(notes, peak) {
  const ac = ensureAudio();
  if (!ac) return false;
  for (const [freq, at] of notes) note(ac, freq, ac.currentTime + at, 0.55, peak, 0.05);
  return true;
}
const blip = (ac, when) => note(ac, BEEP_HZ, when, 0.07, 0.05, 0.008);
const holdTone = (ac, when, dur) => note(ac, BEEP_HZ, when, dur, 0.045, 0.02, true);
const HEADS_UP = [[784, 0], [1046.5, 0.18]];
const CALLED_OFF = [[1046.5, 0], [784, 0.16]];

// seconds between blips, given seconds left until the tone starts
function beepGap(sLeft) { return Math.min(2, Math.max(0.15, sLeft / 10)); }

// When the tone plays, in prediction seconds: the nominal disc crossing, or just
// closest approach for a near-miss. Clamped to 0.35-5 s, and always kept centred
// on closest approach when clamped — a slow, radial pass can sit on the disc for
// 8 s, and a capped tone that started at entry would end before the best moment.
function toneWindow(pr) {
  const MIN = 0.35, MAX = 5;
  let a = pr.tIn ?? pr.tBest, b = pr.tOut ?? pr.tBest;
  if (b - a < MIN) { a = pr.tBest - MIN / 2; b = pr.tBest + MIN / 2; }
  a = Math.max(a, pr.tBest - MAX / 2);
  b = Math.min(b, pr.tBest + MAX / 2);
  return [a, b];
}

// worth a sound = nominal path crosses the disc (moon or sun, whichever is the
// current target), data is fresh and steady, and the uncertainty is small enough
// to be a real bet rather than a coin flip
function alertWorthy(p) {
  return p.klass === 'transit' && p.trust === 'high' &&
    p.pred.delta <= 3 * target.angR && p.pred.tBest <= 30;
}

function resetCountdown() {
  armed.clear();
  cd.lastBeep = -Infinity; cd.toneFor = null;
}

// 1 Hz, after predict(): decide which planes are armed. Arming is strict
// (alertWorthy); staying armed is loose — anything up to 1.5 R still counts — so a
// prediction flickering across the 1.0 R line or a fix going briefly stale does
// not chop the countdown up.
function checkAlerts() {
  if (!cfg.sound) { resetCountdown(); pruneAlerted(); return; }
  for (const p of planes.values())
    if (p.pred && alertWorthy(p)) armed.add(p.hex);
  for (const hex of [...armed]) {
    const p = planes.get(hex);
    const passed = p && p.pred && p.pred.tBest < 0.05;   // closest approach is now or behind
    const stillOn = p && p.pred && p.pred.sepMin <= 1.5 * target.angR && p.pred.elMin > 0;
    if (passed || !stillOn) {
      armed.delete(hex);
      // only a plane that was actually announced gets called off
      if (!passed && alerted.has(hex) && cd.toneFor !== hex) chime(CALLED_OFF, 0.045);
    }
  }
  pruneAlerted();   // after the disarm pass, which needs to know who was announced
  // heads-up is retried each tick until audio is unlocked, then played once
  for (const hex of armed) {
    if (alerted.has(hex) || !chime(HEADS_UP, 0.06)) continue;
    alerted.set(hex, 1);
    cd.lastBeep = Math.max(cd.lastBeep, audioCtx.currentTime + 0.6);   // blips wait for it
  }
}
function pruneAlerted() {
  for (const hex of [...alerted.keys()])
    if (!planes.has(hex)) alerted.delete(hex);
}

// 20 Hz: turn the lead plane's timing into sound, committing at most LOOKAHEAD_S
// ahead so a changed prediction is heard within a blip.
function countdownLoop() {
  if (!cfg.sound || !armed.size) return;
  const ac = ensureAudio();
  if (!ac) return;
  const nowMs = Date.now();
  let lead = null, leadAt = Infinity;             // whichever armed plane passes first
  for (const hex of armed) {
    const p = planes.get(hex);
    if (!p || !p.pred) continue;
    const at = p.pred.at + p.pred.tBest * 1000;
    if (at < leadAt) { lead = p; leadAt = at; }
  }
  if (!lead) return;
  const pr = lead.pred;
  const [tOn, tOff] = toneWindow(pr);
  const onMs = pr.at + tOn * 1000;
  const sLeft = (onMs - nowMs) / 1000;
  const acNow = ac.currentTime;
  if (sLeft <= LOOKAHEAD_S) {
    if (cd.toneFor !== lead.hex) {
      cd.toneFor = lead.hex;
      const start = acNow + Math.max(0, sLeft);
      const dur = tOff - tOn - Math.max(0, -sLeft);   // joined late: play what is left
      if (dur > 0.05) holdTone(ac, start, dur);
      cd.lastBeep = start + dur;                  // no blips over the tone
      logPass(lead, nowMs + Math.max(0, sLeft) * 1000, dur);
    }
    return;
  }
  // gap is re-derived every pass, so the cadence tightens the moment time runs down
  const next = Math.max(cd.lastBeep + beepGap(sLeft), acNow);
  if (next <= acNow + LOOKAHEAD_S && next + 0.1 < acNow + sLeft) {
    blip(ac, next);
    cd.lastBeep = next;
  }
}

// ---------- pass log (field calibration) ----------
// One row per tone actually played: what the app predicted, and the geometry that
// decides how a position error turns into a timing error. Space marks the moment
// the plane is really seen on the disc, and the row shows seen − predicted.
// A constant offset across rows = feed timing; an offset that follows the vertical
// sky motion (↑) = a height/refraction error; one that follows sideways motion (→)
// = the observer position. Kept in localStorage so it survives a reload.
const PASSLOG_KEY = 'plane-transit-passlog';
let passLog = [];
try { passLog = JSON.parse(localStorage.getItem(PASSLOG_KEY) || '[]'); } catch (e) { passLog = []; }

function logPass(p, startMs, durS) {
  const pr = p.pred, age0 = (pr.at - p.posTime) / 1000;
  const a = sepAt(p, age0, pr.tBest - 0.5), b = sepAt(p, age0, pr.tBest + 0.5);
  const entry = {
    body: cfg.body, flight: p.flight, start: startMs, end: startMs + durS * 1000,
    mid: pr.at + pr.tBest * 1000, missR: +(pr.sepMin / target.angR).toFixed(2),
    up: +(b.el - a.el).toFixed(3), side: +(wrapDeg(b.az - a.az) * Math.cos(a.el * D2R)).toFixed(3),
    el: +a.el.toFixed(1), rangeKm: +(a.range / 1000).toFixed(1), altM: Math.round(p.altM),
    altSrc: p.altSrc, feed: p.feed, gs: Math.round(p.gs),
    fixAge: +((startMs - p.posTime) / 1000).toFixed(1),
    seen: null,
  };
  passLog.push(entry);
  passLog = passLog.slice(-30);
  savePassLog();
  console.log('[pass]', JSON.stringify(entry));
}
function savePassLog() {
  try { localStorage.setItem(PASSLOG_KEY, JSON.stringify(passLog)); } catch (e) { /* full / blocked */ }
}
function markSeen() {
  const now = Date.now();
  const row = [...passLog].reverse().find(r => now > r.start - 15000 && now < r.end + 15000);
  if (!row) return false;
  row.seen = now;
  savePassLog();
  return true;
}
function renderPassLog() {
  const t = ms => new Date(ms).toLocaleTimeString([], { hour12: false }) + '.' + Math.floor(ms % 1000 / 100);
  const arrow = (up, side) => `${up >= 0 ? '↑' : '↓'}${Math.abs(up).toFixed(2)} ${side >= 0 ? '→' : '←'}${Math.abs(side).toFixed(2)}`;
  $('passLogTable').tBodies[0].innerHTML = passLog.slice(-8).reverse().map(r => `<tr>
    <td>${t(r.mid)}</td><td>${r.flight}</td><td>${arrow(r.up, r.side)}</td>
    <td>${r.missR}R ${r.rangeKm}km</td>
    <td>${r.seen == null ? '—' : ((r.seen - r.mid) / 1000 > 0 ? '+' : '') + ((r.seen - r.mid) / 1000).toFixed(1) + 's'}</td></tr>`).join('');
  $('passLogEmpty').style.display = passLog.length ? 'none' : '';
}
// Space belongs to the log everywhere except text entry. A focused checkbox or
// button (the sound toggle, Test sound — whatever was clicked last) would otherwise
// take the Space press and switch the sound off mid-countdown. They act on keyup,
// so both key events are swallowed.
const typingIn = el => el.matches('input[type=number], input[type=text], select, textarea');
const isSpace = e => e.code === 'Space' || e.key === ' ';
document.addEventListener('keydown', e => {
  if (!isSpace(e) || typingIn(e.target)) return;
  e.preventDefault();
  if (!e.repeat && markSeen()) renderPassLog();
});
document.addEventListener('keyup', e => {
  if (isSpace(e) && !typingIn(e.target)) e.preventDefault();
});
$('btnPassLogClear').addEventListener('click', () => { passLog = []; savePassLog(); renderPassLog(); });
// the tracked-planes list and the pass log are occasional tools: collapsed unless
// they were left open last time
for (const id of ['dAll', 'dLog']) {
  const d = $(id), key = 'plane-transit-open-' + id;
  try { d.open = localStorage.getItem(key) === '1'; } catch (e) { /* closed */ }
  d.addEventListener('toggle', () => { try { localStorage.setItem(key, d.open ? '1' : '0'); } catch (e) { /* ok */ } });
}

// Keep the screen awake while the sound cue is on: with the camera up you are not
// touching the device, and a locked screen suspends the page — countdown included.
// Best effort: needs a secure origin (localhost is; a plain-http LAN IP is not).
let wakeLock = null, wakePending = false;
async function syncWakeLock() {
  const want = cfg.sound && document.visibilityState === 'visible';
  if (!('wakeLock' in navigator)) { wakeNote(want ? 'unsupported' : 'off'); return; }
  if (wakePending) return;          // the in-flight call re-syncs when it settles
  wakePending = true;
  let failed = false;
  try {
    if (want && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; wakeNote('off'); });
    } else if (!want && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
    wakeNote(wakeLock ? 'on' : 'off');
  } catch (e) {
    failed = true;                   // denied (policy, battery saver, insecure origin)
    wakeLock = null;
    wakeNote('unsupported');
  } finally {
    wakePending = false;
  }
  // sound toggled while the request was pending: catch up (not after a denial,
  // which would just be denied again)
  const nowWant = cfg.sound && document.visibilityState === 'visible';
  if (!failed && nowWant !== !!wakeLock) syncWakeLock();
}
function wakeNote(state) {
  $('wakeNote').textContent = {
    on: 'Screen is kept awake while the sound cue is on.',
    off: '',
    unsupported: 'This browser/page cannot keep the screen awake — turn off auto-lock, '
      + 'or the countdown stops when the screen does. ' + (window.isSecureContext ? '' : httpsHint()),
  }[state];
}

// On plain http the two features that need a secure context (location, wake lock) are
// unavailable; if the server also speaks https, say where. Filled from /api/status.
let httpsUrl = null;
function httpsHint() {
  return httpsUrl ? `Open ${httpsUrl} instead.` : '';
}
if (!window.isSecureContext && location.protocol === 'http:') {
  fetch('/api/status').then(r => r.json()).then(s => {
    if (!s.tls) return;
    httpsUrl = `https://${location.hostname}:${s.tls.port}/`;
    const a = $('httpsLink');
    a.href = httpsUrl; a.textContent = httpsUrl; a.parentElement.hidden = false;
    syncWakeLock();
  }).catch(() => {});
}
document.addEventListener('visibilitychange', syncWakeLock);

loadCfgUI();
renderSkyCtl();
renderSoundBtn();
setInterval(tick, 1000);
setInterval(countdownLoop, 50);
setInterval(renderNextCard, 100);
if (hasLocation()) start(); else openSetup(true);
