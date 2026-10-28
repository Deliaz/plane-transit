// Plane Transit server: static files + ADS-B proxy + optional always-on watcher.
// Run: node serve.js → http://<host>:8321
//
// Built to sit on a home Raspberry Pi all day without spending anything:
//  - by default upstream is polled ONLY while a browser is asking for data, never on a
//    timer, so a closed (or hidden, or below-horizon — see app.js) page costs the
//    aggregator nothing at all;
//  - the always-on mode (watch.js) is the one exception, and only when switched on in
//    the settings file: it polls at a pace that follows the sky, and not at all while
//    the watched bodies are down;
//  - however many browsers and tabs are open, upstream sees at most one request per
//    CACHE_MS: they all share one snapshot, and the watcher shares it too;
//  - every upstream request passes one budget: half the aggregator's published rate,
//    a daily ceiling, and a growing back-off after any refusal;
//  - PLANE_TRANSIT_LOCAL_URL merges a local ADS-B receiver's aircraft.json in as an extra
//    source, per aircraft, whenever its fix is fresher (see mergeFeeds).
//
// Read-only endpoints for other programs (dashboards, notifiers): /api/state (the
// watcher's predictions) and /metrics (Prometheus text, the service's own health).
'use strict';
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');
const zlib = require('zlib');
const config = require('./config.js');
const { createWatcher } = require('./watch.js');

const ROOT = __dirname;
const PORT = Number(process.env.PLANE_TRANSIT_PORT || 8321);
const BIND = process.env.PLANE_TRANSIT_BIND || '0.0.0.0';
const LOCAL_URL = process.env.PLANE_TRANSIT_LOCAL_URL || '';   // e.g. http://localhost:8080/data/aircraft.json
// Settings shared by every device, and the always-on switch. Outside the deploy
// directory by default, which a redeploy (rsync --delete) would otherwise wipe.
const CONFIG_PATH = process.env.PLANE_TRANSIT_CONFIG || config.DEFAULT_PATH;
const CONFIG_WRITABLE = process.env.PLANE_TRANSIT_CONFIG_READONLY !== '1';
// Optional HTTPS, alongside plain HTTP. A phone opening the page over http on the LAN
// is not a secure context, so the browser withholds geolocation and the screen wake
// lock the countdown relies on. deploy/make-cert.sh fills this directory.
const TLS_DIR = process.env.PLANE_TRANSIT_TLS_DIR || '';        // server.crt, server.key, ca.crt
const TLS_PORT = Number(process.env.PLANE_TRANSIT_TLS_PORT || 8443);
const tlsFile = f => (TLS_DIR ? path.join(TLS_DIR, f) : '');
const TLS_ON = !!TLS_DIR && fs.existsSync(tlsFile('server.crt')) && fs.existsSync(tlsFile('server.key'));
const CACHE_MS = 2500;        // upstream snapshot lifetime; client polls every 3 s
const LOCAL_CACHE_MS = 900;   // the receiver rewrites aircraft.json about once a second
const IDLE_MS = 20000;        // no browser asked for this long → idle
const NM = 1852;
const MIME = { '.html': 'text/html', '.js': 'text/javascript' };
const UA = 'plane-transit (+https://github.com/Deliaz/plane-transit)';
// Everything the page needs, and nothing else. Serving the directory would hand
// .git/, the deploy scripts and anything else in the checkout to the whole network.
// A new file the page loads has to be added here.
const STATIC = {
  '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js',
  '/geoid.js': 'geoid.js', '/engine.js': 'engine.js', '/astronomy.browser.min.js': 'astronomy.browser.min.js',
};
// Upstream budget, shared by every browser this server answers and the watcher. One
// person watching costs a request per ~3 s; the cap only bites if the port is
// reachable by strangers, who then get 429s rather than spending the aggregator's
// goodwill in our name. It is half adsb.fi's published limit of 1 request per second.
// The daily ceiling is a fuse, not a target: always-on mode uses ~5,000 a day.
const UPSTREAM_MAX = 5, UPSTREAM_WINDOW_MS = 10000;
const UPSTREAM_DAILY_MAX = 20000;
// adsb.fi counts refused requests (4xx, 429 included) against the limit and may block
// an IP that keeps making them, so a refusal stops all upstream traffic for a while,
// doubling each time it happens again: 30 s, 1 min, 2 min … 15 min.
const BACKOFF_MS = 30000, BACKOFF_MAX_MS = 15 * 60000;
const SNAP_MAX = 20e6;        // /api/snap body cap (a full-page PNG is a few MB)

