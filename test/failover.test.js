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
