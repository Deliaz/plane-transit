// Server-side settings: one JSON file on disk, outside the deploy directory.
//
//   site   where the observer stands and which feed to use. The page edits it (PUT
//          /api/config) so every device shares one setup; it is the same set of fields
//          the settings panel shows under location and data source.
//   watch  the always-on mode. Never written by the page: switching on round-the-clock
//          polling is a decision for whoever runs the box, so it lives in this file (or
//          PLANE_TRANSIT_WATCH) only.
//
// Everything is validated on the way in and on the way out of the file, so a hand
// edit with a typo falls back to a default rather than stopping the server.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { geoidAt } = require('./geoid.js');

// In a directory of its own: the server needs to write there (an atomic save is a
// temporary file plus a rename), and nothing else should be writable with it.
const DEFAULT_PATH = path.join(os.homedir(), '.config', 'plane-transit', 'settings', 'config.json');
const SOURCES = ['adsbfi', 'adsblol', 'mock'];
const BODY_KEYS = ['moon', 'sun'];

const num = (v, def) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// null when there is no usable position: nothing can be predicted without one
function normalizeSite(s) {
  if (!s || typeof s !== 'object') return null;
  const lat = num(s.lat, NaN), lon = num(s.lon, NaN);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
  const geoidAuto = s.geoidAuto !== false;
  return {
    lat: +lat.toFixed(6), lon: +lon.toFixed(6),
    groundM: clamp(num(s.groundM, 0), -500, 9000),
    aboveM: clamp(num(s.aboveM, 1.5), 0, 1000),
    geoidAuto,
    geoidM: geoidAuto ? +geoidAt(lat, lon).toFixed(1) : clamp(num(s.geoidM, 0), -120, 120),
    source: SOURCES.includes(s.source) ? s.source : 'adsbfi',
    radiusNm: Math.round(clamp(num(s.radiusNm, 30), 1, 249)),
    includeLow: s.includeLow === true,
  };
}

// The always-on mode, off unless switched on. Cadences have floors: below 3 s a poll
// would only re-read the shared 2.5 s snapshot, and the idle pace exists to be gentle.
// The sun is never watched unless named: predicting sun transits means aiming at it.
function normalizeWatch(w) {
  w = w && typeof w === 'object' ? w : {};
  const bodies = Array.isArray(w.bodies) ? BODY_KEYS.filter(b => w.bodies.includes(b)) : [];
  return {
    enabled: w.enabled === true,
    bodies: bodies.length ? bodies : ['moon'],
    minEl: clamp(num(w.minEl, 10), 0, 60),
    idleS: clamp(num(w.idleS, 15), 10, 300),
    burstS: clamp(num(w.burstS, 3), 3, 30),
  };
}

// PLANE_TRANSIT_WATCH=moon | moon,sun | off overrides the file's on/off and bodies
function applyWatchEnv(watch, env) {
  if (env == null || env === '') return watch;
  const v = String(env).toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (v.includes('off') || v.includes('0') || v.includes('false')) return { ...watch, enabled: false };
  const bodies = BODY_KEYS.filter(b => v.includes(b));
  return { ...watch, enabled: true, bodies: bodies.length ? bodies : watch.bodies };
}

function loadConfig(file, log = () => {}) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (e) {
    if (e.code !== 'ENOENT') log(`config: cannot read ${file} (${e.message}); using defaults`);
  }
  return { site: normalizeSite(raw.site), watch: normalizeWatch(raw.watch) };
}

// Atomic: a crash mid-write must not leave half a file behind.
function saveConfig(file, cfg) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ site: cfg.site, watch: cfg.watch }, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

module.exports = { DEFAULT_PATH, normalizeSite, normalizeWatch, applyWatchEnv, loadConfig, saveConfig };