// ADS-B APIs don't send CORS headers, so the browser can't call them directly
const UPSTREAM = {
  adsbfi: (lat, lon, r) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${r}`,
  adsblol: (lat, lon, r) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${r}`,
};

const stats = {
  started: Date.now(), lastClient: 0, clientReqs: 0,
  upstreamReqs: 0, upstreamErrors: 0, upstreamLimited: 0, sharedHits: 0, lastError: null,
  upstreamToday: 0, upstreamDay: '', backoffUntil: 0, backoffCount: 0,
  local: { url: LOCAL_URL || null, ok: 0, fail: 0, lastCount: 0, lastLagS: null, lastError: null },
};
const isActive = () => Date.now() - stats.lastClient < IDLE_MS;

function getJSON(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    // gzip: an aircraft list compresses ~8x, and the aggregator's bandwidth is the
    // other half of its goodwill. The user agent says who is asking and where to look.
    const headers = { 'User-Agent': UA, Accept: 'application/json', 'Accept-Encoding': 'gzip' };
    const req = mod.get(url, { headers }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(Object.assign(new Error('HTTP ' + res.statusCode), { status: res.statusCode }));
      }
      let stream = res;
      if (/\bgzip\b/i.test(res.headers['content-encoding'] || '')) {
        stream = res.pipe(zlib.createGunzip());
        stream.on('error', e => { reject(new Error('bad gzip: ' + e.message)); req.destroy(); });
      }
      let body = '';
      stream.setEncoding('utf8');
      stream.on('data', c => { body += c; if (body.length > 8e6) req.destroy(new Error('response too large')); });
      stream.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('bad JSON')); } });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const upstreamTimes = [];
function upstreamAllowed(now = Date.now()) {
  while (upstreamTimes.length && now - upstreamTimes[0] >= UPSTREAM_WINDOW_MS) upstreamTimes.shift();
  if (upstreamTimes.length >= UPSTREAM_MAX) return false;
  upstreamTimes.push(now);
  return true;
}

// Why upstream may not be asked right now, or null (and the request is counted).
function upstreamRefusal(now = Date.now()) {
  if (now < stats.backoffUntil) return `backing off after ${stats.lastError || 'a refusal'}`;
  const day = new Date(now).toDateString();
  if (day !== stats.upstreamDay) { stats.upstreamDay = day; stats.upstreamToday = 0; }
  if (stats.upstreamToday >= UPSTREAM_DAILY_MAX) return 'daily upstream budget used up';
  if (!upstreamAllowed(now)) return 'upstream budget exceeded';
  stats.upstreamToday++;
  return null;
}

function upstreamResult(err, now = Date.now()) {
  if (!err) { stats.backoffCount = 0; return; }
  if (!(err.status >= 400 && err.status < 500)) return;   // timeouts, 5xx: just the next poll
  const ms = Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** stats.backoffCount);
  stats.backoffCount++;
  stats.backoffUntil = now + ms;
  log(`upstream refused (HTTP ${err.status}): no upstream requests for ${Math.round(ms / 1000)} s`);
}

// One in-flight fetch per key: browsers arriving while it is running wait for the
// same answer instead of each starting their own. Resolves to { at, data } — callers
// MUST age `seen_pos` by `now - at`, or a shared snapshot silently claims to be
// fresher than it is and every reader over-trusts a stale fix.
const cache = new Map();
function cached(key, ttl, fetcher) {
  const e = cache.get(key) || {};
  if (e.data && Date.now() - e.at < ttl) { stats.sharedHits++; return Promise.resolve(e); }
  if (e.inflight) { stats.sharedHits++; return e.inflight; }
  if (cache.size > 20) cache.clear();
  const inflight = fetcher().then(
    data => { const fresh = { at: Date.now(), data, inflight: null }; cache.set(key, fresh); return fresh; },
    err => { cache.set(key, { at: 0, data: e.data, inflight: null }); throw err; });
  cache.set(key, { at: e.at || 0, data: e.data, inflight });
  return inflight;
}

