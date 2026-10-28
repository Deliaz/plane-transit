// The server-side watcher: the same prediction the page makes (engine.js), run on the
// server for the configured site and every watched body, so other programs can read
// it from /api/state without a browser open.
//
// Two ways it gets data:
//  - always-on (watch.enabled in the settings file): it polls the feed itself, at a
//    pace that follows what there is to see —
//      nothing up (every watched body below watch.minEl)  →  no polling at all
//      something up, no plane heading for it              →  every watch.idleS (15 s)
//      a plane predicted within BURST_R of a disc          →  every watch.burstS (3 s)
//    15 s is enough to see every pass coming: the prediction looks 90 s ahead, so a
//    plane is seen ~6 times before it crosses. The burst is what makes the timing of
//    that crossing sharp.
//  - otherwise it only reads snapshots a browser already fetched for the same site,
//    so it never adds an upstream request of its own.
// Either way every request goes through serve.js's shared cache and upstream budget.
//
// A pass is one plane against one body, from the first prediction that brings it
// within PASS_R disc radii until it is over. Finished passes keep their final numbers
// in the state for RECENT_MS, so a reader polling every few seconds cannot miss how
// one ended.
'use strict';
const E = require('./engine.js');

const PASS_R = 5;           // a pass is tracked from a predicted miss of 5 disc radii...
const CALL_OFF_R = 6;       // ...and called off if the prediction drifts past 6 (hysteresis)
const BURST_R = 2;          // poll fast while a plane is predicted this close
const RECENT_MS = 600000;   // finished passes stay in the state this long
const FRESH_MS = 30000;     // an older snapshot does not count as watching
const PATH_BEFORE_S = 40, PATH_AFTER_S = 20;   // predicted path kept around closest approach
const SUN_NOTE = 'Never aim a camera at the sun without a certified front-mounted solar filter.';

const round = (v, d) => (v == null ? null : +v.toFixed(d));

