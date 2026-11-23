// The ground under a crossing (engine.js: bodyEcef, transitPoint): the place it names
// must be one from which the prediction itself sees the plane on the disc's centre.
// Run: node --test test/*.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('../engine.js');

const D2R = Math.PI / 180;
const HOME = E.makeSite({ lat: 52.1, lon: 5.2, elev: 3, geoidM: 43 });
const T0 = Date.UTC(2026, 5, 1, 0, 0, 0);
// the first moment on or after T0 with the body within half a degree of `el`, rising or not
function when(key, el) {
  for (let m = 0; m < 60 * 24 * 40; m += 2) {
    const d = new Date(T0 + m * 60000);
    if (Math.abs(E.bodyAzEl(HOME, key, d).el - el) < 0.5) return d;
  }
  throw new Error(`${key} never at ${el}°`);
}
// an observer standing on a transit point, at the height it was computed for
const standAt = (g, h) => E.makeSite({ lat: g.lat, lon: g.lon, elev: h, geoidM: 0 });
// a repeatable spread of planes round HOME: [bearing, km out, m up]
const PLANES = [[10, 5, 600], [75, 12, 1500], [140, 30, 3000], [200, 45, 9000], [265, 60, 11500],
  [320, 20, 12000], [35, 80, 10500], [180, 2, 400]];
const planeAt = ([brg, km, h]) => ({
  lat: HOME.lat + km * 1000 * Math.cos(brg * D2R) / 111320,
  lon: HOME.lon + km * 1000 * Math.sin(brg * D2R) / (111320 * Math.cos(HOME.lat * D2R)), h });

test('ecefToGeodetic undoes geodeticToECEF', () => {
  for (const [lat, lon, h] of [[52.1, 5.2, 46], [-33.9, 151.2, 11000], [0, -78.5, 2850], [69.6, 18.9, 0], [35.7, 139.7, 12500]]) {
    const g = E.ecefToGeodetic(...E.geodeticToECEF(lat, lon, h));
    assert.ok(Math.abs(g.lat - lat) < 1e-9 && Math.abs(g.lon - lon) < 1e-9 && Math.abs(g.h - h) < 1e-3,
      `${lat}, ${lon}, ${h} came back as ${g.lat}, ${g.lon}, ${g.h}`);
  }
});

test('from the transit point the plane is seen on the centre of the disc', () => {
  let checked = 0;
  for (const key of ['moon', 'sun']) for (const el of [4, 10, 25, 50]) {
    const date = when(key, el), B = E.bodyEcef(HOME, key, date);
    for (const spec of PLANES) {
      const pos = planeAt(spec), g = E.transitPoint(B, pos, HOME.h);
      if (!g) continue;                       // out of reach with the body this low: its own test
      const there = standAt(g, HOME.h);
      const body = E.bodyAzEl(there, key, date), plane = E.azElRange(there, pos.lat, pos.lon, pos.h);
      const off = Math.hypot(body.el - plane.el, E.wrapDeg(body.az - plane.az) * Math.cos(body.el * D2R));
      // 0.0005° is 0.002 of a disc radius: 17 cm at 20 km
      assert.ok(off < 5e-4, `${key} at ${el}°, plane ${spec}: ${off.toFixed(6)}° off centre`);
      // … and it reports what that observer sees
      assert.ok(Math.abs(g.el - body.el) < 5e-4 && Math.abs(E.wrapDeg(g.az - body.az)) < 5e-3 && Math.abs(g.range - plane.range) < 1);
      checked++;
    }
  }
  assert.ok(checked > 50, `only ${checked} cases had a transit point`);
});