// A record the browser can actually fly: position, speed, track and an altitude.
// Records missing any of it are dropped here so a fresher-but-useless local fix
// never displaces a complete one from the public feed.
function usable(a) {
  return a && typeof a.lat === 'number' && typeof a.lon === 'number' &&
    typeof a.gs === 'number' && typeof a.track === 'number' && a.alt_baro !== 'ground' &&
    (typeof a.alt_geom === 'number' || typeof a.alt_baro === 'number');
}
const ageOf = a => (typeof a.seen_pos === 'number' ? a.seen_pos : 999);

const D2R = Math.PI / 180;
function distM(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * D2R, dLon = (lon2 - lon1) * D2R;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return 6371008.8 * 2 * Math.asin(Math.min(1, Math.sqrt(s)));
}

// The local receiver's own aircraft.json, cut down to the same search circle.
async function localAircraft(lat, lon, rNm) {
  const { data } = await cached('local', LOCAL_CACHE_MS, () => getJSON(LOCAL_URL, 2500));
  // seen_pos is relative to data.now, written up to a second before we read it — and
  // that timestamp comes from this machine's clock, so the correction is exact.
  // (data.now already accounts for our own cache age, being an absolute timestamp.)
  const lag = Math.max(0, Date.now() / 1000 - (Number(data.now) || 0));
  const out = [];
  for (const a of data.aircraft || []) {
    if (!usable(a) || distM(lat, lon, a.lat, a.lon) > rNm * NM) continue;
    out.push(Object.assign({}, a, { seen_pos: ageOf(a) + lag, _src: 'local' }));
  }
  stats.local.ok++; stats.local.lastCount = out.length;
  stats.local.lastLagS = Number(lag.toFixed(2)); stats.local.lastError = null;
  return out;
}

// Public feed first, local receiver as an addition: it wins an aircraft only when its
// fix is meaningfully fresher (0.5 s, so near-ties don't flip the source every poll),
// and contributes aircraft the public feed doesn't carry at all.
function mergeFeeds(pub, loc) {
  const by = new Map();
  for (const a of pub) if (usable(a)) by.set(String(a.hex).toLowerCase(), Object.assign({}, a, { _src: 'public' }));
  let fresher = 0, added = 0;
  for (const a of loc) {
    const k = String(a.hex).toLowerCase(), cur = by.get(k);
    if (!cur) { by.set(k, a); added++; }
    else if (ageOf(a) + 0.5 < ageOf(cur)) { by.set(k, a); fresher++; }
  }
  return { list: [...by.values()], fresher, added };
}

const planesKey = (src, la, lo, r) => `${src}|${la}|${lo}|${r}`;

// One area's aircraft, public feed and local receiver merged, every seen_pos aged to
// this moment. `since` makes it a peek: only a public snapshot newer than that, already
// fetched by someone else, and null otherwise — the watcher reading along with a
// browser without ever adding a request of its own.
async function snapshot({ src, lat, lon, r }, since = null, useLocal = !!LOCAL_URL) {
  // The browser already sends 0.01 deg; rounding here too keeps a caller that sends
  // more digits from minting a fresh cache key (and upstream request) per position.
  const la = lat.toFixed(2), lo = lon.toFixed(2);
  const key = planesKey(src, la, lo, r);
  const meta = { src, local: null };
  let pubP;
  if (since != null) {
    const e = cache.get(key);
    if (!e || !e.data || e.at <= since) return null;
    pubP = Promise.resolve(e);
  } else {
    pubP = cached(key, CACHE_MS, () => {
      const why = upstreamRefusal();
      if (why) {
        stats.upstreamLimited++;
        return Promise.reject(Object.assign(new Error(why), { status: 429 }));
      }
      stats.upstreamReqs++;
      return getJSON(UPSTREAM[src](la, lo, r), 5000).then(
        d => { upstreamResult(null); return d; },
        e => { upstreamResult(e); throw e; });
    }).catch(e => {
      stats.upstreamErrors++; stats.lastError = `${src}: ${e.message}`;
      meta.publicError = e.message; meta.publicStatus = e.status || null;
      return null;
    });
  }
  const [pubEntry, loc] = await Promise.all([
    pubP,
    useLocal ? localAircraft(lat, lon, r).catch(e => {
      stats.local.fail++; stats.local.lastError = e.message;
      meta.localError = e.message;
      return [];
    }) : Promise.resolve([]),
  ]);

  // A snapshot shared with other browsers is up to CACHE_MS old, and the aggregator's
  // seen_pos was measured before that. Hand on the true age: the browser dead-reckons
  // from it, so an unaged fix quietly moves the plane by speed × cache age.
  const pub = pubEntry && pubEntry.data;
  const cacheAgeS = pubEntry ? (Date.now() - pubEntry.at) / 1000 : 0;
  const pubList = (pub ? (pub.aircraft || pub.ac || []) : [])
    .map(a => (cacheAgeS > 0.05 ? Object.assign({}, a, { seen_pos: ageOf(a) + cacheAgeS }) : a));
  meta.cacheAgeS = Number(cacheAgeS.toFixed(2));
  if (!pub && !loc.length) return { ok: false, at: Date.now(), list: [], meta };
  const merged = mergeFeeds(pubList, loc);
  meta.public = pubList.filter(usable).length;
  meta.local = LOCAL_URL ? { inRange: loc.length, fresher: merged.fresher, extra: merged.added } : null;
  meta.total = merged.list.length;
  return { ok: true, at: pubEntry ? pubEntry.at : Date.now(), list: merged.list, meta };
}

