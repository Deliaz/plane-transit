// watch.js and config.js: the always-on watcher's pacing and pass lifecycle, against a
// fake feed and a fake clock, and the settings file's validation.
// Run: node --test test/*.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const E = require('../engine.js');
const config = require('../config.js');
const { createWatcher } = require('../watch.js');

const SITE = config.normalizeSite({ lat: 51.4778, lon: -0.0014, groundM: 45, aboveM: 0 });   // Greenwich
const UP = Date.UTC(2026, 0, 1, 18);     // the moon ~36 deg up
const DOWN = Date.UTC(2026, 0, 1, 9);    // ~11 deg below the horizon
const site = E.makeSite({ lat: SITE.lat, lon: SITE.lon, elev: SITE.groundM + SITE.aboveM, geoidM: SITE.geoidM });

// A plane flying straight at gs m/s, passing `offsetDeg` above the moon's centre
// `tHit` s after t0, as an aggregator record at time `t`.
function flight(t0, tHit, { offsetDeg = 0, rangeM = 12000, gs = 230, track = 70, hex = 'abc123' } = {}) {
  const T = E.bodyTarget(site, 'moon', new Date(t0));
  const m = E.targetAt(T, tHit);
  const aim = E.pointAt(site, m.az, m.el + offsetDeg, rangeM);
  return (t, turn = 0) => {
    const dt = (t - t0) / 1000 - tHit;
    const p = E.planeAt({ lat: aim.lat, lon: aim.lon, altM: aim.h, gs, track, vr: 0 }, dt);
    return { hex, flight: 'TST1  ', t: 'A320', lat: p.lat, lon: p.lon, alt_geom: p.h / E.FT,
      gs: gs / E.KT, track: (track + turn) % 360, seen_pos: 0 };
  };
}

function rig(watch, t0, records) {
  const clock = { now: t0 };
  const calls = { fetch: 0, peek: 0 };
  const w = createWatcher({
    clock: () => clock.now,
    snapshot: async (params, since) => {
      if (since != null) { calls.peek++; return null; }
      calls.fetch++;
      return { ok: true, at: clock.now, list: records(clock.now), meta: {} };
    },
  });
  w.setConfig({ site: SITE, watch: config.normalizeWatch(watch) });
  const run = async (untilMs, stepMs = 1000) => {
    for (; clock.now <= untilMs; clock.now += stepMs) await w.step();
    clock.now -= stepMs;
  };
  return { w, clock, calls, run };
}

test('a transit is tracked from first sight to its end, polled fast near the end', async () => {
  const fly = flight(UP, 40);
  const { w, calls, run } = rig({ enabled: true }, UP, t => [fly(t)]);
  await w.step();
  let s = w.state();
  assert.strictEqual(s.passes.length, 1);
  const p = s.passes[0];
  assert.strictEqual(p.status, 'upcoming');
  assert.strictEqual(p.body, 'moon');
  assert.strictEqual(p.flight, 'TST1');
  assert.strictEqual(p.type, 'A320');
  assert.ok(p.missR < 0.2, `missR ${p.missR}`);
  assert.ok(Math.abs(p.tca - (UP + 40000)) < 1000, `tca off by ${p.tca - UP - 40000} ms`);
  assert.ok(p.tIn < p.tca && p.tca < p.tOut);
  assert.ok(p.path.length > 5 && p.path.every(q => Number.isFinite(q.x) && Number.isFinite(q.y)));
  assert.ok(Math.hypot(p.closest.x, p.closest.y) < 0.2 * p.angR, 'closest point is on the disc');

  await run(UP + 30000);
  s = w.state();
  assert.strictEqual(s.watch.mode, 'burst');
  assert.strictEqual(s.watch.intervalS, 3);
  assert.ok(calls.fetch >= 9 && calls.fetch <= 12, `${calls.fetch} fetches in 30 s at 3 s`);
  assert.strictEqual(s.passes[0].id, p.id, 'one pass, one id');

  await run(UP + 50000);
  s = w.state();
  assert.strictEqual(s.passes.length, 1);
  assert.strictEqual(s.passes[0].status, 'passed');
  assert.ok(s.passes[0].missR < 0.2);
  assert.strictEqual(s.watch.mode, 'idle', 'back to the slow pace once it is over');
  assert.ok(s.bodies.moon.watching);
});

