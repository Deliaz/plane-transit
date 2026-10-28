// serve.js's read-only API (/api/state, /metrics), the settings endpoint and the
// upstream manners: gzip, the user agent, back-off after a refusal, the daily ceiling.
// Nothing here talks to a real aggregator. Run: node --test test/*.test.js
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
// before serve.js is loaded: it reads these once
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-api-'));
process.env.PLANE_TRANSIT_CONFIG = path.join(DIR, 'config.json');
delete process.env.PLANE_TRANSIT_WATCH;

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const zlib = require('zlib');
const serve = require('../serve.js');

function request(port, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
async function withServer(fn) {
  const server = http.createServer(serve.handle);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try { await fn(server.address().port); } finally { server.close(); }
}
const JSONH = { 'Content-Type': 'application/json' };

test('settings: the page shares its site, never the always-on switch', async () => {
  serve.loadSettings();
  await withServer(async port => {
    let r = await request(port, 'GET', '/api/config');
    assert.deepStrictEqual(JSON.parse(r.data).site, null, 'a new server has no location');
    assert.strictEqual(JSON.parse((await request(port, 'GET', '/api/state')).data).configured, false);

    const site = { lat: 51.4778, lon: -0.0014, groundM: 45, aboveM: 1.5, radiusNm: 30, source: 'adsbfi' };
    assert.strictEqual((await request(port, 'PUT', '/api/config', { body: JSON.stringify({ site }) })).status, 415,
      'JSON only, so another origin needs a preflight');
    assert.strictEqual((await request(port, 'PUT', '/api/config', { headers: JSONH, body: '{"site":{"lat":1}}' })).status, 400);
    assert.strictEqual((await request(port, 'PUT', '/api/config', { headers: JSONH, body: 'x'.repeat(20000) })).status, 413);
    assert.strictEqual((await request(port, 'POST', '/api/config', { headers: JSONH, body: '{}' })).status, 405);

    r = await request(port, 'PUT', '/api/config', { headers: JSONH,
      body: JSON.stringify({ site, watch: { enabled: true, bodies: ['sun'] } }) });
    assert.strictEqual(r.status, 200);
    const saved = JSON.parse(fs.readFileSync(process.env.PLANE_TRANSIT_CONFIG, 'utf8'));
    assert.strictEqual(saved.site.lat, 51.4778);
    assert.strictEqual(saved.watch.enabled, false, 'the page cannot switch always-on on');
    assert.ok(Math.abs(saved.site.geoidM - 45.2) < 0.5, 'geoid filled in by the server');

    const st = JSON.parse((await request(port, 'GET', '/api/state')).data);
    assert.strictEqual(st.configured, true);
    assert.strictEqual(st.v, 1);
    assert.ok(Array.isArray(st.passes) && Array.isArray(st.aircraft));
    assert.ok(!JSON.stringify(st).includes('51.47'), 'no observer position in the state');
  });
});

test('/metrics is Prometheus text with the service health, not pass statistics', async () => {
  await withServer(async port => {
    const r = await request(port, 'GET', '/metrics');
    assert.strictEqual(r.status, 200);
    assert.match(r.type, /^text\/plain; version=0\.0\.4/);
    for (const name of ['upstream_requests_total', 'upstream_backoff_seconds', 'watch_mode{mode="off"} 1',
      'watch_interval_seconds', 'browser_active', 'upstream_daily_limit 20000'])
      assert.ok(r.data.includes(`plane_transit_${name}`), name);
    assert.ok(!/pass/i.test(r.data), 'no pass counts here');
    for (const line of r.data.trim().split('\n'))
      assert.match(line, /^(# (HELP|TYPE) \S+ .+|plane_transit_[a-z_]+(\{[a-z]+="[^"]*"\})? (-?[\d.]+(e[+-]?\d+)?|NaN))$/, line);
  });
});

test('a refusal stops upstream for a while, longer each time; success resets it', () => {
  const s = serve.stats, t = 2e15;
  Object.assign(s, { backoffUntil: 0, backoffCount: 0 });
  serve.upstreamResult({ status: 429 }, t);
  assert.strictEqual(s.backoffUntil, t + 30000);
  assert.match(serve.upstreamRefusal(t + 1000), /backing off/);
  serve.upstreamResult({ status: 403 }, t);
  assert.strictEqual(s.backoffUntil, t + 60000, 'doubles');
  serve.upstreamResult({ status: 503 }, t + 100);
  assert.strictEqual(s.backoffUntil, t + 60000, 'a server error is not a refusal');
  serve.upstreamResult(null);
  assert.strictEqual(s.backoffCount, 0);
  for (let i = 0; i < 12; i++) serve.upstreamResult({ status: 429 }, t);
  assert.strictEqual(s.backoffUntil, t + 15 * 60000, 'capped at 15 min');
  Object.assign(s, { backoffUntil: 0, backoffCount: 0 });
});

test('the daily ceiling holds whatever the per-window budget says', () => {
  const s = serve.stats, t = 3e15;
  s.upstreamDay = new Date(t).toDateString();
  s.upstreamToday = serve.UPSTREAM_DAILY_MAX;
  assert.match(serve.upstreamRefusal(t), /daily/);
  s.upstreamToday = 0;
  assert.strictEqual(serve.upstreamRefusal(t + 20000), null);
  assert.strictEqual(s.upstreamToday, 1);
  assert.strictEqual(serve.upstreamRefusal(t + 864e5 + 60000), null, 'a new day starts from zero');
  assert.strictEqual(s.upstreamToday, 1);
});

test('upstream requests ask for gzip and say who is asking', async () => {
  let seen = null;
  const server = http.createServer((req, res) => {
    seen = req.headers;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
    res.end(zlib.gzipSync(JSON.stringify({ aircraft: [{ hex: 'abc' }] })));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const d = await serve.getJSON(`http://127.0.0.1:${server.address().port}/`, 2000);
    assert.strictEqual(d.aircraft[0].hex, 'abc');
    assert.match(seen['accept-encoding'], /gzip/);
    assert.match(seen['user-agent'], /^plane-transit \(\+https:\/\/github\.com\//);
  } finally { server.close(); }
  fs.rmSync(DIR, { recursive: true, force: true });
});