async function servePlanes(req, res, params) {
  const lat = parseFloat(params.get('lat')), lon = parseFloat(params.get('lon'));
  const r = Math.max(1, Math.min(parseInt(params.get('r'), 10) || 30, 250));
  const src = UPSTREAM[params.get('src')] ? params.get('src') : 'adsbfi';
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) { res.writeHead(400); return res.end('bad params'); }
  const wasActive = isActive();
  stats.lastClient = Date.now(); stats.clientReqs++;
  if (!wasActive) log(`active — a browser is watching (${src}, ${r} nm)`);

  const snap = await snapshot({ src, lat, lon, r }, null, !!LOCAL_URL && params.get('local') !== '0');
  if (!snap.ok) {
    res.writeHead(snap.meta.publicStatus === 429 ? 429 : 502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ aircraft: [], _meta: snap.meta }));
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ now: Date.now() / 1000, aircraft: snap.list, _meta: snap.meta }));
}

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// ---------- settings file + always-on watcher ----------
// `fileWatch` is what the file says; `settings.watch` adds PLANE_TRANSIT_WATCH on top.
// Only the former is ever written back, so an environment override never sticks.
let fileWatch = config.normalizeWatch({});
let settings = { site: null, watch: fileWatch };
const watcher = createWatcher({ snapshot, isBrowserActive: isActive, log });
watcher.setConfig(settings);

function loadSettings() {
  const c = config.loadConfig(CONFIG_PATH, log);
  fileWatch = c.watch;
  settings = { site: c.site, watch: config.applyWatchEnv(c.watch, process.env.PLANE_TRANSIT_WATCH) };
  watcher.setConfig(settings);
  return settings;
}

const sendJSON = (res, status, obj) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};
const configView = () => ({ site: settings.site, watch: settings.watch, writable: CONFIG_WRITABLE });

// The page saves the site settings here so every device shares one setup. Only the
// site: the always-on switch is the box owner's, in the file. JSON only, so a page on
// another origin can't send it without a CORS preflight, which this server never
// answers; small, and validated field by field.
function putConfig(req, res) {
  if (!CONFIG_WRITABLE) return sendJSON(res, 403, { error: 'settings are read-only on this server' });
  if (!/^application\/json\b/.test(req.headers['content-type'] || '')) { res.writeHead(415); return res.end(); }
  let body = '', size = 0;
  req.setEncoding('utf8');
  req.on('data', c => { size += c.length; if (size <= 16384) body += c; });
  req.on('end', () => {
    if (size > 16384) { res.writeHead(413); return res.end(); }
    let site;
    try { site = config.normalizeSite((JSON.parse(body) || {}).site); } catch (e) { site = null; }
    if (!site) return sendJSON(res, 400, { error: 'expected {"site": {"lat": …, "lon": …}}' });
    try {
      config.saveConfig(CONFIG_PATH, { site, watch: fileWatch });
    } catch (e) {
      log(`config: cannot write ${CONFIG_PATH}: ${e.message}`);
      return sendJSON(res, 500, { error: 'could not save the settings' });
    }
    if (JSON.stringify(site) !== JSON.stringify(settings.site)) log('settings: site changed by a browser');
    settings = { ...settings, site };
    watcher.setConfig(settings);
    sendJSON(res, 200, configView());
  });
}

