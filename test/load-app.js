// Loads the browser scripts (astronomy engine, geoid.js, app.js) into a sandbox so
// the tests can call the maths in app.js directly, with no build step and no DOM.
//
// app.js wires up its UI at load time. Here every DOM lookup returns an inert stub
// that accepts any property read, write or call and does nothing, so that wiring
// runs harmlessly and the page never starts (no position = setup panel, no timers).
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const ROOT = path.join(__dirname, '..');

function inert() {
  const stub = new Proxy(function () {}, {
    get(t, k) {
      if (k === Symbol.iterator) return function* () {};
      if (k === Symbol.toPrimitive) return () => 0;
      if (k === 'then') return undefined;   // not a promise
      return stub;
    },
    set: () => true,
    has: () => false,
    apply: () => stub,
    construct: () => stub,
  });
  return stub;
}

function loadApp() {
  const store = new Map();
  const storage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  const dom = inert();
  const ctx = {
    console, document: dom, navigator: dom, Image: dom,
    localStorage: storage, sessionStorage: storage,
    location: { protocol: 'https:', hostname: 'localhost' },
    innerWidth: 1280, isSecureContext: true, devicePixelRatio: 1,
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    fetch: () => new Promise(() => {}), AbortSignal,
    addEventListener() {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['astronomy.browser.min.js', 'geoid.js', 'app.js'])
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  // top-level const/let in those scripts are visible to later scripts in the context
  return code => vm.runInContext(code, ctx);
}

// Put the observer somewhere, the way applyCfg() would, minus the UI.
function placeObserver(run, lat, lon, elev = 0) {
  run(`cfg.lat = ${lat}; cfg.lon = ${lon}; cfg.elev = ${elev};
    cfg.geoidM = geoidAt(cfg.lat, cfg.lon);
    observer = new Astronomy.Observer(cfg.lat, cfg.lon, cfg.elev);
    obsECEF = geodeticToECEF(cfg.lat, cfg.lon, obsHeight());`);
}

module.exports = { loadApp, placeObserver };