test('a slow pace with nothing close, and finished passes age out', async () => {
  const fly = flight(UP, 40, { offsetDeg: 2.0 });   // ~4 R: tracked, but no burst
  const { w, calls, run } = rig({ enabled: true }, UP, t => [fly(t)]);
  await run(UP + 60000);
  const s = w.state();
  assert.strictEqual(s.watch.mode, 'idle');
  assert.ok(calls.fetch >= 4 && calls.fetch <= 5, `${calls.fetch} fetches in 60 s at 15 s`);
  assert.strictEqual(s.passes[0].status, 'passed');
  assert.ok(s.passes[0].missR > 3 && s.passes[0].missR < 5, `missR ${s.passes[0].missR}`);
  await run(UP + 60000 + 11 * 60000, 15000);
  assert.strictEqual(w.state().passes.length, 0);
});

test('a plane that turns away is called off', async () => {
  const fly = flight(UP, 60);
  let turn = 0;
  const { w, run } = rig({ enabled: true }, UP, t => [fly(t, turn)]);
  await run(UP + 10000);
  assert.strictEqual(w.state().passes[0].status, 'upcoming');
  turn = 40;
  await run(UP + 20000);
  const p = w.state().passes[0];
  assert.strictEqual(p.status, 'called_off');
  assert.ok(p.ended > 0);
});

test('a plane gone from the feed before its pass is lost', async () => {
  const fly = flight(UP, 80);
  let there = true;
  const { w, run } = rig({ enabled: true }, UP, t => (there ? [fly(t)] : []));
  await run(UP + 5000);
  there = false;
  await run(UP + 45000);
  assert.strictEqual(w.state().passes[0].status, 'lost');
});

test('nothing is fetched while the bodies are down, or with always-on off', async () => {
  const down = rig({ enabled: true }, DOWN, () => []);
  await down.run(DOWN + 60000);
  assert.strictEqual(down.w.state().watch.mode, 'paused');
  assert.strictEqual(down.calls.fetch, 0);

  const off = rig({ enabled: false }, UP, () => []);
  await off.run(UP + 60000);
  assert.strictEqual(off.w.state().watch.mode, 'off');
  assert.strictEqual(off.calls.fetch, 0, 'off only reads what a browser fetched');
  assert.ok(off.calls.peek > 50);
});

test('the state never carries the observer position', async () => {
  const { w } = rig({ enabled: true, bodies: ['moon', 'sun'] }, UP, () => []);
  await w.step();
  const json = JSON.stringify(w.state());
  assert.ok(!json.includes('51.47') && !json.includes('0.0014'), json.slice(0, 300));
  assert.ok(w.state().bodies.sun.safety, 'the sun comes with its filter warning');
  const none = createWatcher({ snapshot: async () => null });
  none.setConfig({ site: null, watch: config.normalizeWatch({}) });
  await none.step();
  assert.strictEqual(none.state().configured, false);
});

test('settings: validated on the way in, the sun only when named', () => {
  assert.strictEqual(config.normalizeSite({ lat: 95, lon: 0 }), null);
  assert.strictEqual(config.normalizeSite({ lon: 4 }), null);
  const s = config.normalizeSite({ lat: 51.4778123456, lon: -0.0014, radiusNm: 9999, source: 'evil', aboveM: -3 });
  assert.deepStrictEqual([s.lat, s.radiusNm, s.source, s.aboveM, s.geoidAuto], [51.477812, 249, 'adsbfi', 0, true]);
  assert.ok(Math.abs(s.geoidM - 45.2) < 0.5, `geoid ${s.geoidM}`);

  const w = config.normalizeWatch({ enabled: 'yes', bodies: ['sun', 'mars'], idleS: 1, burstS: 0.5 });
  assert.deepStrictEqual(w, { enabled: false, bodies: ['sun'], minEl: 10, idleS: 10, burstS: 3 });
  assert.deepStrictEqual(config.normalizeWatch({}).bodies, ['moon']);
  assert.deepStrictEqual(config.applyWatchEnv(config.normalizeWatch({}), 'moon,sun'),
    { ...config.normalizeWatch({}), enabled: true, bodies: ['moon', 'sun'] });
  assert.strictEqual(config.applyWatchEnv({ enabled: true, bodies: ['moon'] }, 'off').enabled, false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-cfg-'));
  const file = path.join(dir, 'sub', 'config.json');
  assert.strictEqual(config.loadConfig(file).site, null, 'no file: no location, nothing watched');
  config.saveConfig(file, { site: s, watch: w });
  assert.deepStrictEqual(config.loadConfig(file), { site: s, watch: w });
  fs.writeFileSync(file, '{ not json');
  assert.strictEqual(config.loadConfig(file).site, null, 'a broken file falls back to defaults');
  fs.rmSync(dir, { recursive: true });
});