// Prometheus text format: the service's own health, for any monitoring stack. Counters
// reset when the server restarts, which rate()/increase() expect.
const MODES = ['unconfigured', 'off', 'browser', 'paused', 'idle', 'burst'];
function metrics() {
  const now = Date.now(), st = watcher.state(), w = st.watch;
  const out = [];
  const m = (name, type, help, samples) => {
    out.push(`# HELP plane_transit_${name} ${help}`, `# TYPE plane_transit_${name} ${type}`);
    for (const [labels, v] of samples) out.push(`plane_transit_${name}${labels} ${v == null ? 'NaN' : v}`);
  };
  m('uptime_seconds', 'gauge', 'Seconds since the server started.', [['', Math.round((now - stats.started) / 1000)]]);
  m('client_requests_total', 'counter', 'Aircraft requests from browsers.', [['', stats.clientReqs]]);
  m('shared_hits_total', 'counter', 'Requests answered from the shared snapshot.', [['', stats.sharedHits]]);
  m('upstream_requests_total', 'counter', 'Requests sent to the aggregator.', [['', stats.upstreamReqs]]);
  m('upstream_errors_total', 'counter', 'Aggregator requests that failed or were not sent.', [['', stats.upstreamErrors]]);
  m('upstream_refused_total', 'counter', 'Requests the own budget or back-off kept from the aggregator.', [['', stats.upstreamLimited]]);
  m('upstream_requests_today', 'gauge', 'Aggregator requests sent today (local time).', [['', stats.upstreamToday]]);
  m('upstream_daily_limit', 'gauge', 'Daily ceiling on aggregator requests.', [['', UPSTREAM_DAILY_MAX]]);
  m('upstream_backoff_seconds', 'gauge', 'Seconds of back-off left after a refusal.', [['', Math.max(0, Math.round((stats.backoffUntil - now) / 1000))]]);
  m('local_requests_total', 'counter', 'Reads of the local receiver.', [['{result="ok"}', stats.local.ok], ['{result="fail"}', stats.local.fail]]);
  m('browser_active', 'gauge', '1 while a browser is polling.', [['', isActive() ? 1 : 0]]);
  m('watch_enabled', 'gauge', '1 when always-on mode is switched on.', [['', w.enabled ? 1 : 0]]);
  m('watch_mode', 'gauge', 'The watcher mode (one-hot).', MODES.map(x => [`{mode="${x}"}`, w.mode === x ? 1 : 0]));
  m('watch_interval_seconds', 'gauge', 'Current always-on polling interval, 0 when not polling.', [['', w.intervalS]]);
  m('data_age_seconds', 'gauge', 'Age of the newest aircraft snapshot the watcher has.', [['', w.dataAgeS]]);
  m('aircraft_tracked', 'gauge', 'Aircraft the watcher is tracking.', [['', w.aircraft]]);
  const bodies = Object.entries(st.bodies || {});
  m('body_elevation_degrees', 'gauge', 'Apparent elevation of each watched body.', bodies.map(([b, v]) => [`{body="${b}"}`, v.el]));
  m('body_watching', 'gauge', '1 while a body is up and the data is fresh.', bodies.map(([b, v]) => [`{body="${b}"}`, v.watching ? 1 : 0]));
  return out.join('\n') + '\n';
}