test('it lies h / tan(elevation) beyond the plane, away from the body', () => {
  for (const key of ['moon', 'sun']) for (const el of [10, 25, 50]) {
    const date = when(key, el), B = E.bodyEcef(HOME, key, date), body = E.bodyAzEl(HOME, key, date);
    for (const spec of PLANES) {
      const pos = planeAt(spec), g = E.transitPoint(B, pos, HOME.h);
      const dN = (g.lat - pos.lat) * 111320, dE = (g.lon - pos.lon) * 111320 * Math.cos(pos.lat * D2R);
      const got = Math.hypot(dN, dE);
      // seen from there the plane stands lower by the curve of the ground in between
      const want = (pos.h - HOME.h - got * got / (2 * 6371e3)) / Math.tan(g.el * D2R);
      assert.ok(Math.abs(got / want - 1) < 0.02, `${key} ${el}° ${spec}: ${got.toFixed(0)} m, expected about ${want.toFixed(0)}`);
      const bearing = Math.atan2(dE, dN) / D2R;
      assert.ok(Math.abs(E.wrapDeg(bearing - (body.az + 180))) < 1.5, `bearing ${bearing.toFixed(1)}, body at ${body.az.toFixed(1)}`);
    }
  }
});

test('an observer put on the line gets a transit from predictPlane, at that moment', () => {
  for (const key of ['moon', 'sun']) for (const el of [8, 30]) {
    const date = when(key, el), nowMs = date.getTime();
    const B0 = E.bodyEcef(HOME, key, date), B1 = E.bodyEcef(HOME, key, new Date(nowMs + 120000));
    const planes = new Map();
    E.upsertPlane(planes, { hex: 'a', flight: 'A', lat: 52.3, lon: 5.0, altM: 10400, gs: 235, track: 118, vr: -2,
      ageS: 1.4, altSrc: 'geom', feed: 't' }, nowMs);
    const p = planes.get('a'), age = (nowMs - p.posTime) / 1000;
    for (const t of [12, 40, 75]) {
      const B = B0.map((v, i) => v + (B1[i] - v) * t / 120);
      const g = E.transitPoint(B, E.planeAt(p, age + t), HOME.h);
      const there = standAt(g, HOME.h);
      const pr = E.predictPlane(there, E.bodyTarget(there, key, date), p, nowMs);
      assert.strictEqual(pr.klass, 'transit');
      assert.ok(pr.pred.sepMin < 0.02 * 0.26, `${key} ${el}° +${t}s: missed by ${pr.pred.sepMin.toFixed(5)}°`);
      assert.ok(Math.abs(pr.pred.tBest - t) <= 0.1, `${key} ${el}° +${t}s: predicted for +${pr.pred.tBest.toFixed(2)}s`);
    }
  }
});

test('the disc is range × its radius wide on the ground, across the line of sight', () => {
  const date = when('moon', 25), B = E.bodyEcef(HOME, 'moon', date);
  const pos = planeAt([200, 45, 9000]), g = E.transitPoint(B, pos, HOME.h);
  const angR = E.bodyTarget(HOME, 'moon', date).angR, across = angR * D2R * g.range;
  const a = (g.az + 90) * D2R;                // a step to the right of the line of sight
  const edge = standAt({ lat: g.lat + across * Math.cos(a) / 111320,
    lon: g.lon + across * Math.sin(a) / (111320 * Math.cos(g.lat * D2R)) }, HOME.h);
  const body = E.bodyAzEl(edge, 'moon', date), plane = E.azElRange(edge, pos.lat, pos.lon, pos.h);
  const off = Math.hypot(body.el - plane.el, E.wrapDeg(body.az - plane.az) * Math.cos(body.el * D2R));
  assert.ok(Math.abs(off / angR - 1) < 0.01, `${(off / angR).toFixed(3)} R from the edge of the band`);
});

test('no transit point when there is none to stand on', () => {
  const up = when('sun', 25), B = E.bodyEcef(HOME, 'sun', up);
  assert.strictEqual(E.transitPoint(B, { lat: 52.2, lon: 5.3, h: HOME.h + 10 }, HOME.h), null, 'plane on the ground');
  const night = when('sun', -8);
  assert.strictEqual(E.transitPoint(E.bodyEcef(HOME, 'sun', night), planeAt([200, 45, 9000]), HOME.h), null, 'sun down');
  const low = when('sun', 1.5);     // the line leaves the planet before it comes down
  assert.strictEqual(E.transitPoint(E.bodyEcef(HOME, 'sun', low), planeAt([200, 45, 11000]), HOME.h), null, 'sun at 1.5°');
});
