// Turn-following in engine.js: when a turn is believed, what is flown, and that a
// plane flying straight is predicted exactly as before. Run: node --test test/*.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('../engine.js');

const D2R = Math.PI / 180, LAT = 52, LON = 5, COS = Math.cos(LAT * D2R);
// a flight whose heading at second s is hdg(s): reported every 3 s, each report 1 s old
function fly(hdg, v, untilS, noise = () => 0) {
  const planes = new Map();
  let N = 0, Ee = 0, s = 0;
  const at = t => { for (; s < t; s += 0.05) { N += v * Math.cos(hdg(s) * D2R) * 0.05; Ee += v * Math.sin(hdg(s) * D2R) * 0.05; } return { N, E: Ee }; };
  const turns = [];
  for (let T = 3; T <= untilS; T += 3) {
    const pos = at(T - 1);
    E.upsertPlane(planes, { hex: 'x', flight: 'X', lat: LAT + pos.N / 111320, lon: LON + pos.E / (111320 * COS),
      altM: 10000, gs: v, track: ((hdg(T - 1) + noise()) % 360 + 360) % 360, vr: 0, ageS: 1, altSrc: 'geom', feed: 't' }, T * 1000);
    turns.push(planes.get('x').turn);
  }
  return { p: planes.get('x'), turns, at };
}
const metres = (pos, want) => Math.hypot((pos.lat - LAT) * 111320 - want.N, (pos.lon - LON) * 111320 * COS - want.E);

test('a plane flying straight is predicted exactly as a straight line', () => {
  let i = 0;
  const wobble = () => [0.3, -0.2, 0.4, 0.1, -0.4, 0.5, 0.2, -0.1][i++ % 8];   // track noise, both ways
  const { p, turns } = fly(() => 40, 230, 120, wobble);
  assert.ok(turns.every(t => t === 0), 'noise is never taken for a turn');
  for (const dt of [0, 1.5, 30, 90]) {
    const got = E.planeAt(p, dt);
    // the formula as it was before turns were followed, to the last bit
    const vN = p.gs * Math.cos(p.track * D2R), vE = p.gs * Math.sin(p.track * D2R);
    assert.strictEqual(got.lat, p.lat + vN * dt / 111320);
    assert.strictEqual(got.lon, p.lon + vE * dt / (111320 * Math.cos(p.lat * D2R)));
    assert.strictEqual(got.h, p.altM + p.vr * dt);
  }
});

test('a steady turn is followed, and beats the straight line', () => {
  const { p, at } = fly(s => 40 + 0.8 * s, 220, 30);
  assert.ok(Math.abs(p.turn - 0.8) < 0.05, `turn rate ${p.turn}`);
  const truth = at(29 + 10);                       // 10 s past the last report (made at 29 s)
  const arc = metres(E.planeAt(p, 10), truth);
  const line = metres(E.planeAt(Object.assign({}, p, { turn: 0 }), 10), truth);
  assert.ok(arc < 15, `on the arc: ${arc.toFixed(0)} m off`);
  assert.ok(line > 100, `the straight line: ${line.toFixed(0)} m off`);
  // past the hold it flies straight on from the heading reached: the two ends meet
  const H = E.TURN.holdS, a = E.planeAt(p, H - 1e-6), b = E.planeAt(p, H + 1e-6);
  assert.ok(Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7, 'no jump where the arc ends');
});

test('a turn is dropped the moment the reports stop agreeing on it', () => {
  // 1 deg/s until 20 s, straight after: the flag goes with the first report that did not turn
  const { turns } = fly(s => 40 + Math.min(20, s), 220, 36);
  assert.ok(turns.slice(2, 6).some(t => t > 0.5), 'seen while it lasts');
  assert.deepStrictEqual(turns.slice(-3), [0, 0, 0]);
  // too gentle, too short, or switched off: flown straight
  assert.ok(fly(s => 40 + 0.15 * s, 220, 60).turns.every(t => t === 0), '0.15 deg/s is under the threshold');
  assert.strictEqual(E.turnRate([{ t: 0, track: 10 }, { t: 3000, track: 14 }]), 0, 'two reports are not enough');
  assert.strictEqual(E.turnRate([{ t: 0, track: 10 }, { t: 3000, track: 13 }, { t: 6000, track: 11 }]), 0, 'a swing back');
  const hold = E.TURN.holdS;
  E.TURN.holdS = 0;
  try { assert.ok(fly(s => 40 + 0.8 * s, 220, 30).turns.every(t => t === 0)); } finally { E.TURN.holdS = hold; }
});