// The request handler never throws: anything unexpected becomes a 500, because one
// malformed request from anywhere on the network must not take the server down.
function handle(req, res) {
  try {
    route(req, res);
  } catch (e) {
    log(`unexpected: ${e.stack || e.message}`);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
}

function route(req, res) {
  const urlPath = req.url.split('?')[0];
  if (urlPath === '/api/planes') {
    const params = new URL(req.url, 'http://x').searchParams;
    return servePlanes(req, res, params).catch(e => {
      log(`unexpected: ${e.stack || e.message}`);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
  }
  if (urlPath === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      ok: true, active: isActive(),
      idleFor: !stats.lastClient ? null : isActive() ? 0 : Math.round((Date.now() - stats.lastClient) / 1000),
      uptimeS: Math.round((Date.now() - stats.started) / 1000), port: PORT,
      tls: TLS_ON ? { port: TLS_PORT } : null, ...stats,
      upstreamDailyMax: UPSTREAM_DAILY_MAX, watch: watcher.state().watch,
    }, null, 2));
  }
  if (urlPath === '/api/state') return sendJSON(res, 200, watcher.state());
  if (urlPath === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(metrics());
  }
  if (urlPath === '/api/config') {
    if (req.method === 'GET') return sendJSON(res, 200, configView());
    if (req.method === 'PUT') return putConfig(req, res);
    res.writeHead(405, { Allow: 'GET, PUT' }); return res.end();
  }
  // The private CA's public certificate, so a phone can fetch and install it before it
  // trusts the https side. Public by nature; the key never leaves the machine that
  // made it. This content type makes iOS and Android offer to install it rather than
  // show it.
  if (urlPath === '/plane-transit-ca.crt' && TLS_ON) {
    return fs.readFile(tlsFile('ca.crt'), (err, data) => {
      if (err) { res.writeHead(404); return res.end('no CA certificate here'); }
      res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert',
        'Content-Disposition': 'attachment; filename="plane-transit-ca.crt"' });
      res.end(data);
    });
  }
  if (urlPath === '/api/snap' && req.method === 'POST') return saveSnap(req, res);
  const name = STATIC[urlPath];
  if (!name) { res.writeHead(404); return res.end('not found'); }
  fs.readFile(path.join(ROOT, name), (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(name)] || 'application/octet-stream',
      // the page and app.js must never be served stale after a deploy
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// Dev aid (AGENTS.md, "Testing"): an agent that cannot take screenshots draws the
// canvases into a PNG, POSTs it here and reads snap.png back. Only from this machine,
// only as image/png — a page on another site can't send that type without a CORS
// preflight, which this server never answers — and only up to SNAP_MAX.
function saveSnap(req, res) {
  const a = req.socket.remoteAddress || '';
  if (!(a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1')) { res.writeHead(403); return res.end(); }
  if (!/^image\/png\b/.test(req.headers['content-type'] || '')) { res.writeHead(415); return res.end(); }
  const chunks = [];
  let size = 0;
  req.on('data', c => {
    size += c.length;
    if (size <= SNAP_MAX) chunks.push(c);
  });
  req.on('end', () => {
    if (size > SNAP_MAX) { res.writeHead(413); return res.end(); }
    fs.writeFile(path.join(ROOT, 'snap.png'), Buffer.concat(chunks), err => {
      res.writeHead(err ? 500 : 200); res.end(err ? err.message : 'ok');
    });
  });
}

function main() {
  loadSettings();
  http.createServer(handle).listen(PORT, BIND, () => {
    const w = settings.watch;
    log(`Plane Transit on http://localhost:${PORT} (bind ${BIND})`);
    log(LOCAL_URL ? `local receiver: ${LOCAL_URL}` : 'local receiver: not configured (PLANE_TRANSIT_LOCAL_URL)');
    log(`settings: ${CONFIG_PATH}${settings.site ? '' : ' (no location yet — set it in the page)'}`);
    log(w.enabled
      ? `always-on: ${w.bodies.join(' + ')} above ${w.minEl}°, every ${w.idleS} s (${w.burstS} s near a pass)`
      : 'idle until a browser opens the page — upstream is only polled on demand');
  });
  watcher.start();

  if (TLS_ON) {
    https.createServer({ cert: fs.readFileSync(tlsFile('server.crt')), key: fs.readFileSync(tlsFile('server.key')) }, handle)
      .listen(TLS_PORT, BIND, () => log(`https on port ${TLS_PORT} (certificate from ${TLS_DIR})`));
  } else if (TLS_DIR) {
    log(`https off: no server.crt/server.key in ${TLS_DIR} yet (run deploy/make-cert.sh)`);
  }

  // Say so when the last browser goes away, so `journalctl -u plane-transit` shows the
  // quiet periods rather than leaving you guessing whether it is still polling.
  let wasActive = false;
  setInterval(() => {
    const now = isActive();
    if (wasActive && !now) log(settings.watch.enabled ? 'no browser watching — always-on carries on'
      : 'idle — no browser watching, upstream polling stopped');
    wasActive = now;
  }, 5000).unref();
}

if (require.main === module) main();
module.exports = { handle, usable, mergeFeeds, upstreamAllowed, upstreamRefusal, upstreamResult, stats,
  getJSON, loadSettings, watcher, UPSTREAM_MAX, UPSTREAM_WINDOW_MS, UPSTREAM_DAILY_MAX, SNAP_MAX };
