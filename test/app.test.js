// The maths in app.js and geoid.js: position parsing, the frame corrections, the
// prediction itself, and the countdown's arming rules. Run: node --test test/*.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadApp, placeObserver } = require('./load-app');

const run = loadApp();
// arrays from the sandbox have their own prototype; compare them element-wise
const near = (actual, expected, tol, msg) => {
  assert.ok(actual, `${msg}: got ${actual}`);
  expected.forEach((e, i) => assert.ok(Math.abs(actual[i] - e) <= tol, `${msg}: [${[...actual]}] vs [${expected}]`));
};

test('parseLatLon reads coordinates the way people paste them', () => {
  const cases = {
    '51.4778, -0.0014': [51.4778, -0.0014],
    '-33.8568, 151.2153': [-33.8568, 151.2153],
    '51°28\'40"N 0°00\'05"W': [51.47778, -0.00139],
    '51.48 N, 0.01 W': [51.48, -0.01],
    '0.01 W, 51.48 N': [51.48, -0.01],                       // hemisphere letters decide the order
    'geo:51.4778,-0.0014': [51.4778, -0.0014],
    'https://www.google.com/maps/@51.4778,-0.0014,17z': [51.4778, -0.0014],
    // a place link: the pin (!3d/!4d) wins over the viewport (@)
    'https://www.google.com/maps/place/X/@51.4769,-0.0027,17z/data=!3m1!4b1!8m2!3d51.4778!4d-0.0014': [51.4778, -0.0014],
    'https://www.openstreetmap.org/?mlat=51.4778&mlon=-0.0014#map=18/51.47/-0.01': [51.4778, -0.0014],
    'https://www.openstreetmap.org/#map=17/51.4778/-0.0014': [51.4778, -0.0014],
    'https://maps.apple.com/?ll=51.4778,-0.0014&q=Observatory': [51.4778, -0.0014],
  };
  for (const [text, want] of Object.entries(cases))
    near(run(`parseLatLon(${JSON.stringify(text)})`), want, 1e-4, text);
  for (const bad of ['hello there', '91.5, 10.5', '12'])
    assert.strictEqual(run(`parseLatLon(${JSON.stringify(bad)})`), null, bad);
});

test('geoidAt matches EGM96 where it is well known', () => {
  const g = (lat, lon) => run(`geoidAt(${lat}, ${lon})`);
  assert.ok(Math.abs(g(52.3731, 4.8926) - 43) < 2, 'Amsterdam ~43 m');
  assert.ok(g(5, 78) < -95, 'Indian Ocean low, about -105 m');
  assert.ok(g(-8, 147) > 65, 'New Guinea high, about +75 m');
});

test('a plane gets the share of refraction the air below it produces', () => {
  const f = dh => run(`refrShare(${dh})`);
  assert.ok(Math.abs(f(1000) - 0.06) < 0.005);
  assert.ok(Math.abs(f(3000) - 0.17) < 0.005);
  assert.ok(Math.abs(f(10000) - 0.43) < 0.005);
  assert.ok(f(0) >= 0 && f(1e6) < 1, 'bounded');
});

// A plane on a straight line through a point on the line of sight to a fixed target,
// arriving there `tHit` s after its fix, which is `ageS` s old.
function planeThrough(offsetEl, tHit, { ageS = 0, rangeM = 8000, gs = 250, track = 45 } = {}) {
  return run(`(() => {
    const aim = pointAt(target.az, target.el + ${offsetEl}, ${rangeM});
    const vN = ${gs} * Math.cos(${track} * D2R), vE = ${gs} * Math.sin(${track} * D2R);
    const dt = ${tHit + ageS};
    const lat = aim.lat - vN * dt / 111320;
    const lon = aim.lon - vE * dt / (111320 * Math.cos(lat * D2R));
    const p = { hex: 't', flight: 'TEST', hist: [], trail: [], ghosts: [], lat, lon,
      altM: aim.h, gs: ${gs}, track: ${track}, vr: 0, posTime: Date.now() - ${ageS * 1000},
      maneuvering: false };
    predict(p, Date.now());
    return p;
  })()`);
}

test('predict finds a transit that falls between two whole seconds', () => {
  placeObserver(run, 51.4778, -0.0014, 45);
  run('target = { az: 135, el: 20, angR: 0.26, azRate: 0, elRate: 0, illum: null, limb: null }');
  // 250 m/s at 8 km sweeps ~1.8 deg/s: at t = 30 and 31 s the plane is ~3.5 R off
  // either side, so only the fine search around the minimum sees the hit
  const p = planeThrough(0, 30.5);
  assert.strictEqual(p.klass, 'transit');
  assert.ok(Math.abs(p.pred.tBest - 30.5) < 0.1, `tBest ${p.pred.tBest}`);
  assert.ok(p.pred.sepMin < 0.1, `sepMin ${p.pred.sepMin}`);
  assert.ok(p.pred.tIn < p.pred.tBest && p.pred.tBest < p.pred.tOut);
});

test('predict extrapolates from the fix time, and draws "now" where it predicts', () => {
  placeObserver(run, 51.4778, -0.0014, 45);
  run('target = { az: 135, el: 20, angR: 0.26, azRate: 0, elRate: 0, illum: null, limb: null }');
  const p = planeThrough(0, 20, { ageS: 6 });
  assert.ok(Math.abs(p.pred.tBest - 20) < 0.1, `tBest ${p.pred.tBest} (a 6 s old fix)`);
  const s0 = p.pred.samples[0];
  assert.ok(run(`angularSep(${p.az}, ${p.el}, ${s0.az}, ${s0.el})`) < 1e-9, 'dot = start of its line');
});

