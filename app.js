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
  pushSite();
}

// Where you stand and which feed to use also live on the server (/api/config), so
// every device — and the server's always-on watcher — shares one setup. This
// browser keeps a copy, which is all there is when the server has none to give.
// Per-device choices (target, zoom, sound, map) stay in this browser only.
const SITE_KEYS = ['lat', 'lon', 'groundM', 'aboveM', 'geoidAuto', 'geoidM', 'source', 'radiusNm', 'includeLow'];
const siteBody = () => JSON.stringify({ site: Object.fromEntries(SITE_KEYS.map(k => [k, cfg[k]])) });
const serverSite = { writable: false, sent: '' };   // sent: the last site the server has
let pushTimer = null;
function pushSite() {
  if (!serverSite.writable || !hasLocation() || siteBody() === serverSite.sent) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    const body = siteBody();
    serverSite.sent = body;
    fetch('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body,
      signal: AbortSignal.timeout(5000) })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); })
      .catch(e => { serverSite.sent = ''; console.warn('settings not saved on the server:', e.message); });
  }, 400);
}
// The server's site wins over this browser's copy. A server without one adopts this
// browser's, through applyCfg() → saveCfg() → pushSite() once start-up runs.
async function loadServerSite() {
  try {
    const r = await fetch('/api/config', { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return;
    const c = await r.json();
    serverSite.writable = !!c.writable;
    if (!c.site) return;
    for (const k of SITE_KEYS) if (k in c.site) cfg[k] = c.site[k];
    serverSite.sent = siteBody();
  } catch (e) { /* no server settings: this browser's own, as before */ }
}

// The maths lives in engine.js, shared with the server's always-on watcher.
const PTE = PlaneTransitEngine;
const { PREDICT_S, D2R, R2D, geodeticToECEF, refrShare, wrapDeg, angularSep, planeAt, realMin } = PTE;
const HIDDEN_GRACE_MS = 60000; // keep polling this long after the page is hidden
const BELOW_HORIZON_DEG = -2;  // target this far down = nothing to photograph
const GHOST_S = 10;            // how long a superseded fix's predicted track stays visible
const FETCH_MS = 3000;

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
    ...PTE.BODIES.moon,
    disc: '#f5e9c8', accent: '#ffd97a', glow: null, hasIllum: true,   // glow: "r,g,b"
    sky: {
      grid: '#1d2431', gridText: '#5a6377',
      ground: 'rgba(40,60,45,0.25)', horizon: '#3f5a46', horizonText: '#5f7a66',
      transit: '#ff5c5c', near: '#ffa94d', far: '#7d8aa5',
      mapFilter: 'invert(1) hue-rotate(180deg) brightness(0.85) saturate(0.4)',
      mapDim: 'rgba(11,14,20,0.35)', mapRing: 'rgba(150,160,180,0.35)',
      mapText: '#aab3c5', observer: '#ffffff',
      unlit: 'rgba(245,233,200,0.13)',   // the moon's dark part: faint, so the disc stays whole
      silhouette: '#0b0e14',             // a plane against the disc: the page's own dark
    },
  },
  sun: {
    ...PTE.BODIES.sun,
    disc: '#ffd24a', accent: '#f0b429', glow: '255,190,60', hasIllum: false,
    sky: {
      grid: '#302416', gridText: '#836d47',
      ground: 'rgba(84,68,36,0.32)', horizon: '#67532f', horizonText: '#9a8352',
      // vermillion over amber over sand: the same urgency ladder as the moon's
      // red/orange/grey, re-picked so nothing goes muddy against a sepia ground
      transit: '#ff6448', near: '#ffa33c', far: '#8a7a5e',
      mapFilter: 'invert(1) hue-rotate(180deg) brightness(0.85) sepia(0.6) saturate(0.8)',
      mapDim: 'rgba(21,16,10,0.38)', mapRing: 'rgba(190,168,120,0.32)',
      mapText: '#bda87e', observer: '#fff3dc', silhouette: '#17110a',
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
// The observer as engine.js wants it, from the settings. Rebuilt per call: cheap, and
// it can never go stale against cfg/observer/obsECEF.
const obsHeight = () => cfg.elev + cfg.geoidM;
let obsECEF = hasLocation() ? geodeticToECEF(cfg.lat, cfg.lon, obsHeight()) : null;
const site = () => ({ lat: cfg.lat, lon: cfg.lon, elev: cfg.elev, geoidM: cfg.geoidM,
  h: obsHeight(), observer, ecef: obsECEF });
const azElRange = (lat, lon, h) => PTE.azElRange(site(), lat, lon, h);
const pointAt = (az, el, range) => PTE.pointAt(site(), az, el, range);

// ---------- target body (moon or sun) ----------
const bodyAzEl = (date, key = cfg.body) => PTE.bodyAzEl(site(), key, date);
function updateTarget(now) { target = PTE.bodyTarget(site(), cfg.body, now); }
const targetAt = tSec => PTE.targetAt(target, tSec);

// ---------- plane ingestion ----------
function upsertPlane(hex, flight, lat, lon, altM, gs, track, vr, ageS, altSrc, feed) {
  PTE.upsertPlane(planes, { hex, flight, lat, lon, altM, gs, track, vr, ageS, altSrc, feed }, Date.now());
}
function dropStalePlanes() { PTE.dropStalePlanes(planes, Date.now()); }

// ---------- prediction ----------
const sepAt = (p, age, t) => PTE.sepAt(site(), target, p, age, t);

function predict(p, nowMs) {
  Object.assign(p, PTE.predictPlane(site(), target, p, nowMs));
  if (!p.trail) { p.trail = []; p.ghosts = []; }
  p.trail.push({ az: p.az, el: p.el, range: p.range, t: nowMs });
  while (p.trail.length && nowMs - p.trail[0].t > 20000) p.trail.shift();

  // Prediction history. Each distinct fix gives its own track, fixed in wall-clock
  // time; tracks from the last GHOST_S seconds are drawn fading behind the current
  // one. A steady plane's tracks lie on top of each other; feed jitter or a turn
  // fans them out — the spread is the deviation you can actually see.
  const pr = p.pred;
  const fixKey = [p.lat, p.lon, p.altM, p.gs, p.track, p.vr].join();
  if (fixKey !== p.fixKey) {
    p.fixKey = fixKey;
    if (p.curve) p.ghosts.push(p.curve);
    p.curve = { seen: nowMs, miss: realMin(pr.tBest) ? pr.sepMin : null,
      pts: pr.samples.map(s => ({ T: nowMs + s.t * 1000, az: s.az, el: s.el })) };
  }
  p.ghosts = p.ghosts.filter(g => nowMs - g.seen < GHOST_S * 1000);
}

// The numbers behind the fan: where the oldest fix still in it put the miss, if the
// current fix moves that by at least TREND_R. Straight-line dead reckoning cannot
// follow a turn, so each new fix shifts the miss the same way — 1.6 → 1.1 → 0.5 R
// is a plane turning onto the disc, and the truth is likely further along.
// On live traffic a steady plane moves it 0.02-0.3 R from fix to fix; a turn, by
// whole radii (a 0.1 deg/s turn is ~1 R in 10 s at 30 km).
const TREND_R = 0.5;
function missFrom(p) {
  const g = p.ghosts.find(g => g.miss != null);
  if (!g || !realMin(p.pred.tBest)) return null;
  return Math.abs(p.pred.sepMin - g.miss) >= TREND_R * target.angR ? g.miss : null;
}

// ---------- live data ----------
// Nothing is fetched unless someone is actually watching: the aggregator should cost
// nothing while this page sits in a background tab or the target is down. The server
// polls upstream only when asked (see serve.js), so not asking is the whole mechanism —
// unless its always-on mode is switched on, which paces itself (watch.js).
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

const FEED_NAME = { adsbfi: 'adsb.fi', adsblol: 'adsb.lol' };
let backoffUntil = 0;
let fetchGen = 0;              // bumped by restartFetch(); stale responses are dropped
async function fetchLive() {
  // mock has no feed; the server would answer src=mock with adsb.fi's real planes
  if (!hasLocation() || cfg.source === 'mock' || Date.now() < backoffUntil) return;
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
    const nowMs = Date.now();
    for (const ac of list) {
      const f = PTE.aircraftFix(ac, cfg.geoidM, cfg.includeLow);
      if (f) PTE.upsertPlane(planes, f, nowMs);
    }
    // the server merges a local receiver in per aircraft when one is configured
    const L = meta.local;
    const localBit = L && (L.fresher || L.extra) ? ` · local ${L.fresher}↑ ${L.extra}+` : '';
    // … and asks the other public feed while the chosen one is not answering
    const F = meta.failover;
    const viaBit = F ? ` · via ${FEED_NAME[F.to] || F.to} (${FEED_NAME[F.from] || F.from}: ${F.error})` : '';
    srcStatus = meta.publicError
      ? { idle: true, msg: `local receiver only (${list.length} ac) — ${meta.publicError}`, t: Date.now() }
      : { ok: true, msg: `live ok (${list.length} ac)${localBit}${viaBit}`, t: Date.now() };
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

// The sky as a dome seen from inside: stereographic, centred on the target, zenith
// up. It is conformal — the disc, the rings and the uncertainty circles stay
// circles and a direction on screen is the direction in the sky — and at the centre
// it agrees with the flat frame engine.js reports in (x along azimuth × cos el, y
// up), so `pred.dir` and `target.limb` need no conversion. Away from the centre the
// flat chart it replaced went wrong: it spread the zenith over the full width, so a
// plane passing overhead drew a streak across the whole view.
// Beyond ~127° from the target the projection runs away, so those points are held
// on a ring far outside any view, in the right direction.
function project(az, el, cx, cy, ppd) {
  const d = wrapDeg(az - target.az) * D2R, e = el * D2R, e0 = target.el * D2R;
  const ce = Math.cos(e), se = Math.sin(e), c0 = Math.cos(e0), s0 = Math.sin(e0), cd = Math.cos(d);
  const X = ce * Math.sin(d), Y = se * c0 - ce * s0 * cd, Z = se * s0 + ce * c0 * cd;
  const h = Math.hypot(X, Y);
  if (!h && Z < 0) return [cx, cy + 4 * R2D * ppd];      // dead behind: any direction will do
  const k = (Z > -0.6 ? 2 / (1 + Z) : 4 / h) * R2D * ppd;
  return [cx + k * X, cy - k * Y];
}

// Perspective: how large a plane and its track are drawn for their distance — full
// size at NEAR_M and closer, then as 1/range, the way things really shrink. This is
// what says "towards you" or "away": the position on the dome cannot. Not a gentler
// curve: a jet closing from 27 to 15 km grows 80% along its line, and it has to show.
// NEAR_M is where a cruising jet passes with the target high; nearer is just "near".
const NEAR_M = 8000;
const depth = range => Math.min(1, NEAR_M / range);
// which way the distance is going right now, from the first two samples (m/s)
const CLOSING_MS = 15;
function rangeRate(p) {
  const s = p.pred.samples;
  return s.length > 1 ? (s[1].range - s[0].range) / (s[1].t - s[0].t) : 0;
}

// Where plane p is at the moment being drawn: predict()'s own dead reckoning, asked
// for `frameMs` instead of the last tick. Not an interpolation between reports — that
// would draw the plane a report behind — and not a different model: at a tick it is
// p.az / p.el to the last digit. A tick that is late (a throttled tab) freezes it.
function posNow(p, frameMs) {
  const lead = (frameMs - p.pred.at) / 1000;
  if (!(lead > 0.02 && lead < 5) || !Number.isFinite(p.lat)) return p;
  const pos = planeAt(p, (frameMs - p.posTime) / 1000);
  return azElRange(pos.lat, pos.lon, pos.h);
}
// A new report never agrees with the old one's dead reckoning to the metre: report
// times are only known to a few tenths of a second, which at a jet's speed is 50-150 m.
// Drawn as it comes, the plane twitches back or forth every few seconds. So the
// *drawn* plane slides to where the new report puts it over SLIP_S instead: it starts
// from where it was being drawn, and the difference is eased away. Only the marker
// does this. The prediction, the track, the numbers and the tone switch to the new
// report at once; and a correction too big to be timing noise (SLIP_MAX_M) still
// jumps, because that one is news.
const SLIP_S = 1.5, SLIP_MAX_M = 1500;
const slipLeft = ms => { const x = ms / (SLIP_S * 1000); return x >= 1 ? 0 : 1 - x * x * (3 - 2 * x); };
function shownPos(p, frameMs) {
  const raw = posNow(p, frameMs);
  if (!Number.isFinite(p.lat)) return raw;
  const key = p.posTime + '|' + p.lat + '|' + p.lon + '|' + p.track + '|' + p.gs + '|' + (p.turn || 0);
  let d = p.drawn;
  if (!d || d.key !== key) {
    let slip = null;
    if (d && frameMs - d.at < 2000) {       // it was on screen a moment ago: carry on from there
      const pos = planeAt(d.fix, (frameMs - d.fix.posTime) / 1000), old = azElRange(pos.lat, pos.lon, pos.h);
      const w = d.slip ? slipLeft(frameMs - d.slip.t0) : 0;
      slip = { az: wrapDeg(old.az - raw.az) + (w ? d.slip.az * w : 0), el: old.el - raw.el + (w ? d.slip.el * w : 0),
        range: old.range - raw.range + (w ? d.slip.range * w : 0), t0: frameMs };
      const m = Math.hypot(slip.az * Math.cos(raw.el * D2R), slip.el) * D2R * raw.range;
      if (!(Math.hypot(m, slip.range) < SLIP_MAX_M)) slip = null;
    }
    d = p.drawn = { key, slip, at: frameMs,
      fix: { lat: p.lat, lon: p.lon, altM: p.altM, gs: p.gs, track: p.track, vr: p.vr, turn: p.turn, posTime: p.posTime } };
  }
  d.at = frameMs;
  const w = d.slip ? slipLeft(frameMs - d.slip.t0) : 0;
  if (!w) { d.slip = null; return raw; }
  return { az: raw.az + d.slip.az * w, el: raw.el + d.slip.el * w, range: raw.range + d.slip.range * w };
}
// a predicted track t seconds after its tick, between its 2 s samples (null past the end)
function sampleAt(samples, t) {
  const i = samples.findIndex(s => s.t >= t);
  if (i < 0) return null;
  if (i === 0) return samples[0];
  const a = samples[i - 1], b = samples[i], f = (t - a.t) / (b.t - a.t);
  return { az: a.az + wrapDeg(b.az - a.az) * f, el: a.el + (b.el - a.el) * f, range: a.range + (b.range - a.range) * f };
}

// Wingspans in metres by ICAO type, for drawing a plane to scale against the disc.
// Without a known type the ADS-B size class decides, and without that a single-aisle
// airliner is assumed: most of what crosses the sky.
const WINGSPAN_M = {
  A318: 34.1, A319: 35.8, A320: 35.8, A321: 35.8, A19N: 35.8, A20N: 35.8, A21N: 35.8,
  A306: 44.8, A310: 43.9, A332: 60.3, A333: 60.3, A338: 64, A339: 64, A342: 60.3, A343: 60.3,
  A345: 63.5, A346: 63.5, A359: 64.8, A35K: 64.8, A388: 79.8, A400: 42.4, A124: 73.3,
  B712: 28.4, B733: 28.9, B734: 28.9, B735: 28.9, B736: 34.3, B737: 35.8, B738: 35.8, B739: 35.8,
  B37M: 35.9, B38M: 35.9, B39M: 35.9, B3XM: 35.9, B744: 64.4, B748: 68.4, B752: 38.1, B753: 38.1,
  B762: 47.6, B763: 47.6, B764: 51.9, B772: 60.9, B773: 60.9, B77L: 64.8, B77W: 64.8,
  B788: 60.1, B789: 60.1, B78X: 60.1, MD11: 51.7, MD82: 32.9, MD83: 32.9, C17: 51.8, IL76: 50.5,
  BCS1: 35.1, BCS3: 35.1, E170: 26, E75L: 28.7, E75S: 28.7, E190: 28.7, E195: 28.7, E290: 33.7, E295: 35.1,
  CRJ2: 21.2, CRJ7: 23.2, CRJ9: 24.9, CRJX: 26.2, F70: 28.1, F100: 28.1, SU95: 27.8,
  AT43: 24.6, AT45: 24.6, AT72: 27.1, AT75: 27.1, AT76: 27.1, DH8D: 28.4, SF34: 21.4, SB20: 24.8,
  GLF5: 28.5, GLF6: 30.4, GLEX: 28.7, F900: 19.3, FA7X: 26.2, C56X: 17, E55P: 15.9, PC24: 17,
  PC12: 16.3, C208: 15.9, BE20: 16.6, C172: 11, C182: 11, P28A: 9.1, SR22: 11.7, DA40: 11.9,
};
const CLASS_SPAN_M = { A1: 11, A2: 18, A3: 36, A4: 38, A5: 61, A6: 12, A7: 12 };
const wingspanM = p => WINGSPAN_M[p.type] || CLASS_SPAN_M[p.cat] || 36;

// `frameMs` is the moment being drawn. tick() draws its own; between ticks animate()
// asks for the frames in between, and every plane is put where it is *then* (posNow).
// with "show near misses" off, near passes are drawn as ordinary far traffic
const kOf = p => (p.klass === 'near' && !cfg.showNear) ? 'far' : p.klass;

function render(frameMs = Date.now(), skyOnly = false) {
  // the enlarged map covers the sky view: it is the one drawn, every frame
  if (mapView.big) { renderMap(frameMs, !skyOnly); return; }
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

  // grid: the dome's own lines — compass directions meet in the zenith, lines of
  // equal height curve round it. Each is sampled only where the view can reach.
  const step = cfg.spanDeg <= 20 ? 5 : 10;
  const c0 = Math.cos(target.el * D2R), s0 = Math.sin(target.el * D2R);
  // how far the view reaches from its centre (its corners), in degrees of sky
  const reach = 2 * Math.atan(Math.hypot(W, H) / 2 / ppd * D2R / 2) * R2D;
  const curve = pts => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  };
  // where a curve first crosses the line x = at (axis 0) or y = at (axis 1): the
  // other coordinate there, for hanging a label on the edge of the view
  const crossing = (pts, axis, at) => {
    for (let i = 1; i < pts.length; i++) {
      const u = pts[i - 1], v = pts[i];
      if (u[axis] !== v[axis] && (u[axis] - at) * (v[axis] - at) <= 0)
        return u[1 - axis] + (v[1 - axis] - u[1 - axis]) * (at - u[axis]) / (v[axis] - u[axis]);
    }
    return null;
  };
  ctx.strokeStyle = sky.grid; ctx.fillStyle = sky.gridText;
  ctx.lineWidth = 1; ctx.font = '11px system-ui';
  const lo = Math.max(-89, target.el - reach);
  for (let a = 0; a < 360; a += step) {
    const d = wrapDeg(a - target.az);
    // the nearest this meridian comes to the centre: abeam of it, or at the zenith
    const off = Math.abs(d) <= 90 ? Math.asin(c0 * Math.abs(Math.sin(d * D2R))) * R2D : 90 - target.el;
    const hi = a % 30 ? 80 : 90;       // only every 30° runs on into the zenith
    if (off > reach || lo >= hi) continue;
    const pts = [];
    for (let i = 0; i <= 48; i++) pts.push(project(a, lo + (hi - lo) * i / 48, cx, cy, ppd));
    curve(pts); ctx.stroke();
    const x = crossing(pts, 1, H - 6);
    if (x != null && x > 0 && x < W - 24) ctx.fillText(`${a}°`, x + 3, H - 6);
  }
  const cosReach = Math.cos(reach * D2R);
  for (let e = Math.ceil(lo / step) * step; e <= Math.min(target.el + reach, 85); e += step) {
    // the stretch of this parallel within reach of the centre: ±lim in azimuth
    const q = (cosReach - Math.sin(e * D2R) * s0) / (Math.cos(e * D2R) * c0);
    if (q >= 1) continue;
    const lim = q <= -1 ? 180 : Math.acos(q) * R2D;
    const pts = [];
    for (let i = 0; i <= 72; i++) pts.push(project(target.az - lim + 2 * lim * i / 72, e, cx, cy, ppd));
    curve(pts); ctx.stroke();
    const y = crossing(pts, 0, 6);
    if (y != null && y > 16 && y < H) ctx.fillText(`${e}°`, 6, y - 3);
  }

  // horizon: a circle on the dome, the sky inside it (the ground, once the target
  // is below). Drawn as a polygon, not an arc: with the target low the circle is
  // thousands of pixels across, more than some browsers' arcs stay true for.
  const hor = [];
  for (let d = -180; d < 180; d++) hor.push(project(target.az + d, 0, cx, cy, ppd));
  curve(hor); ctx.closePath();
  if (target.el > 0) ctx.rect(0, 0, W, H);
  ctx.fillStyle = sky.ground; ctx.fill('evenodd');
  curve(hor); ctx.closePath();
  ctx.strokeStyle = sky.horizon; ctx.lineWidth = 1.5; ctx.stroke();
  const yHor = crossing(hor.slice(90, 271), 0, W - 55);   // the near half, left to right
  if (yHor != null && yHor > 16 && yHor < H + 5) {
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

  // With a wide search radius most planes are nowhere near the view, and a frame is
  // drawn 30 times a second: leave out those whose trail and track stay outside it.
  // Four points stand for the lot — a track is close enough to straight that it
  // cannot cross the view while the box round its ends and middle misses it.
  const shown = new Set();
  for (const p of planes.values()) {
    if (!p.pred) continue;
    const sm = p.pred.samples;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of [p.trail[0] || p, p, sm[sm.length >> 1], sm[sm.length - 1]]) {
      const [x, y] = project(s.az, s.el, cx, cy, ppd);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    if (x1 > -100 && x0 < W + 100 && y1 > -100 && y0 < H + 100) shown.add(p);
  }

  // planes: paths first, then the target disc over them, then dots + labels on top
  const colors = sky;   // keyed by klass: transit / near / far
  ctx.font = '12px system-ui';
  for (const p of shown) {
    const k = kOf(p);
    const col = colors[k];
    // Where it has been and where it is going, as one band in perspective (see
    // drawBand): the trail fainter, the prediction under its line.
    const far = k === 'far', wide = far ? 3.5 : 5;
    // both start at the plane as it is this frame, not at the last tick's position
    const cur = shownPos(p, frameMs), lead = Math.max(0, (frameMs - p.pred.at) / 1000);
    const ahead = [cur].concat(p.pred.samples.filter(s => s.t > lead + 0.05));
    const behind = p.trail.concat(cur);
    const path = ahead.map(s => project(s.az, s.el, cx, cy, ppd));
    drawBand(behind.map(s => project(s.az, s.el, cx, cy, ppd)), behind.map(s => s.range), wide, col, far ? 0.25 : 0.35);
    drawBand(path, ahead.map(s => s.range), wide, col, far ? 0.5 : 0.7);
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
    // predicted path with ETA ticks and arrowheads
    ctx.strokeStyle = col; ctx.lineWidth = far ? 1 : 1.5;
    curve(path); ctx.stroke();
    ctx.fillStyle = col;
    drawHeads(path, ahead, W, H);
    for (const t of [30, 60]) {            // 30 and 60 s from this frame, not from the tick
      const s = sampleAt(p.pred.samples, t + lead);
      if (!s) continue;
      const [x, y] = project(s.az, s.el, cx, cy, ppd);
      ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
      ctx.fillText(`+${t}s`, x + 4, y - 4);
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

  // What the shot will look like: at closest approach, the plane to scale against the
  // disc — its real wingspan at the range it will have there, turned and tipped as
  // you will see it. Dark on the disc, as a silhouette is; outlined in its colour
  // when it misses, or it would be dark on dark.
  // Only once the zoom makes it more than a speck.
  for (const p of planes.values()) {
    if (!p.pred || kOf(p) === 'far' || !realMin(p.pred.tBest) || !(p.pred.elMin > 0)) continue;
    const half = wingspanM(p) / 2 / p.pred.rangeMin * R2D * ppd;
    if (half < 3) continue;
    const [x, y] = project(p.pred.azMin, p.pred.elMin, cx, cy, ppd);
    ctx.fillStyle = sky.silhouette;
    ctx.strokeStyle = p.pred.sepMin <= target.angR ? sky.silhouette : colors[kOf(p)];
    drawPlane(p.pred.azMin, p.pred.elMin, p.track, x, y, cx, cy, ppd, half, 0);
  }

  for (const p of shown) {
    const cur = shownPos(p, frameMs);
    const [x, y] = project(cur.az, cur.el, cx, cy, ppd);
    if (x < -80 || y < -80 || x > W + 80 || y > H + 80) continue;
    const half = Math.max(4.5, 26 * depth(cur.range));   // half the wingspan, px
    ctx.fillStyle = ctx.strokeStyle = colors[kOf(p)];
    drawPlane(cur.az, cur.el, p.track, x, y, cx, cy, ppd, half, MIN_TILT);
    // the same thing in words: how far, and which way that is going
    const rr = rangeRate(p), lx = x + 8, ly = y + Math.max(13, half * 0.7 + 9);
    ctx.font = '12px system-ui';
    ctx.fillText(`${p.flight} ${(p.altM / 1000).toFixed(1)}km up`, lx, ly);
    ctx.font = '11px system-ui'; ctx.globalAlpha = 0.8;
    ctx.fillText(`${(cur.range / 1000).toFixed(0)} km · `
      + (rr < -CLOSING_MS ? 'coming closer' : rr > CLOSING_MS ? 'going away' : 'at its closest'), lx, ly + 13);
    ctx.globalAlpha = 1;
  }

  if (cfg.showMap && !skyOnly) renderMap(frameMs, true);   // the inset: once a tick is plenty
}

// A track as a band in perspective: as wide as the plane is near (depth()), and
// fading into the distance. A band that swells ahead of the plane is one coming
// towards you, one that thins to a hair is going away, an even one is crossing
// sideways — read like a road, with no need to find the plane itself.
// `wide` is the half-width in px at NEAR_M; `strength` the opacity there.
function drawBand(path, ranges, wide, col, strength) {
  const n = path.length;
  if (n < 2) return;
  const edge = path.map((pt, i) => {
    const u = path[Math.max(0, i - 1)], v = path[Math.min(n - 1, i + 1)];
    const dx = v[0] - u[0], dy = v[1] - u[1], len = Math.hypot(dx, dy) || 1;
    const h = Math.max(0.6, wide * depth(ranges[i]));
    return [-dy / len * h, dx / len * h];
  });
  const shade = i => col
    + Math.round(255 * strength * (0.25 + 0.75 * depth(ranges[i]))).toString(16).padStart(2, '0');
  const [x0, y0] = path[0], [x1, y1] = path[n - 1];
  const chord = (x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0);
  if (chord < 4) ctx.fillStyle = shade(0);     // heading straight at you: no line to shade along
  else {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    for (let i = 0; ; i = Math.min(n - 1, i + 4)) {
      const f = ((path[i][0] - x0) * (x1 - x0) + (path[i][1] - y0) * (y1 - y0)) / chord;
      g.addColorStop(Math.min(1, Math.max(0, f)), shade(i));
      if (i === n - 1) break;
    }
    ctx.fillStyle = g;
  }
  ctx.beginPath();
  path.forEach(([x, y], i) => i ? ctx.lineTo(x + edge[i][0], y + edge[i][1]) : ctx.moveTo(x + edge[i][0], y + edge[i][1]));
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(path[i][0] - edge[i][0], path[i][1] - edge[i][1]);
  ctx.closePath(); ctx.fill();
}

// The plane itself, as it looks from where you stand: a small model turned to its
// track, flying level, seen from below along the line of sight — one overhead shows
// its plan, one lower down is tipped away, nose up the screen when it comes towards
// you and down to the horizon when it leaves. The marker for where a plane is now is
// never tipped flatter than MIN_TILT: seen truly edge on, a plane low in the sky is a
// dash that says nothing, and its `half` (half the wingspan, px) comes from depth():
// bigger is nearer, not to scale. The silhouette at closest approach is the honest
// one: real tilt, real size (wingspanM).
// The model is [forward, right] and, for the fin, [forward, up]; half a wingspan = 1.
const MIN_TILT = 35;
const PLANE_BODY = [[1.05, 0], [0.85, 0.09], [0.3, 0.1], [-0.25, 1], [-0.42, 1], [-0.15, 0.1],
  [-0.75, 0.08], [-1, 0.38], [-1.1, 0.38], [-1.02, 0]];
const PLANE_FIN = [[-0.6, 0], [-1, 0.4], [-1.12, 0.4], [-1.02, 0]];
function drawPlane(az, el, track, x, y, cx, cy, ppd, half, minTilt) {
  // "up" on screen at the plane (the dome's meridians lean away from the centre one)
  const [ux, uy] = project(az, el + 0.05, cx, cy, ppd);
  const n = Math.hypot(ux - x, uy - y) || 1, ex = (ux - x) / n, ey = (uy - y) / n;
  // the model's axes as a camera pitched up at the plane sees them: [right, up]
  const b = (track - az) * D2R, tilt = Math.max(el, minTilt) * D2R;
  const st = Math.sin(tilt), ct = Math.cos(tilt);
  const fwd = [Math.sin(b), -st * Math.cos(b)], right = [Math.cos(b), st * Math.sin(b)], up = [0, ct];
  const shape = (pts, side) => {
    ctx.beginPath();
    pts.forEach(([f, s], i) => {
      const r = (f * fwd[0] + s * side[0]) * half, u = (f * fwd[1] + s * side[1]) * half;
      const X = x - r * ey + u * ex, Y = y + r * ex + u * ey;   // screen right = "up" turned a quarter
      i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
    });
    ctx.closePath(); ctx.fill(); ctx.stroke();   // the stroke keeps a thin wing visible
  };
  ctx.lineWidth = 1; ctx.lineJoin = 'round';
  shape(PLANE_BODY.concat(PLANE_BODY.slice(1, -1).reverse().map(([f, s]) => [f, -s])), right);
  shape(PLANE_FIN, up);
}

// Arrowheads along a predicted path, HEAD_GAP px apart on screen whatever the zoom, so
// any stretch of line in view says which way the plane flies — the plane is often
// off screen. Sized in perspective like the band they sit on (1/range, clamped).
const HEAD_GAP = 90;
function drawHeads(path, samples, W, H) {
  let next = HEAD_GAP / 2;
  for (let i = 1; i < path.length; i++) {
    const [x0, y0] = path[i - 1], [x1, y1] = path[i];
    const len = Math.hypot(x1 - x0, y1 - y0);
    for (; next <= len; next += HEAD_GAP) {
      const f = next / len, x = x0 + (x1 - x0) * f, y = y0 + (y1 - y0) * f;
      if (x < -10 || y < -10 || x > W + 10 || y > H + 10) continue;
      const range = samples[i - 1].range + (samples[i].range - samples[i - 1].range) * f;
      const s = Math.max(3.5, 10 * depth(range));
      ctx.save();
      ctx.translate(x, y); ctx.rotate(Math.atan2(y1 - y0, x1 - x0));
      ctx.beginPath(); ctx.moveTo(s, 0); ctx.lineTo(-s * 0.8, s * 0.75); ctx.lineTo(-s * 0.8, -s * 0.75);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    next -= len;
  }
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

// ---------- top-down map (OpenStreetMap tiles + overlay) ----------
// Two canvases in #mapBox: the tiles underneath, recoloured by a CSS filter and
// redrawn only when the view moves or a tile arrives, and everything of ours on top,
// cheap enough to redraw every frame.
// An inset by default: you in the middle, the search radius to the edge. Clicked, it
// takes over the view (mapView.big) and can be dragged and zoomed, for looking at
// where the crossings fall on the ground — see castTracks().
const mapBox = document.getElementById('mapBox');
const mapCanvas = document.getElementById('map'), mctx = mapCanvas.getContext('2d');
const tilesCanvas = document.getElementById('mapTiles'), tctx = tilesCanvas.getContext('2d');
const MERC_R = 6378137;
const mercX = lon => MERC_R * lon * D2R;
const mercY = lat => MERC_R * Math.log(Math.tan(Math.PI / 4 + lat * D2R / 2));
const mercLat = y => (2 * Math.atan(Math.exp(y / MERC_R)) - Math.PI / 2) * R2D;
// `zoom` multiplies the scale that fits the search radius; lat/lon is the centre,
// null while the map still follows you. Kept while the page is open, not saved.
const mapView = { big: false, zoom: 1, lat: null, lon: null };
const MAP_ZOOM_OUT = 0.4;      // furthest out: crossings fall well outside the search radius
const MAP_MIN_MPP = 0.6;       // closest in, ground metres per pixel
const mapShown = () => mapView.big || cfg.showMap;

const tileCache = new Map();   // "z/x/y" -> Image (CORS-enabled so canvas stays clean), oldest first
let tilesStale = true, tilesKey = '', tilesFilter = '';
function getTile(z, x, y) {
  const n = 1 << z;
  x = ((x % n) + n) % n;
  if (y < 0 || y >= n) return null;
  const key = `${z}/${x}/${y}`;
  let img = tileCache.get(key);
  if (img) tileCache.delete(key);                // … and back in below, as the newest
  else {
    if (tileCache.size > 400) tileCache.delete(tileCache.keys().next().value);
    img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { tilesStale = true; requestMapDraw(); };
    img.src = `https://tile.openstreetmap.org/${key}.png`;
  }
  tileCache.set(key, img);
  return (img.complete && img.naturalWidth) ? img : null;
}

// The view as it stands: its size, its scale and the two ways across it.
function mapFrame() {
  const W = +mapBox.clientWidth, H = +mapBox.clientHeight, big = mapView.big;
  const Rm = cfg.radiusNm * 1852;
  // px per Mercator metre; Mercator inflates ground distance by 1/cos(lat)
  const fit = (Math.min(W, H) / 2 - 6) * Math.cos(cfg.lat * D2R) / Rm;   // the search radius to the edge
  const scale = big ? fit * mapView.zoom : fit;
  const lat = big && mapView.lat != null ? mapView.lat : cfg.lat;
  const lon = big && mapView.lon != null ? mapView.lon : cfg.lon;
  const x0 = mercX(lon), y0 = mercY(lat);
  return { W, H, big, Rm, fit, scale, lat, lon,
    xy: (la, lo) => [W / 2 + (mercX(lo) - x0) * scale, H / 2 - (mercY(la) - y0) * scale],
    at: (x, y) => ({ lat: mercLat(y0 - (y - H / 2) / scale), lon: (x0 + (x - W / 2) / scale) / MERC_R * R2D }),
    ppm: la => scale / Math.cos(la * D2R),       // px per ground metre at a latitude
  };
}

function drawTiles(f) {
  const dpr = window.devicePixelRatio || 1, { W, H, scale } = f;
  const key = [W, H, dpr, f.lat, f.lon, scale].join();
  if (key === tilesKey && !tilesStale) return;
  tilesKey = key; tilesStale = false;
  if (tilesCanvas.width !== W * dpr || tilesCanvas.height !== H * dpr) { tilesCanvas.width = W * dpr; tilesCanvas.height = H * dpr; }
  tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  tctx.clearRect(0, 0, W, H);
  const world = 2 * Math.PI * MERC_R * scale;    // the whole world, px
  // the inset stretches its tiles a little, to keep their lettering readable; enlarged, sharp wins
  const z = Math.max(3, Math.min(19, Math.round(Math.log2(world / (f.big ? 256 : 320)))));
  const n = 1 << z, tilePx = world / n;          // drawn size of one tile
  const tx0 = (mercX(f.lon) + Math.PI * MERC_R) / (2 * Math.PI * MERC_R) * n - W / 2 / tilePx;
  const ty0 = (Math.PI * MERC_R - mercY(f.lat)) / (2 * Math.PI * MERC_R) * n - H / 2 / tilePx;
  for (let i = Math.floor(tx0); (i - tx0) * tilePx < W; i++)
    for (let j = Math.floor(ty0); (j - ty0) * tilePx < H; j++) {
      if (j < 0 || j >= n) continue;
      const x = (i - tx0) * tilePx, y = (j - ty0) * tilePx, xi = ((i % n) + n) % n;
      const img = getTile(z, xi, j);
      if (img) { tctx.drawImage(img, x, y, tilePx + 0.5, tilePx + 0.5); continue; }
      // not here yet: the same ground out of a coarser tile that is, so that zooming
      // in sharpens the picture instead of blanking it
      for (let k = 1; k <= 6 && z - k >= 3; k++) {
        const up = tileCache.get(`${z - k}/${xi >> k}/${j >> k}`);
        if (!up || !up.complete || !up.naturalWidth) continue;
        const sz = up.naturalWidth / (1 << k), m = (1 << k) - 1;
        tctx.drawImage(up, (xi & m) * sz, (j & m) * sz, sz, sz, x, y, tilePx + 0.5, tilePx + 0.5);
        break;
      }
    }
}

// Where each plane's crossing of the disc falls on the ground over the next
// PREDICT_S: PTE.transitPoint() along its predicted flight, with the body where it
// will be by then. One list per plane, rebuilt on every tick the map is drawn;
// `across` and `along` are the disc's own footprint there, in metres (half-widths).
// The ground is taken to be at the observer's own height — the only one known — so
// the line through the observer is exactly the pass the prediction reports.
const casts = new Map();       // hex -> [{ t, lat, lon, az, across, along }], t in s after castsAt
let castsAt = 0;
function castTracks() {
  casts.clear();
  let at = 0;
  for (const p of planes.values()) if (p.pred) { at = p.pred.at; break; }
  if (!at || !(target.el > 1)) return;
  castsAt = at;
  const s = site(), rad = target.angR * D2R;
  const B0 = PTE.bodyEcef(s, cfg.body, new Date(at)), B1 = PTE.bodyEcef(s, cfg.body, new Date(at + 120000));
  for (const p of planes.values()) {
    if (!p.pred || p.pred.at !== at) continue;
    const line = [];
    for (let t = 0; t <= PREDICT_S; t += p.turn ? 3 : 10) {    // a turn bends it: finer steps
      const u = t / 120;
      const g = PTE.transitPoint([B0[0] + (B1[0] - B0[0]) * u, B0[1] + (B1[1] - B0[1]) * u, B0[2] + (B1[2] - B0[2]) * u],
        planeAt(p, p.age + t), s.h);
      if (!g) { if (line.length) break; continue; }
      const across = rad * g.range;
      line.push({ t, lat: g.lat, lon: g.lon, az: g.az, across, along: across / Math.sin(g.el * D2R) });
    }
    if (line.length > 1) casts.set(p.hex, line);
  }
}
// a cast from `lead` seconds after its tick onward (it is drawn at every frame's own moment)
function castFrom(line, lead) {
  const i = line.findIndex(c => c.t > lead);
  if (i < 0) return [];
  if (i === 0) return line;
  const a = line[i - 1], b = line[i], w = (lead - a.t) / (b.t - a.t), mix = k => a[k] + (b[k] - a[k]) * w;
  return [{ t: lead, lat: mix('lat'), lon: mix('lon'), az: a.az + wrapDeg(b.az - a.az) * w,
    across: mix('across'), along: mix('along') }].concat(line.slice(i));
}

const fmtDist = m => m >= 9500 ? `${Math.round(m / 1000)} km` : m >= 950 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`;

// `fresh` on a tick: the crossings are worked out anew. Between ticks (and while the
// map is being dragged) the last ones are drawn again, moved on to this frame's moment.
function renderMap(frameMs, fresh) {
  const f = mapFrame(), { W, H, big } = f;
  const dpr = window.devicePixelRatio || 1;
  if (mapCanvas.width !== W * dpr || mapCanvas.height !== H * dpr) { mapCanvas.width = W * dpr; mapCanvas.height = H * dpr; }
  mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mctx.clearRect(0, 0, W, H);
  const B = body(), sky = B.sky;
  if (tilesFilter !== sky.mapFilter) tilesCanvas.style.filter = tilesFilter = sky.mapFilter;   // sun mode adds sepia
  drawTiles(f);
  mctx.fillStyle = sky.mapDim;                   // dim for overlay contrast
  mctx.fillRect(0, 0, W, H);
  const [ox, oy] = f.xy(cfg.lat, cfg.lon);       // you
  const ppm = f.ppm(cfg.lat);

  // range rings round you. Far from a ring's centre only its nearest stretch is
  // drawn, as a polygon: an arc tens of thousands of px across is not to be trusted.
  const nearPx = Math.hypot(Math.max(-ox, 0, ox - W), Math.max(-oy, 0, oy - H));
  const farPx = Math.max(Math.hypot(ox, oy), Math.hypot(W - ox, oy), Math.hypot(ox, H - oy), Math.hypot(W - ox, H - oy));
  const toView = nearPx > 0 || Math.hypot(W / 2 - ox, H / 2 - oy) > 40 ? Math.atan2(H / 2 - oy, W / 2 - ox) : 0;
  const ring = rp => {
    mctx.beginPath();
    if (rp < 3000) mctx.arc(ox, oy, rp, 0, 2 * Math.PI);
    else {
      const half = Math.min(Math.PI, 1.5 * Math.hypot(W, H) / rp);
      for (let i = 0; i <= 48; i++) {
        const a = toView - half + 2 * half * i / 48;
        mctx.lineTo(ox + rp * Math.cos(a), oy + rp * Math.sin(a));
      }
    }
    mctx.stroke();
  };
  const ringKm = big ? ([0.2, 0.5, 1, 2, 5, 10, 25, 50, 100].find(k => k * 1000 * ppm >= 70) || 200)
    : f.Rm > 130000 ? 50 : f.Rm > 60000 ? 25 : 10;
  mctx.strokeStyle = sky.mapRing; mctx.fillStyle = sky.mapText;
  mctx.font = `${big ? 11 : 9}px system-ui`; mctx.lineWidth = 1;
  const first = big ? Math.max(1, Math.ceil(nearPx / ppm / (ringKm * 1000))) : 1;
  for (let i = first; i < first + 40 && i * ringKm * 1000 <= (big ? farPx / ppm : f.Rm); i++) {
    const rp = i * ringKm * 1000 * ppm;
    ring(rp);
    if (big) mctx.fillText(fmtDist(i * ringKm * 1000), ox + rp * Math.cos(toView) + 4, oy + rp * Math.sin(toView) - 4);
    else mctx.fillText(`${i * ringKm}`, ox + rp - 12, oy - 3);
  }
  const osm = '© OpenStreetMap contributors';
  if (big) {
    // the edge of what is known: planes beyond the search radius are not fetched
    mctx.setLineDash([6, 5]); ring(f.Rm * ppm); mctx.setLineDash([]);
    mctx.fillText('search radius', ox + f.Rm * ppm * Math.cos(toView - 0.35) + 4, oy + f.Rm * ppm * Math.sin(toView - 0.35));
    mctx.fillText(osm, 8, H - 8);
  } else {
    mctx.fillText('N', W / 2 - 3, 10);
    mctx.fillText('km', W - 18, H / 2 - 3);
    mctx.fillText('⤢', W - 14, 12);              // it opens
    mctx.fillText(osm, W - mctx.measureText(osm).width - 4, H - 5);
  }

  // observation cone: the azimuth range covered by the sky view, and the target's bearing
  const reach = big ? farPx + 50 : Math.min(W, H) / 2 - 10;
  const azHalf = Math.min(cfg.spanDeg / (2 * Math.cos(target.el * D2R)), 90);
  mctx.fillStyle = B.accent + (big ? '12' : '1a');
  mctx.beginPath(); mctx.moveTo(ox, oy);
  for (let i = 0; i <= 16; i++) {
    const a = (target.az - azHalf + 2 * azHalf * i / 16) * D2R;
    mctx.lineTo(ox + Math.sin(a) * reach, oy - Math.cos(a) * reach);
  }
  mctx.closePath(); mctx.fill();
  const mx = ox + Math.sin(target.az * D2R) * reach, my = oy - Math.cos(target.az * D2R) * reach;
  mctx.strokeStyle = B.disc + '99'; mctx.setLineDash([4, 3]);
  mctx.beginPath(); mctx.moveTo(ox, oy); mctx.lineTo(mx, my); mctx.stroke();
  mctx.setLineDash([]);
  mctx.fillStyle = B.disc;
  mctx.beginPath(); mctx.arc(mx, my, 3, 0, 2 * Math.PI); mctx.fill();

  if (fresh) castTracks();
  const castLead = Math.max(0, (frameMs - castsAt) / 1000);
  const onMap = (x, y, pad) => x > -pad && y > -pad && x < W + pad && y < H + pad;
  mctx.lineJoin = 'round';
  for (const p of planes.values()) {
    if (!p.pred) continue;
    const k = kOf(p), col = sky[k], far = k === 'far';
    // the plane, where the same dead reckoning has it at this frame, and its ground track
    const lead = (frameMs - p.pred.at) / 1000;
    const now = planeAt(p, lead > 0.02 && lead < 5 ? (frameMs - p.posTime) / 1000 : p.age);
    const [x, y] = f.xy(now.lat, now.lon);
    mctx.strokeStyle = col + (big ? '66' : 'aa'); mctx.lineWidth = 1;
    mctx.beginPath(); mctx.moveTo(x, y);
    for (let t = 15; t <= PREDICT_S; t += 15) {
      const pos = planeAt(p, p.age + t);
      mctx.lineTo(...f.xy(pos.lat, pos.lon));
    }
    mctx.stroke();

    // where it crosses the disc: the line on the ground, the band as wide as the
    // disc once the zoom shows it, and the spot it is at now, tied to the plane
    const cast = casts.has(p.hex) ? castFrom(casts.get(p.hex), castLead) : [];
    if (cast.length > 1) {
      const pts = cast.map(c => f.xy(c.lat, c.lon)), n = pts.length;
      const half = cast.map((c, i) => {
        const u = pts[Math.max(0, i - 1)], v = pts[Math.min(n - 1, i + 1)];
        const len = Math.hypot(v[0] - u[0], v[1] - u[1]) || 1, nx = -(v[1] - u[1]) / len, ny = (v[0] - u[0]) / len;
        // the disc's footprint is an ellipse, long towards the body: its half-width
        // square to the line (north is up: azimuth a is the screen direction sin a, -cos a)
        const a = c.az * D2R, m = f.ppm(c.lat);
        const w = Math.hypot(c.along * m * (nx * Math.sin(a) - ny * Math.cos(a)), c.across * m * (nx * Math.cos(a) + ny * Math.sin(a)));
        return [nx * w, ny * w, w];
      });
      if (half.some(h => h[2] >= 1)) {
        mctx.fillStyle = col + '38';
        mctx.beginPath();
        pts.forEach(([px, py], i) => mctx.lineTo(px + half[i][0], py + half[i][1]));
        for (let i = n - 1; i >= 0; i--) mctx.lineTo(pts[i][0] - half[i][0], pts[i][1] - half[i][1]);
        mctx.closePath(); mctx.fill();
      }
      // in the inset, traffic that comes nowhere near you gets the bare line, faint:
      // forty of them with every mark would bury the two that matter
      const bare = far && !big;
      mctx.strokeStyle = col + (bare ? '70' : far ? 'b0' : ''); mctx.lineWidth = far ? 1 : 2;
      mctx.beginPath();
      pts.forEach(([px, py], i) => i ? mctx.lineTo(px, py) : mctx.moveTo(px, py));
      mctx.stroke();
      if (bare) { mctx.fillStyle = col; mctx.beginPath(); mctx.arc(x, y, 2.5, 0, 2 * Math.PI); mctx.fill(); continue; }
      // which way the spot runs along it, and (enlarged) when it gets where
      const [ex, ey] = pts[n - 1], dir = Math.atan2(ey - pts[n - 2][1], ex - pts[n - 2][0]), hs = far ? 4 : 6;
      mctx.fillStyle = col + (far ? 'b0' : '');
      mctx.beginPath();
      mctx.moveTo(ex + Math.cos(dir) * hs, ey + Math.sin(dir) * hs);
      mctx.lineTo(ex + Math.cos(dir + 2.5) * hs, ey + Math.sin(dir + 2.5) * hs);
      mctx.lineTo(ex + Math.cos(dir - 2.5) * hs, ey + Math.sin(dir - 2.5) * hs);
      mctx.closePath(); mctx.fill();
      if (big && !far) for (const T of [30, 60]) {
        const c = castFrom(cast, castLead + T)[0];
        if (!c) continue;
        const [tx, ty] = f.xy(c.lat, c.lon);
        mctx.fillRect(tx - 1.5, ty - 1.5, 3, 3);
        mctx.fillText(`+${T}s`, tx + 5, ty - 4);
      }
      const [sx, sy] = pts[0];
      mctx.strokeStyle = col + (far ? '40' : '80'); mctx.lineWidth = 1; mctx.setLineDash([2, 4]);
      mctx.beginPath(); mctx.moveTo(x, y); mctx.lineTo(sx, sy); mctx.stroke();
      mctx.setLineDash([]);
      mctx.strokeStyle = col; mctx.lineWidth = 1.25;
      mctx.beginPath(); mctx.arc(sx, sy, big ? 3.5 : 2.5, 0, 2 * Math.PI); mctx.stroke();
    }

    mctx.fillStyle = col;
    if (!big) { mctx.beginPath(); mctx.arc(x, y, 2.5, 0, 2 * Math.PI); mctx.fill(); continue; }
    if (!onMap(x, y, 60)) continue;
    const tr = p.track * D2R, fx = Math.sin(tr), fy = -Math.cos(tr);
    mctx.beginPath();
    mctx.moveTo(x + fx * 7, y + fy * 7);
    mctx.lineTo(x - fx * 5 - fy * 4.5, y - fy * 5 + fx * 4.5);
    mctx.lineTo(x - fx * 2, y - fy * 2);
    mctx.lineTo(x - fx * 5 + fy * 4.5, y - fy * 5 - fx * 4.5);
    mctx.closePath(); mctx.fill();
    mctx.globalAlpha = far ? 0.75 : 1;
    mctx.fillText(`${p.flight} ${(p.altM / 1000).toFixed(1)} km up`, x + 9, y + 4);
    mctx.globalAlpha = 1;
  }

  // observer
  mctx.fillStyle = sky.observer;
  mctx.beginPath(); mctx.arc(ox, oy, big ? 4 : 2.5, 0, 2 * Math.PI); mctx.fill();
  if (big) {
    mctx.strokeStyle = sky.observer + '99'; mctx.lineWidth = 1.5;
    mctx.beginPath(); mctx.arc(ox, oy, 8, 0, 2 * Math.PI); mctx.stroke();
    mctx.fillText('you', ox + 12, oy + 4);
  }
}

// ----- the big map: open, close, drag, zoom -----
let mapDrawQueued = false;
function requestMapDraw() {        // a redraw outside the tick: a tile arrived, or the view moved
  if (mapDrawQueued || !window.requestAnimationFrame) return;
  mapDrawQueued = true;
  requestAnimationFrame(() => {
    mapDrawQueued = false;
    if (started && target && mapShown()) renderMap(Date.now(), false);
  });
}
function setMapBig(on) {
  mapView.big = on;
  renderSkyCtl();
  if (started) render();
}
// zoom by `factor` about a point of the view (its middle, without one)
function zoomMap(factor, x, y) {
  const f = mapFrame(), mid = x == null;
  const zMax = Math.max(1, Math.cos(f.lat * D2R) / f.fit / MAP_MIN_MPP);
  const zoom = Math.max(MAP_ZOOM_OUT, Math.min(zMax, mapView.zoom * factor));
  if (zoom === mapView.zoom) return;
  if (!mid || mapView.lat != null) {             // keep the ground under (x, y) where it is
    if (mid) { x = f.W / 2; y = f.H / 2; }
    const g = f.at(x, y), scale = f.fit * zoom;
    mapView.lon = (mercX(g.lon) - (x - f.W / 2) / scale) / MERC_R * R2D;
    mapView.lat = mercLat(mercY(g.lat) + (y - f.H / 2) / scale);
  }
  mapView.zoom = zoom;
  renderSkyCtl(); requestMapDraw();
}
function panMap(dx, dy) {
  const f = mapFrame(), c = f.at(f.W / 2 - dx, f.H / 2 - dy);
  mapView.lat = Math.max(-84, Math.min(84, c.lat)); mapView.lon = c.lon;
  renderSkyCtl(); requestMapDraw();
}
function mapHome() {
  mapView.lat = mapView.lon = null; mapView.zoom = 1;
  renderSkyCtl(); requestMapDraw();
}
mapBox.addEventListener('click', () => { if (!mapView.big) setMapBig(true); });
mapBox.addEventListener('dblclick', e => {
  const r = mapBox.getBoundingClientRect();
  if (mapView.big) zoomMap(2, e.clientX - r.left, e.clientY - r.top);
});
mapBox.addEventListener('wheel', e => {
  if (!mapView.big) return;
  e.preventDefault();
  const r = mapBox.getBoundingClientRect();
  zoomMap(Math.exp(-Math.max(-150, Math.min(150, e.deltaY)) / 300), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });
const mapPtrs = new Map();     // pointers down on the big map: one drags it, two pinch it
mapBox.addEventListener('pointerdown', e => {
  if (!mapView.big) return;
  mapPtrs.set(e.pointerId, [e.clientX, e.clientY]);
  try { mapBox.setPointerCapture(e.pointerId); } catch (err) { /* gone already */ }
});
mapBox.addEventListener('pointermove', e => {
  const was = mapPtrs.get(e.pointerId);
  if (!was) return;
  const other = [...mapPtrs].find(([id]) => id !== e.pointerId);
  mapPtrs.set(e.pointerId, [e.clientX, e.clientY]);
  if (!other) { panMap(e.clientX - was[0], e.clientY - was[1]); return; }
  const [qx, qy] = other[1], r = mapBox.getBoundingClientRect();
  const d0 = Math.hypot(was[0] - qx, was[1] - qy), d1 = Math.hypot(e.clientX - qx, e.clientY - qy);
  panMap((e.clientX - was[0]) / 2, (e.clientY - was[1]) / 2);
  if (d0 > 10 && d1 > 10) zoomMap(d1 / d0, (e.clientX + qx) / 2 - r.left, (e.clientY + qy) / 2 - r.top);
});
for (const type of ['pointerup', 'pointercancel'])
  mapBox.addEventListener(type, e => mapPtrs.delete(e.pointerId));

// ---------- tables & header ----------
const $ = id => document.getElementById(id);
function fmtSep(sep) { return (sep / target.angR).toFixed(1) + ' R'; }
// predicted miss, with where it stood a few fixes ago when that has moved: 1.2→0.4 R
function fmtMiss(p) {
  const from = missFrom(p);
  return (from == null ? '' : (from / target.angR).toFixed(1) + '→') + fmtSep(p.pred.sepMin);
}
// an arrow pointing the way the plane crosses the sky (pred.dir: 0 = up, 90 = right)
const DIR_SVG = '<svg class="dir" viewBox="-6 -6 12 12" aria-hidden="true">'
  + '<path d="M0-5.5 5 1H1.6V5.5H-1.6V1H-5Z" fill="currentColor"/></svg>';
const dirArrow = deg => DIR_SVG.replace('<path', `<path transform="rotate(${deg.toFixed(0)})"`);

function renderTables() {
  const list = [...planes.values()].filter(p => p.pred);

  const passes = list.filter(p => cfg.showNear
      ? p.pred.sepMin < 5 * target.angR && p.pred.samples.some(s => s.el > 0)
      : p.klass === 'transit')
    .sort((a, b) => a.pred.tMin - b.pred.tMin);
  const pb = $('passTable').tBodies[0];
  pb.innerHTML = passes.map(p => `<tr class="${p.klass}">
    <td>${p.flight}${alerted.has(p.hex) ? ' ♪' : ''}</td><td>${dirArrow(p.pred.dir)}</td><td>${p.pred.tMin}s</td>
    <td>${fmtMiss(p)}</td><td>${fmtSep(p.pred.delta)}</td>
    <td>${p.trust}${p.maneuvering ? ' ⚠' : p.turn ? ' ↻' : ''}</td></tr>`).join('');
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
  $('ncDir').style.transform = `rotate(${pr.dir.toFixed(0)}deg)`;
  $('ncSub').textContent = `miss ${fmtMiss(p)} ± `
    + `${(pr.delta / target.angR).toFixed(1)} · trust ${p.trust}${p.maneuvering ? ' ⚠ turning' : p.turn ? ' ↻ turning' : ''}`
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
// With the map enlarged the same − / + zoom the map, and the figure between them is
// how much ground it shows.
function renderSkyCtl() {
  const big = mapView.big;
  mapBox.hidden = !mapShown();
  mapBox.classList.toggle('big', big);           // before mapFrame(): it sizes the box
  if (big) {
    const f = mapFrame(), mpp = Math.cos(f.lat * D2R) / f.scale;
    $('spanVal').textContent = fmtDist(f.W * mpp);
    $('spanIn').disabled = mpp <= MAP_MIN_MPP * 1.01;
    $('spanOut').disabled = mapView.zoom <= MAP_ZOOM_OUT;
  } else {
    $('spanVal').textContent = cfg.spanDeg + '°';
    $('spanIn').disabled = cfg.spanDeg === SPANS[0];
    $('spanOut').disabled = cfg.spanDeg === SPANS[SPANS.length - 1];
  }
  $('spanVal').title = big ? 'Width of the map' : 'Height of the view';
  $('btnNear').classList.toggle('on', cfg.showNear);
  $('btnMapToggle').classList.toggle('on', mapShown());
  $('btnMapToggle').textContent = big ? 'sky view' : 'map';
  $('btnMapToggle').title = big ? 'Back to the sky view' : 'Top-down map';
  $('mapHomeWrap').hidden = !(big && (mapView.lat != null || mapView.zoom !== 1));
  $('legendMap').hidden = !big; $('legendSky').hidden = big;
}
$('spanIn').addEventListener('click', () => (mapView.big ? zoomMap(2) : setSpan(-1)));
$('spanOut').addEventListener('click', () => (mapView.big ? zoomMap(0.5) : setSpan(+1)));
$('btnMapHome').addEventListener('click', mapHome);
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
  if (mapView.big) { setMapBig(false); return; }
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
  else if (!$('legend').hidden) { $('legend').hidden = true; $('btnLegend').classList.remove('on'); }
  else if (mapView.big) setMapBig(false);
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
    chime(CALLED_OFF, 0.06, t - ac.currentTime + 1.5);   // and what a call-off sounds like
  }
  $('soundTestNote').textContent = ok
    ? 'Played heads-up → countdown blips → on-disc tone, then the called-off chime (a plane '
      + 'that drifted off track). Too quiet? Pick a louder level and test again.'
    : 'No audio: the browser is blocking it, or this device has no output.';
});
document.addEventListener('click', ensureAudio);   // browsers need a gesture first
// back on screen (from the camera app, say): wake the context before the next cue
document.addEventListener('visibilitychange', () => { if (!document.hidden && audioCtx) ensureAudio(); });

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
//  1. heads-up: a rising two-note chime when a plane becomes a confident transit,
//     up to ARM_S (90 s) out — again if it comes back after being called off;
//  2. countdown: parking-sensor blips, one pitch, spaced a tenth of the time left
//     (5 s apart at 50 s+, 2 s at 20 s, 0.5 s at 5 s, never under 0.15 s);
//  3. on the disc: a steady tone held from predicted entry to exit — "shoot now";
//  4. called off: the falling two-note if the prediction drifts to a clear miss
//     before the pass — a turn, a lost plane — so silence never has to be interpreted.
// cfg.sound off means no audio node is created at all; cfg.soundVol scales every
// gain, because a level that is a gentle nudge indoors is inaudible outdoors.
let audioCtx = null;
const alerted = new Map();     // hex -> 1 once the heads-up has played (drives the ♪)
const armed = new Set();       // hexes currently counted down
const BEEP_HZ = 880;
const ARM_S = PREDICT_S;       // heads-up this far ahead: the whole prediction window
const LOOKAHEAD_S = 0.12;      // how far ahead the 50 ms scheduler commits sound
const cd = { lastBeep: -Infinity, toneFor: null };   // countdown scheduler state

function ensureAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) {
    audioCtx = new AC();
    audioCtx.addEventListener('statechange', renderSoundBtn);   // "tap to enable" → "on"
  }
  // not just 'suspended' (no gesture yet): iOS reports 'interrupted' after the page
  // was in the background — camera app, lock screen, a call — and a context left
  // there stayed silent until a reload, taps on "tap to enable" included
  if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
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

function chime(notes, peak, delay = 0) {
  const ac = ensureAudio();
  if (!ac) return false;
  for (const [freq, at] of notes) note(ac, freq, ac.currentTime + delay + at, 0.55, peak, 0.05);
  return true;
}
const blip = (ac, when) => note(ac, BEEP_HZ, when, 0.07, 0.05, 0.008);
const holdTone = (ac, when, dur) => note(ac, BEEP_HZ, when, dur, 0.045, 0.02, true);
const HEADS_UP = [[784, 0], [1046.5, 0.18]];
const CALLED_OFF = [[1046.5, 0], [784, 0.16]];

// seconds between blips, given seconds left until the tone starts: a tenth of it,
// so the cadence itself says how long is left, up to one blip in 5 s far out
function beepGap(sLeft) { return Math.min(5, Math.max(0.15, sLeft / 10)); }

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
// current target), data is fresh and steady, and the fix is good enough to be a
// real bet rather than a coin flip. That last test leaves out the uncertainty that
// grows with lead time (`delta0`, not `delta`): with it, a plane 16 km out, the
// moon at 40 deg, armed only ~25 s ahead whatever ARM_S said. If an early bet
// drifts, the called-off chime says so.
function alertWorthy(p) {
  return p.klass === 'transit' && p.trust === 'high' &&
    p.pred.delta0 <= 3 * target.angR && p.pred.tBest <= ARM_S;
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
      // Only an announced plane is called off, and not one that passed on the disc.
      // A plane turning away is "passed" too — its closest approach becomes now — so
      // it is the miss, not the timing, that decides. Called off, it is forgotten:
      // if it comes back on track, it gets a fresh heads-up.
      if (!stillOn && alerted.has(hex) && cd.toneFor !== hex) {
        chime(CALLED_OFF, 0.06);
        alerted.delete(hex);
      }
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
// What the marked passes say together: the typical real − predicted, and how far the
// marks scatter around it (median and median deviation: one fumbled press must not
// move either). A steady offset larger than the scatter is a timing bias — a delayed
// feed makes planes arrive early, i.e. negative. It is reported, never applied: three
// presses with a finger's reaction time in them are evidence, not a calibration.
function passLogOffset(rows) {
  const d = rows.filter(r => r.seen != null).map(r => (r.seen - r.mid) / 1000).sort((a, b) => a - b);
  if (d.length < 3) return null;
  const mid = a => (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2);
  const median = mid(d), spread = mid(d.map(x => Math.abs(x - median)).sort((a, b) => a - b));
  return { n: d.length, median, spread, steady: Math.abs(median) > Math.max(0.3, spread) };
}

function renderPassLog() {
  const t = ms => new Date(ms).toLocaleTimeString([], { hour12: false }) + '.' + Math.floor(ms % 1000 / 100);
  const arrow = (up, side) => `${up >= 0 ? '↑' : '↓'}${Math.abs(up).toFixed(2)} ${side >= 0 ? '→' : '←'}${Math.abs(side).toFixed(2)}`;
  $('passLogTable').tBodies[0].innerHTML = passLog.slice(-8).reverse().map(r => `<tr>
    <td>${t(r.mid)}</td><td>${r.flight}</td><td>${arrow(r.up, r.side)}</td>
    <td>${r.missR}R ${r.rangeKm}km</td>
    <td>${r.seen == null ? '—' : ((r.seen - r.mid) / 1000 > 0 ? '+' : '') + ((r.seen - r.mid) / 1000).toFixed(1) + 's'}</td></tr>`).join('');
  $('passLogEmpty').style.display = passLog.length ? 'none' : '';
  const o = passLogOffset(passLog), note = $('passLogOffset');
  note.hidden = !o;
  if (o) {
    note.textContent = `${o.n} marked passes: typically ${o.median > 0 ? '+' : ''}${o.median.toFixed(1)} s, `
      + `most within ±${o.spread.toFixed(1)} s — `
      + (!o.steady ? 'no steady offset'
        : o.median < 0 ? 'planes come earlier than predicted, the way a delayed feed makes them'
          : 'planes come later than predicted');
  }
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
// Between ticks only the drawing moves: the same prediction, shown for each frame's
// own moment, ~30 times a second. Nothing is computed that a tick does not compute,
// so with reduced motion asked for (or no frames, in a hidden tab) the view is just
// the once-a-second one again.
// Drawing reads the planes and writes nothing the prediction, the tables or the tone
// read (a test holds it to that). What it could still do is hog the one thread the
// 20 Hz tone scheduler and the tick run on, so it never takes more than a quarter of
// it: a frame that took 20 ms to draw is followed by 80 ms of nothing.
const calmMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
let nextFrame = 0;
function animate(ts) {
  requestAnimationFrame(animate);
  if (!started || !target || !planes.size || (calmMotion && calmMotion.matches) || ts < nextFrame) return;
  const t0 = performance.now();
  render(Date.now(), true);
  nextFrame = ts + Math.max(30, 4 * (performance.now() - t0));
}
if (window.requestAnimationFrame) requestAnimationFrame(animate);
setInterval(countdownLoop, 50);
setInterval(renderNextCard, 100);
loadServerSite().then(() => {
  applyCfg();   // elevation, geoid and observer from whichever settings won
  if (hasLocation()) start(); else openSetup(true);
});
