// The two public feeds covering for each other (serve.js publicFeed), against two
// local stand-ins. Its own file: the budget and back-off are per process.
// Run: node --test test/*.test.js
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-failover-'));
process.env.PLANE_TRANSIT_CONFIG = path.join(DIR, 'config.json');
delete process.env.PLANE_TRANSIT_WATCH;
delete process.env.PLANE_TRANSIT_LOCAL_URL;

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const serve = require('../serve.js');

const PLANE = { hex: 'abc123', lat: 52, lon: 5, gs: 400, track: 90, alt_geom: 30000, seen_pos: 0.5 };
function feed(answer) {
  const f = { hits: 0, status: 200 };
  f.server = http.createServer((req, res) => {
    f.hits++;
    res.writeHead(f.status, { 'Content-Type': 'application/json' });
    res.end(f.status === 200 ? JSON.stringify(answer) : 'no');
  });
  return new Promise(r => f.server.listen(0, '127.0.0.1', () => r(f)));
}

test('a feed that is down is covered by the other one, and comes back', async () => {
  const fi = await feed({ aircraft: [PLANE] }), lol = await feed({ ac: [PLANE] });
  const real = Object.assign({}, serve.UPSTREAM);
  serve.UPSTREAM.adsbfi = () => `http://127.0.0.1:${fi.server.address().port}/`;
  serve.UPSTREAM.adsblol = () => `http://127.0.0.1:${lol.server.address().port}/`;
  let lon = 5;                                   // a new area each time: past the snapshot cache
  const ask = () => serve.snapshot({ src: 'adsbfi', lat: 52, lon: lon++, r: 30 }, null, false);
  try {
    let s = await ask();
    assert.ok(s.ok && !s.meta.failover, 'the chosen feed answers: nothing else is asked');
    assert.deepStrictEqual([fi.hits, lol.hits], [1, 0]);

    fi.status = 503;
    s = await ask();
    assert.ok(s.ok, 'still an answer');
    assert.strictEqual(s.list[0].hex, 'abc123');
    assert.deepStrictEqual(s.meta.failover, { from: 'adsbfi', to: 'adsblol', error: 'HTTP 503' });
    assert.deepStrictEqual([fi.hits, lol.hits], [2, 1]);

    s = await ask();
    assert.ok(s.ok && s.meta.failover, 'while it is down it is not asked again');
    assert.deepStrictEqual([fi.hits, lol.hits], [2, 2]);

    fi.status = 200;
    serve.feedDown.adsbfi.until = 0;             // the minute is up
    s = await ask();
    assert.ok(s.ok && !s.meta.failover, 'back on the chosen feed');
    assert.deepStrictEqual([fi.hits, lol.hits], [3, 2]);
    assert.strictEqual(serve.feedDown.adsbfi, undefined);
  } finally {
    Object.assign(serve.UPSTREAM, real);
    fi.server.close(); lol.server.close();
  }
});

test('a report is aged by how old the feed\'s snapshot was when it arrived', async () => {
  const T = 1.8e12;
  for (const k of Object.keys(serve.feedClock)) delete serve.feedClock[k];
  // clocks that agree: our clock minus their `now` is the age, the 2 s rhythm and all
  assert.strictEqual(serve.feedAgeS('a', T / 1000 - 0.5, T), 0.5);
  assert.strictEqual(serve.feedAgeS('a', T / 1000 - 0.5, T + 1000), 1.5, 'the same snapshot, a second later');
  assert.strictEqual(serve.feedAgeS('a', (T + 1500) - 400, T + 1500), 0.4, 'a feed that counts in milliseconds');
  assert.strictEqual(serve.feedAgeS('a', undefined, T), 0, 'no timestamp, no claim');
  // a clock 40 s off: only the change from the freshest answer seen can be trusted
  assert.strictEqual(serve.feedAgeS('b', T / 1000 + 40, T), 0);
  assert.strictEqual(serve.feedAgeS('b', T / 1000 + 40, T + 1200), 1.2);
  assert.strictEqual(serve.feedAgeS('b', T / 1000 + 41.5, T + 3000), 1.5);
  // … and one feed's clock says nothing about another's
  assert.strictEqual(serve.feedAgeS('c', T / 1000 - 0.2, T), 0.2);
  // a clock set by an hour is not an hour-old snapshot
  assert.strictEqual(serve.feedAgeS('a', T / 1000 - 0.5, T + 3600e3), 0);

  // end to end: the age reaches every aircraft's seen_pos
  serve.upstreamTimes.length = 0;
  const fi = await feed({ now: Date.now() / 1000 - 1.5, aircraft: [PLANE] });
  const real = serve.UPSTREAM.adsbfi;
  delete serve.feedClock.adsbfi; delete serve.feedDown.adsbfi;
  serve.UPSTREAM.adsbfi = () => `http://127.0.0.1:${fi.server.address().port}/`;
  try {
    const s = await serve.snapshot({ src: 'adsbfi', lat: 30, lon: 30, r: 30 }, null, false);
    assert.ok(Math.abs(s.meta.feedAgeS - 1.5) < 0.2, `feedAgeS ${s.meta.feedAgeS}`);
    assert.ok(Math.abs(s.list[0].seen_pos - (PLANE.seen_pos + 1.5)) < 0.2, `seen_pos ${s.list[0].seen_pos}`);
  } finally { serve.UPSTREAM.adsbfi = real; fi.server.close(); }
});

test('a refusal is not a reason to ask the other feed', async () => {
  const fi = await feed({ aircraft: [PLANE] }), lol = await feed({ ac: [PLANE] });
  const real = Object.assign({}, serve.UPSTREAM);
  serve.UPSTREAM.adsbfi = () => `http://127.0.0.1:${fi.server.address().port}/`;
  serve.UPSTREAM.adsblol = () => `http://127.0.0.1:${lol.server.address().port}/`;
  fi.status = 429;
  serve.upstreamTimes.length = 0;                // the first test spent this window's budget
  try {
    const s = await serve.snapshot({ src: 'adsbfi', lat: 40, lon: 40, r: 30 }, null, false);
    assert.ok(!s.ok);
    assert.strictEqual(s.meta.publicStatus, 429);
    assert.deepStrictEqual([fi.hits, lol.hits], [1, 0]);
    assert.ok(serve.stats.backoffUntil > Date.now(), 'and the back-off is running');
  } finally {
    Object.assign(serve.UPSTREAM, real);
    Object.assign(serve.stats, { backoffUntil: 0, backoffCount: 0 });
    fi.server.close(); lol.server.close();
    fs.rmSync(DIR, { recursive: true, force: true });
  }
});
