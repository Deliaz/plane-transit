// Plane Transit server: static files + ADS-B proxy. Run: node serve.js → http://<host>:8321
//
// Built to sit on a home Raspberry Pi all day without spending anything:
//  - upstream is polled ONLY while a browser is asking for data, never on a timer, so
//    a closed (or hidden, or below-horizon — see app.js) page costs the aggregator
//    nothing at all;
//  - however many browsers and tabs are open, upstream sees at most one request per
//    CACHE_MS: they all share one snapshot;
//  - PLANE_TRANSIT_LOCAL_URL merges a local ADS-B receiver's aircraft.json in as an extra
//    source, per aircraft, whenever its fix is fresher (see mergeFeeds).
'use strict';
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PLANE_TRANSIT_PORT || 8321);
const BIND = process.env.PLANE_TRANSIT_BIND || '0.0.0.0';
const LOCAL_URL = process.env.PLANE_TRANSIT_LOCAL_URL || '';   // e.g. http://localhost:8080/data/aircraft.json
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
// Everything the page needs, and nothing else. Serving the directory would hand
// .git/, the deploy scripts and anything else in the checkout to the whole network.
// A new file the page loads has to be added here.
const STATIC = {
  '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js',
  '/geoid.js': 'geoid.js', '/astronomy.browser.min.js': 'astronomy.browser.min.js',
};
// Upstream budget, shared by every browser this server answers. One person watching
// costs a request per ~3 s; the cap only bites if the port is reachable by strangers,
// who then get 429s rather than spending the aggregator's goodwill in our name. It
// matches adsb.fi's published limit of 1 request per second.
const UPSTREAM_MAX = 10, UPSTREAM_WINDOW_MS = 10000;
const SNAP_MAX = 20e6;        // /api/snap body cap (a full-page PNG is a few MB)

// ADS-B APIs don't send CORS headers, so the browser can't call them directly
const UPSTREAM = {
  adsbfi: (lat, lon, r) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${r}`,
  adsblol: (lat, lon, r) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${r}`,
};

const stats = {
  started: Date.now(), lastClient: 0, clientReqs: 0,
  upstreamReqs: 0, upstreamErrors: 0, upstreamLimited: 0, sharedHits: 0, lastError: null,
  local: { url: LOCAL_URL || null, ok: 0, fail: 0, lastCount: 0, lastLagS: null, lastError: null },
};
const isActive = () => Date.now() - stats.lastClient < IDLE_MS;

function getJSON(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'plane-transit', Accept: 'application/json' } }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(Object.assign(new Error('HTTP ' + res.statusCode), { status: res.statusCode }));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; if (body.length > 8e6) req.destroy(new Error('response too large')); });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('bad JSON')); } });
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

async function servePlanes(req, res, params) {
  const lat = parseFloat(params.get('lat')), lon = parseFloat(params.get('lon'));
  const r = Math.max(1, Math.min(parseInt(params.get('r'), 10) || 30, 250));
  const src = UPSTREAM[params.get('src')] ? params.get('src') : 'adsbfi';
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) { res.writeHead(400); return res.end('bad params'); }
  // The browser already sends 0.01 deg; rounding here too keeps a caller that sends
  // more digits from minting a fresh cache key (and upstream request) per position.
  const la = lat.toFixed(2), lo = lon.toFixed(2);
  const wasActive = isActive();
  stats.lastClient = Date.now(); stats.clientReqs++;
  if (!wasActive) log(`active — a browser is watching (${src}, ${r} nm)`);

  const useLocal = LOCAL_URL && params.get('local') !== '0';
  const meta = { src, local: null };
  const [pubEntry, loc] = await Promise.all([
    cached(`${src}|${la}|${lo}|${r}`, CACHE_MS, () => {
      if (!upstreamAllowed()) {
        stats.upstreamLimited++;
        return Promise.reject(Object.assign(new Error('upstream budget exceeded'), { status: 429 }));
      }
      stats.upstreamReqs++;
      return getJSON(UPSTREAM[src](la, lo, r), 5000);
    }).catch(e => {
      stats.upstreamErrors++; stats.lastError = `${src}: ${e.message}`;
      meta.publicError = e.message; meta.publicStatus = e.status || null;
      return null;
    }),
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
  if (!pub && !loc.length) {
    res.writeHead(meta.publicStatus === 429 ? 429 : 502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ aircraft: [], _meta: meta }));
  }
  const merged = mergeFeeds(pubList, loc);
  meta.public = pubList.filter(usable).length;
  meta.local = LOCAL_URL ? { inRange: loc.length, fresher: merged.fresher, extra: merged.added } : null;
  meta.total = merged.list.length;
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ now: Date.now() / 1000, aircraft: merged.list, _meta: meta }));
}

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

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
    }, null, 2));
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
  http.createServer(handle).listen(PORT, BIND, () => {
    log(`Plane Transit on http://localhost:${PORT} (bind ${BIND})`);
    log(LOCAL_URL ? `local receiver: ${LOCAL_URL}` : 'local receiver: not configured (PLANE_TRANSIT_LOCAL_URL)');
    log('idle until a browser opens the page — upstream is only polled on demand');
  });

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
    if (wasActive && !now) log('idle — no browser watching, upstream polling stopped');
    wasActive = now;
  }, 5000).unref();
}

if (require.main === module) main();
module.exports = { handle, usable, mergeFeeds, upstreamAllowed, UPSTREAM_MAX, UPSTREAM_WINDOW_MS, SNAP_MAX };
