// serve.js: what it serves, what it refuses, and how it merges feeds. Nothing here
// talks to a real aggregator. Run: node --test test/*.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const serve = require('../serve.js');

const ac = (hex, seen_pos, extra) => Object.assign(
  { hex, lat: 51.5, lon: 0, gs: 400, track: 90, alt_geom: 30000, seen_pos }, extra);

test('usable() keeps only records the browser can fly', () => {
  assert.ok(serve.usable(ac('a', 1)));
  assert.ok(serve.usable(ac('a', 1, { alt_geom: undefined, alt_baro: 30000 })));
  assert.ok(!serve.usable(ac('a', 1, { gs: undefined })));
  assert.ok(!serve.usable(ac('a', 1, { track: undefined })));
  assert.ok(!serve.usable(ac('a', 1, { alt_geom: undefined, alt_baro: 'ground' })));
  assert.ok(!serve.usable(ac('a', 1, { alt_geom: undefined })));
});

test('mergeFeeds: public is the base, local wins only when clearly fresher', () => {
  const local = (hex, s) => ac(hex, s, { _src: 'local' });
  const m1 = serve.mergeFeeds([ac('ABC', 2.0)], [local('abc', 1.2)]);
  assert.strictEqual(m1.list.length, 1);
  assert.strictEqual(m1.list[0]._src, 'local');
  assert.strictEqual(m1.fresher, 1);

  const m2 = serve.mergeFeeds([ac('abc', 2.0)], [local('abc', 1.7)]);   // within 0.5 s
  assert.strictEqual(m2.list[0]._src, 'public');

  const m3 = serve.mergeFeeds([ac('abc', 2.0)], [local('def', 5)]);
  assert.strictEqual(m3.list.length, 2);
  assert.strictEqual(m3.added, 1);

  const m4 = serve.mergeFeeds([ac('abc', 1, { gs: undefined })], []);
  assert.strictEqual(m4.list.length, 0, 'unusable public records are dropped');
});

test('upstream budget allows a burst, then refuses until the window moves on', () => {
  const t0 = 1e15;   // far from Date.now(), so real requests elsewhere do not interfere
  for (let i = 0; i < serve.UPSTREAM_MAX; i++) assert.ok(serve.upstreamAllowed(t0 + i), `request ${i}`);
  assert.ok(!serve.upstreamAllowed(t0 + 100));
  assert.ok(serve.upstreamAllowed(t0 + serve.UPSTREAM_WINDOW_MS));
});

// raw requests: no URL normalisation on the way, so ../ and bad escapes reach the server
function request(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('HTTP: serves the app and nothing else, and survives bad requests', async t => {
  const server = http.createServer(serve.handle);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const { port } = server.address();
  const get = path => request(port, 'GET', path);

  const page = await get('/');
  assert.strictEqual(page.status, 200);
  assert.match(page.type, /text\/html/);
  for (const f of ['/index.html', '/app.js', '/geoid.js', '/astronomy.browser.min.js'])
    assert.strictEqual((await get(f)).status, 200, f);
  assert.match((await get('/app.js')).type, /javascript/);

  for (const f of ['/.git/config', '/.git/HEAD', '/serve.js', '/AGENTS.md', '/deploy/make-cert.sh',
    '/../../etc/passwd', '/%2e%2e/serve.js', '/app.js/', '/snap.png'])
    assert.strictEqual((await get(f)).status, 404, f);

  assert.strictEqual((await get('/%')).status, 404, 'a malformed escape');
  assert.strictEqual((await get('/')).status, 200, 'still up after it');

  const status = await get('/api/status');
  assert.strictEqual(status.status, 200);
  assert.strictEqual(JSON.parse(status.data).ok, true);

  for (const q of ['', '?lat=abc&lon=1', '?lat=91&lon=0', '?lat=10&lon=181'])
    assert.strictEqual((await get('/api/planes' + q)).status, 400, q);
});

test('HTTP: /api/snap takes only a PNG, only from this machine, only so big', async t => {
  const server = http.createServer(serve.handle);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const { port } = server.address();

  const plain = await request(port, 'POST', '/api/snap', { headers: { 'Content-Type': 'text/plain' }, body: 'x' });
  assert.strictEqual(plain.status, 415, 'a cross-site form can only send simple types');
  const big = await request(port, 'POST', '/api/snap',
    { headers: { 'Content-Type': 'image/png' }, body: Buffer.alloc(serve.SNAP_MAX + 1) });
  assert.strictEqual(big.status, 413);

  // from another machine: refused before the body is even looked at
  let status = null;
  serve.handle(
    { url: '/api/snap', method: 'POST', headers: { 'content-type': 'image/png' },
      socket: { remoteAddress: '192.168.1.20' }, on() {} },
    { writeHead: s => { status = s; }, end() {}, headersSent: false });
  assert.strictEqual(status, 403);
});