function createWatcher({ snapshot, isBrowserActive = () => false, log = () => {}, clock = () => Date.now() }) {
  let site = null, siteCfg = null, watch = null;
  const planes = new Map();
  const active = new Map();   // `${body}|${hex}` -> pass
  let recent = [];            // finished passes, newest last
  const st = {
    mode: 'off', reason: null, intervalS: 0, lastAttempt: 0, lastIngest: 0,
    lastOk: 0, error: null, fetches: 0, busy: false, targets: {}, preds: {},
  };

  function setConfig(cfg) {
    const before = siteCfg && JSON.stringify(siteCfg);
    siteCfg = cfg.site; watch = cfg.watch;
    if (JSON.stringify(siteCfg) === before) return;
    // a different place or feed: nothing tracked so far belongs to it
    planes.clear(); active.clear(); recent = [];
    st.lastIngest = 0; st.lastAttempt = 0;
    site = siteCfg ? E.makeSite({ lat: siteCfg.lat, lon: siteCfg.lon,
      elev: siteCfg.groundM + siteCfg.aboveM, geoidM: siteCfg.geoidM }) : null;
  }

  // what /api/planes would be asked by a browser with the same settings, so the two
  // share one cache entry and one upstream request
  const feedParams = () => ({
    src: siteCfg.source === 'mock' ? 'adsbfi' : siteCfg.source,
    lat: siteCfg.lat, lon: siteCfg.lon, r: siteCfg.radiusNm + 1,
  });

  function ingest(snap, nowMs) {
    for (const ac of snap.list) {
      const f = E.aircraftFix(ac, siteCfg.geoidM, siteCfg.includeLow);
      if (f) E.upsertPlane(planes, f, nowMs);
    }
    // a failed public feed with the local receiver standing in is data, but say so
    st.lastIngest = snap.at; st.lastOk = nowMs; st.error = (snap.meta && snap.meta.publicError) || null;
  }

  // Which bodies are worth polling for, and how fast. A plane already heading for a
  // disc keeps the fast pace until its pass is over.
  function decide(nowMs) {
    const up = watch.bodies.filter(b => st.targets[b] && st.targets[b].el >= watch.minEl);
    if (!watch.enabled) {
      return isBrowserActive() ? ['browser', 'always-on is off; reading what the page fetches', 0]
        : ['off', 'always-on is off', 0];
    }
    if (!up.length) {
      const names = watch.bodies.map(b => E.BODIES[b].label.toLowerCase()).join(' and ');
      return ['paused', `${names} below ${watch.minEl}°`, 0];
    }
    // "close" counts the fix's own uncertainty (err0R), not the part that grows with
    // lead time: with that, every plane within ~15 km would qualify a minute out
    const close = [...active.values()].some(p => p.status === 'upcoming' && up.includes(p.body) &&
      (p.missR <= BURST_R || p.missR <= 1 + p.err0R) && p.tca > nowMs);
    return close ? ['burst', 'a plane is heading for the disc', watch.burstS]
      : ['idle', `watching ${up.map(b => E.BODIES[b].label.toLowerCase()).join(' and ')}`, watch.idleS];
  }

  async function step() {
    const nowMs = clock();
    if (!site) { Object.assign(st, { mode: 'unconfigured', reason: 'no location set', intervalS: 0 }); return; }
    const date = new Date(nowMs);
    for (const b of watch.bodies) st.targets[b] = E.bodyTarget(site, b, date);

    const [mode, reason, intervalS] = decide(nowMs);
    if (mode !== st.mode && watch.enabled) log(`always-on: ${mode}${intervalS ? `, every ${intervalS} s` : ''} — ${reason}`);
    Object.assign(st, { mode, reason, intervalS });

    // A snapshot a browser already paid for comes free; this never fetches.
    const peeked = await snapshot(feedParams(), st.lastIngest).catch(() => null);
    if (peeked && peeked.ok) ingest(peeked, clock());
    // Our own request only when what we have is older than the pace asks for. A
    // browser on the same site polls every 3 s, so while one is open the watcher
    // rides along on its snapshots — the slack keeps it from jumping into the gap
    // between two of them.
    const slack = isBrowserActive() ? 2000 : -200;
    if (intervalS && nowMs - Math.max(st.lastIngest, st.lastAttempt) >= intervalS * 1000 + slack) {
      st.lastAttempt = nowMs; st.fetches++;
      const snap = await snapshot(feedParams(), null).catch(e => ({ error: e }));
      if (snap.error || !snap.ok) st.error = snap.error ? snap.error.message : (snap.meta.publicError || 'no data');
      else ingest(snap, clock());
    }

    const t = clock();
    E.dropStalePlanes(planes, t);
    for (const b of watch.bodies) {
      const T = st.targets[b];
      const preds = new Map();
      if (T.el > 0) for (const p of planes.values()) preds.set(p.hex, E.predictPlane(site, T, p, t));
      st.preds[b] = preds;
      updatePasses(b, T, preds, t);
    }
    recent = recent.filter(p => t - p.ended < RECENT_MS);
  }

  // offsets from the body's centre in sky degrees, the sky view's frame: x to the
  // right (along azimuth, scaled by cos el), y up
  function skyOffset(T, tSec, az, el) {
    const m = E.targetAt(T, tSec);
    return { x: round(E.wrapDeg(az - m.az) * Math.cos(m.el * E.D2R), 4), y: round(el - m.el, 4) };
  }

  function passFields(T, p, res) {
    const pr = res.pred, at = pr.at, r = T.angR;
    const path = pr.samples
      .filter(s => s.t >= pr.tBest - PATH_BEFORE_S && s.t <= pr.tBest + PATH_AFTER_S)
      .map(s => ({ t: Math.round(at + s.t * 1000), ...skyOffset(T, s.t, s.az, s.el), rangeM: Math.round(s.range) }));
    return {
      flight: p.flight, type: p.type || null, klass: res.klass,
      tca: Math.round(at + pr.tBest * 1000),
      tIn: pr.tIn == null ? null : Math.round(at + pr.tIn * 1000),
      tOut: pr.tOut == null ? null : Math.round(at + pr.tOut * 1000),
      missR: round(pr.sepMin / r, 3), missDeg: round(pr.sepMin, 4),
      errR: round(pr.delta / r, 3), err0R: round(pr.delta0 / r, 3),
      dir: round(pr.dir, 1), trust: res.trust, maneuvering: !!p.maneuvering,
      fixAgeS: round(res.age, 1), feed: p.feed,
      az: round(pr.azMin, 3), el: round(pr.elMin, 3), rangeM: Math.round(pr.rangeMin),
      altM: Math.round(p.altM), gs: round(p.gs, 1), track: round(p.track, 1), vr: round(p.vr, 2),
      angR: round(r, 5),
      now: skyOffset(T, 0, res.az, res.el),
      closest: skyOffset(T, pr.tBest, pr.azMin, pr.elMin),
      path,
    };
  }

  function finish(key, pass, status, t) {
    active.delete(key);
    Object.assign(pass, { status, ended: t, updated: t });
    recent.push(pass);
  }

  function updatePasses(body, T, preds, t) {
    for (const [key, pass] of active) {
      if (pass.body !== body) continue;
      const res = preds.get(pass.hex);
      // gone from the feed, or the body has set under it
      if (!res) { finish(key, pass, t >= pass.tca ? 'passed' : 'lost', t); continue; }
      const pr = res.pred;
      if (!E.realMin(pr.tBest)) {
        // Closest approach is now or behind. A plane that turned away gets here too,
        // its closest approach jumping to "now" — so it is where the last prediction
        // put the pass in time that decides, not this one. Its final numbers are the
        // last ones made while the pass was still ahead: the shortest lead, the best.
        finish(key, pass, t >= pass.tca - 3000 ? 'passed' : 'called_off', t);
      } else if (pr.sepMin > CALL_OFF_R * T.angR || pr.elMin <= 0) {
        finish(key, pass, 'called_off', t);
      } else {
        Object.assign(pass, passFields(T, planes.get(pass.hex), res), { updated: t });
      }
    }
    for (const [hex, res] of preds) {
      const key = `${body}|${hex}`, pr = res.pred;
      if (active.has(key) || !E.realMin(pr.tBest) || pr.elMin <= 0 || pr.sepMin > PASS_R * T.angR) continue;
      const pass = { id: `${body}-${hex}-${Math.round(t / 1000)}`, body, hex, status: 'upcoming',
        first: t, updated: t, ended: null, ...passFields(T, planes.get(hex), res) };
      active.set(key, pass);
    }
  }

  function state() {
    const t = clock();
    if (!site) return { v: 1, now: t, configured: false, watch: watchState(t) };
    const fresh = st.lastIngest && t - st.lastOk < FRESH_MS;
    const bodies = {};
    for (const b of watch.bodies) {
      const T = st.targets[b];
      if (!T) continue;
      bodies[b] = {
        label: E.BODIES[b].label, az: round(T.az, 3), el: round(T.el, 3), angR: round(T.angR, 5),
        azRate: round(T.azRate, 6), elRate: round(T.elRate, 6),
        illum: round(T.illum, 4), limb: round(T.limb, 1),
        watching: !!(fresh && T.el >= watch.minEl),
      };
      if (b === 'sun') bodies[b].safety = SUN_NOTE;
    }
    const aircraft = [...planes.values()].map(p => {
      const age = (t - p.posTime) / 1000, pos = E.planeAt(p, age);
      const ae = E.azElRange(site, pos.lat, pos.lon, pos.h);
      return { hex: p.hex, flight: p.flight, type: p.type || null, altM: Math.round(p.altM),
        gs: round(p.gs, 1), track: round(p.track, 1), vr: round(p.vr, 2), ageS: round(age, 1),
        feed: p.feed, maneuvering: !!p.maneuvering,
        az: round(ae.az, 3), el: round(ae.el, 3), rangeM: Math.round(ae.range) };
    }).sort((a, b) => a.rangeM - b.rangeM);
    const passes = [...active.values(), ...recent].map(p => ({ ...p }))
      .sort((a, b) => a.tca - b.tca);
    return { v: 1, now: t, configured: true, watch: watchState(t), bodies, passes, aircraft };
  }

  function watchState(t) {
    return {
      enabled: !!(watch && watch.enabled), bodies: watch ? watch.bodies : [],
      minEl: watch ? watch.minEl : null,
      mode: st.mode, reason: st.reason, intervalS: st.intervalS,
      browser: isBrowserActive(),
      lastData: st.lastOk || null, dataAgeS: st.lastIngest ? round((t - st.lastIngest) / 1000, 1) : null,
      error: st.error, aircraft: planes.size,
    };
  }

  let timer = null;
  async function tick() {
    if (st.busy) return;
    st.busy = true;
    try { await step(); } catch (e) { log(`always-on: ${e.stack || e.message}`); } finally { st.busy = false; }
  }
  function start() { if (!timer) { timer = setInterval(tick, 1000); tick(); } }
  function stop() { clearInterval(timer); timer = null; }

  return { setConfig, step, tick, start, stop, state, stats: () => st, planes };
}

module.exports = { createWatcher, PASS_R, CALL_OFF_R, BURST_R, RECENT_MS };