test('predict does not call a clear miss a transit', () => {
  placeObserver(run, 51.4778, -0.0014, 45);
  run('target = { az: 135, el: 20, angR: 0.26, azRate: 0, elRate: 0, illum: null, limb: null }');
  assert.strictEqual(planeThrough(5, 30).klass, 'far');
  // nominally 2.5 R off: a near miss at most, however wide the uncertainty
  assert.notStrictEqual(planeThrough(2.5 * 0.26, 30).klass, 'transit');
});

test('the direction arrow is in the sky view frame: 0 up, 90 right', () => {
  placeObserver(run, 51.4778, -0.0014, 45);
  run('target = { az: 180, el: 20, angR: 0.26, azRate: 0, elRate: 0, illum: null, limb: null }');
  // facing south, east is to the left and west to the right; flying away sinks
  const dir = track => planeThrough(0, 30, { track }).pred.dir;
  assert.ok(Math.abs(dir(90) + 90) < 2, `eastbound ${dir(90)}`);
  assert.ok(Math.abs(dir(270) - 90) < 2, `westbound ${dir(270)}`);
  assert.ok(Math.abs(Math.abs(dir(180)) - 180) < 2, `southbound ${dir(180)}`);
  // the camera follows the target, so its drift counts against the plane's motion
  run('target.azRate = 0.01');
  const slow = planeThrough(0, 30, { track: 180, gs: 20, rangeM: 30000 }).pred.dir;
  assert.ok(slow < -120 && slow > -178, `slow plane, drifting target ${slow}`);
});

test('the miss trend shows only real movement between fixes', () => {
  placeObserver(run, 51.4778, -0.0014, 45);
  run('target = { az: 135, el: 20, angR: 0.26, azRate: 0, elRate: 0, illum: null, limb: null }');
  const from = (ghostMissR, tHit = 30) => run(`(() => {
    const p = ${JSON.stringify(planeThrough(0.1 * 0.26, tHit))};
    p.ghosts = [{ seen: Date.now() - 6000, miss: null, pts: [] },
                { seen: Date.now() - 3000, miss: ${ghostMissR} * target.angR, pts: [] }];
    const f = missFrom(p);
    return f == null ? null : f / target.angR;
  })()`);
  assert.ok(Math.abs(from(1.5) - 1.5) < 1e-9, 'turning in: 1.5 -> 0.1 R');
  assert.strictEqual(from(0.25), null, 'jitter below TREND_R');
  assert.strictEqual(from(1.5, 0.2), null, 'closest approach already here: no trend');
});

test('countdown blips tighten towards the tone and the tone stays centred', () => {
  assert.deepStrictEqual([25, 10, 5, 0.5].map(s => run(`beepGap(${s})`)), [2, 1, 0.5, 0.15]);
  const win = pr => [...run(`toneWindow(${JSON.stringify(pr)})`)];
  near(win({ tBest: 30.1, tIn: 29.8, tOut: 30.4 }), [29.8, 30.4], 1e-9, 'normal crossing');
  near(win({ tBest: 30, tIn: 29.95, tOut: 30.05 }), [29.825, 30.175], 1e-9, 'brief: 0.35 s minimum');
  near(win({ tBest: 15, tIn: 10, tOut: 20 }), [12.5, 17.5], 1e-9, 'slow: 5 s, centred');
  near(win({ tBest: 12, tIn: null, tOut: null }), [11.825, 12.175], 1e-9, 'near miss');
});

test('arming is strict, staying armed is loose', () => {
  run(`planes.clear(); resetCountdown(); cfg.sound = true;
    target = { az: 135, el: 20, angR: 0.26, azRate: 0, elRate: 0, illum: null, limb: null };
    var P = { hex: 'a', klass: 'transit', trust: 'high',
      pred: { at: Date.now(), tBest: 20, sepMin: 0.05, delta: 0.3, elMin: 10 } };
    planes.set('a', P);`);
  const armedNow = setup => run(`${setup}; checkAlerts(); armed.has('a')`);
  assert.ok(armedNow(''), 'a confident transit arms');
  assert.ok(armedNow(`P.klass = 'near'; P.trust = 'low'; P.pred.sepMin = 1.2 * 0.26`), '1.2 R keeps it');
  assert.ok(!armedNow('P.pred.sepMin = 2.0 * 0.26'), '2 R disarms');
  assert.ok(!armedNow(`P.klass = 'near'; P.trust = 'high'; P.pred.sepMin = 1.4 * 0.26`), '1.4 R never arms');
  assert.ok(!armedNow(`P.klass = 'transit'; P.pred.sepMin = 0.05; P.pred.tBest = 45`), 'too far ahead');
  assert.ok(armedNow('P.pred.tBest = 20'), 're-arms');
  assert.ok(!armedNow('P.pred.tBest = 0'), 'passed: disarms');
  assert.ok(!armedNow('P.pred.tBest = 20; cfg.sound = false'), 'sound off: disarms');
  run('planes.clear(); resetCountdown()');
});
