# AGENTS.md — working notes for AI agents

Context and hard-won details for anyone (human or model) picking this project up.
Read this before changing `app.js`; several things that look wrong are deliberate.

## What this is

A live tool for photographing planes crossing **the moon or the sun**. It shows a sky
view centered on the selected body, dead-reckons nearby aircraft up to 90 s ahead, and
reports predicted close approaches. Built for a fixed observer with a camera in hand —
not for route planning days ahead (that is what transit-finder-style tools do).

Sun mode is a real-world safety matter: it points a camera at the sun, and the user is
expected to have a certified full-aperture solar filter. `index.html` carries a
`#sunWarn` banner that `renderTables()` shows whenever `cfg.body === 'sun'`. **Do not
remove or soften it**, and do not make sun mode the default — selecting it should stay
a deliberate act. On top of the banner, the first switch to the sun in each browser
session goes through the `#sunAck` dialog (tick "I have a filter", `sessionStorage`
`plane-transit-sunack`); keep that gate in `chooseBody()` for any new way of switching.

## Architecture

No build step, no package.json, no dependencies to install.

- `index.html` — markup + all CSS. Settings UI writes to `localStorage["plane-transit-cfg"]`.
  `cfg.body` (`'moon' | 'sun'`) defaults to `'moon'` when absent.
  There is **no default location**: `cfg.lat/lon` start `null`, and until they are set
  the setup panel is open and `tick()` / `fetchLive()` do nothing (`hasLocation()`,
  `started`). A guessed location gives confidently wrong predictions, and a personal
  one has no business in a public repo. The same `#setup` panel is Settings later (⚙).
  Every field applies on change through `applyCfg()`, which reads `cfg`, not the DOM:
  handlers write `cfg`, then call it. Every way of giving a position (GPS, pasted
  coordinates or map link via `parseLatLon()`, a tap on the picker map, the lat/lon
  fields) goes through `setLocation()`, which re-derives the geoid and looks the
  ground height up once from open-meteo.com (CORS-enabled; never while watching).
  Elevation is `groundM + aboveM` (terrain + eye above ground), kept in `cfg.elev`.
  Old saved settings without `groundM` are migrated at load (old `elev` → ground).
- `app.js` — everything else: geodesy, prediction, both canvases, tables, audio.
- `geoid.js` — EGM96 geoid heights on a 3° grid (~24 KB) and `geoidAt(lat, lon)`,
  generated from the NGA model (public domain) via egm96-universal. Within 2.7 m of
  the full model for 95% of the globe — a few metres is ~0.01 deg at 20 km, noise.
- `serve.js` — static server, ADS-B proxy, shared snapshot cache, local-receiver merge.
  Not optional (see CORS below). It serves only the files listed in `STATIC` — **a new
  file the page loads must be added there**, or it 404s. Serving the directory used to
  hand `.git/` and the deploy scripts to the whole LAN. The request handler must never
  throw (a malformed `%` escape once killed the process); `handle()` turns anything
  unexpected into a 500.
- `astronomy.browser.min.js` — vendored [astronomy-engine] v2.1.19, MIT. Vendored on
  purpose so the tool works offline-ish and has no install step.
- `deploy/` + `DEPLOY.md` — the home Raspberry Pi install. Read DEPLOY.md before
  touching anything deployment-shaped.
- HTTPS is optional and self-enabling: `serve.js` adds an https listener on
  `PLANE_TRANSIT_TLS_PORT` (8443) when `PLANE_TRANSIT_TLS_DIR` holds `server.crt` + `server.key`,
  and serves the CA's public cert at `/plane-transit-ca.crt` for devices to install.
  `deploy/make-cert.sh` issues them from a private CA that is **name-constrained** to
  the pi's names and /24 subnet (asked of the pi itself over ssh), and whose key **never
  leaves the machine that ran the script** (`~/.plane-transit-ca/`).
  Keep both properties: an unconstrained root on the user's phone, or its key on a box
  running third-party containers, would be a real security hole for a convenience. The
  TLS dir lives outside the deploy dir because `rsync --delete` would wipe it. A new
  origin means new `localStorage`: the https page opens the first-run setup again.

Run with `node serve.js`. The README promises Node >= 14 and CI checks it, so **no
global `fetch` in serve.js** (it arrived in Node 18) — it uses `https.get`.
`PLANE_TRANSIT_PORT`, `PLANE_TRANSIT_BIND` and `PLANE_TRANSIT_LOCAL_URL` configure it. `require()`-ing
serve.js starts nothing; the tests import `handle` and the merge helpers from it.

**Nothing polls on a timer.** The browser drives everything: the client asks
`/api/planes`, and only then does the server ask an aggregator. That is what makes the
pi free to leave running — see the pause rules in `pollPause()` (hidden page past a
60 s grace unless a countdown is armed; target below -2 deg) and the presence logging
in serve.js. `cached()` gives every browser the same snapshot with one in-flight
upstream request per key, so extra tabs and devices cost nothing. Keep it that way: an
interval that fetches regardless of who is looking would quietly burn the quota.
On top of that, `upstreamAllowed()` caps upstream at 10 requests per 10 s for the whole
server (adsb.fi's published limit is 1/s): harmless for real use, and it stops a
server exposed by mistake from being used to hammer the aggregator. The server also
rounds lat/lon to 0.01 deg, as the page does, so a caller can't mint a cache key per
metre.

## UI layout (what is used when)

Sorted by how often a photographer touches it, not by when it was built:

- **Header, every session:** Moon/Sun toggle, where to point (`S 178° · 14.5° up`,
  exact numbers + diameter + set time in the tooltip), % lit, feed status dot, sound
  button (on / off / "tap to enable" while the browser blocks audio), clock, ⚙.
- **On the sky view, mid-session:** the `#nextCard` (lead plane: the armed countdown
  first, else the first transit / shown near miss; redrawn at 10 Hz — it is what you
  read from a metre away with the camera up), zoom −/+ (and the wheel) over
  `SPANS`, near-miss filter, map toggle, `?` legend. `#skyState` replaces an empty
  sky when the target is down: rise time and direction, when it clears `GOOD_EL`,
  and a switch to the other body if that one is up (still through the sun gate).
- **Sidebar:** predicted passes open; all tracked planes and the pass log are
  `<details>`, collapsed unless left open (`plane-transit-open-*`).
- **Settings panel, rarely:** location, height, sound check; data source, radius,
  low planes and geoid under Advanced.

**Privacy:** the position is stored only in the browser, and `fetchLive()` sends it
rounded to 0.01 deg with the radius padded by 1 nm — the aggregator gets the area,
not the doorstep. `fetchGen` drops responses that were in flight across a
`restartFetch()` (they used to mix real planes into mock mode).

## Conventions that are deliberate

**Angles in degrees, distances in meters, speeds m/s.** Conversions (`FT`, `KT`,
`FPM`) are applied at ingestion so everything downstream is SI.

**One target, two bodies.** The global is `target` — the currently selected body's
`{az, el, angR, illum, azRate, elRate}`. Everything per-body lives in the `BODIES`
table (engine name, radius, disc colour, accent, glow, whether phase is meaningful,
and the `sky` canvas palette); `body()` returns the active entry. No code outside
`updateTarget()` and the render functions should care which body is selected.

**The theme has two halves and they must move together.** The DOM half is the
`body.sun { --bg: ... }` override block in `index.html`; the canvas half is
`BODIES[...].sky` in `app.js`, because `ctx.fillStyle` cannot read a CSS variable.
`renderTables()` toggles the `sun` class on `<body>`. Add a colour to one half and you
must add it to the other, or the page and the canvas will disagree. Nothing inside
`render()` / `renderMap()` should hardcode a colour again: everything reads from
`sky` (grid, gridText, ground, horizon, horizonText, unlit (moon only), transit, near, far,
mapFilter, mapDim, mapRing, mapText, observer) or from the body's `disc` / `accent`.
Moon reads cold, sun reads warm (dark sepia, sand, faded-ink reds) — deliberately, so
the two modes are never mistaken for each other at a glance in the field. Sun mode is
still *dark*: it is the same night-UI shape lit warm, not a light theme.

`target` is a global in a non-module script, so **never name a local `target`** —
`spawnMockPlane()` originally had one for the aim point and it silently shadowed the
global (a TDZ ReferenceError one line earlier). It is called `aim` now.

**Everything is placed where it appears (refraction on both sides, unequally).**
This replaced an earlier convention that computed both body and planes airless on
the theory that refraction "bends both nearly equally along the same sight line, so
it cancels". It does not: the body's light crosses the whole atmosphere, a plane's
only the air *below* the plane. The first field test (Sept 2026, moon at 4-5 deg)
heard the on-disc tone end 3-5 s *before* the real crossing — a long tone, i.e. a
slow, mostly vertical pass.

- The body gets full astronomical refraction in `bodyAzEl()`
  (`Astronomy.Refraction('normal', alt)`, ~10' at 5 deg, ~5' at 10 deg, ~1.7' at
  30 deg). It matches `Astronomy.Horizon(..., 'normal')` exactly.
- Each plane gets `refrShare(dh)` of the full lift at its own elevation, in
  `azElRange()`: for refractivity decaying exponentially (scale height 8 km), a target
  `dh` above the observer is lifted by `f(x) = 1 - e^-x - (1 - e^-x(1+x))/x`,
  `x = dh/8000` — 6% at 1 km, 17% at 3 km, 43% at 10 km. It is a model (±20% of the
  differential is a fair guess), but it removes an error that was 0.15-0.23 deg
  with the target at 3-5 deg.
- `pointAt()` (mock only) stays geometric; mock aim points sit a few arcminutes high.

**Heights are above the WGS84 ellipsoid.** ADS-B `alt_geom` is GNSS height above the
ellipsoid; the user's elevation is above sea level. `cfg.geoidM` (from `geoidAt()`
while `cfg.geoidAuto`, ≈43 m around Amsterdam; hand-editable under Advanced) bridges them: the observer sits at
`obsHeight() = elev + geoidM`, and a plane with only `alt_baro` (pressure altitude,
roughly sea level) gets `+ geoidM` too. Leaving the geoid out put the observer 43 m low,
so every plane was drawn `43 m / range` too high (0.12 deg at 20 km). "Use my
location" takes only lat/lon: phone altitude (ellipsoidal, tens of metres off) is not
used; ground height comes from the terrain lookup instead. `p.altSrc` records
`geom` / `baro` / `mock`.

Both errors pushed planes *up* relative to the target. Measured on live traffic with
the moon at 3.1 deg, switching frames moved every plane 0.24-0.47 deg (1-1.9 disc
radii) down relative to the moon. For a plane crossing sideways that changes where it
crosses (a predicted 1 R miss can be a centre hit); for a plane rising across the
sky at ~0.05 deg/s it moves the crossing ~5 s later — the field report. The general
rule: a vertical position error `b` becomes a timing error `b · up / (up² + side²)`,
where `up`/`side` are the plane's sky velocity components.

**Age every snapshot you hand on.** `cached()` gives the same upstream response to
every browser for up to `CACHE_MS`, and the local `aircraft.json` is up to a second old
when read. Both paths add that age to each aircraft's `seen_pos` before answering
(`_meta.cacheAgeS` reports it). Forget this and the browser dead-reckons from a
timestamp that claims to be fresher than it is — ~500 m of silent along-track error for
an airliner on a 2.5 s cache. Do not pass an aggregator's `now` field through as a
correction: the skew between their clock and ours is unknown. Only our own cache age is
exactly known, and only the local receiver shares our clock.

**Extrapolate from the position timestamp, not from now.** `posTime` is
`Date.now() - seen_pos*1000`. Feed latency (2-15 s on public aggregators) is the
single largest error source in the whole tool — larger than any math here. Anything
that silently treats a fix as current will produce confidently wrong predictions.

That includes *drawing* it. `p.az/p.el/p.range/p.sepNow`, the trail and the map dot
are all the dead-reckoned position at `t = 0`, i.e. `samples[0]` — never the raw
`p.lat/p.lon`. The raw fix used to be drawn as the dot, which put it behind the start
of its own predicted line by `age × speed`: 2-5 disc radii typically, 8 deg for a
close plane with a 10 s-old fix. Verify with
`angularSep(p.az, p.el, p.pred.samples[0].az, p.pred.samples[0].el)` — it should be ~0.

A poll that returns the *same* fix again re-derives `posTime`, and network latency
jitters that by up to ~1 s. `upsertPlane()` keeps the earliest estimate for an
unchanged position (latency can only make a fix look newer than it is).

**Prefer `alt_geom` over `alt_baro`.** Barometric altitude can be off by hundreds of
feet, which at close range is a large fraction of a degree of elevation.

**The target moves too.** Both bodies drift ~0.25 deg/min, roughly half a radius over
a 30 s window. `targetAt(t)` linearizes this; the intersection test is plane-track vs
target-track, never vs a static disc.

**The sun and the moon are nearly the same apparent size** — angular radius 0.262-0.271
deg for the sun over the year, 0.245-0.279 deg for the moon. That coincidence is why one
set of view spans, ring radii and alert thresholds serves both, and why `angR` is always
read from `target` rather than hardcoded. The moon is drawn in phase (`drawPhase()`): lit fraction `illum`, bright limb
turned towards the sun by `target.limb` — the sun's direction from the moon in the
sky view's own frame (0 = up, 90 = right), so the terminator tilts as it really does
in your sky. The dark part stays faintly drawn: a plane crossing it is still a
transit, it just won't show as a silhouette. `illum` is `null` in sun mode (phase means
nothing there) and `renderTables()` hides that header stat rather than printing `100%`.

## Pass log (field calibration)

Every tone actually committed by `countdownLoop()` is appended by `logPass()` to
`passLog` (last 30, `localStorage["plane-transit-passlog"]`, also `console.log('[pass]')`):
predicted tone start/end and closest-approach `mid` (wall-clock ms), miss in R,
the sky velocity `up`/`side` (deg/s) at closest approach, elevation, range, altitude
and its source, ground speed, and the fix age when the tone was committed. **Space**
sets `seen` on the most recent row whose tone was within ±15 s; the table shows
`seen − mid`. Reading a handful of rows:

- the same offset whatever the geometry → a feed timing bias (latency makes real
  passes *earlier* than predicted, i.e. negative);
- offset scaling with `up / (up² + side²)` and flipping sign with `up` → a vertical
  error (heights, geoid, refraction model);
- offset scaling with `side / (up² + side²)` → the observer's lat/lon (every 200 m of
  error across the line of sight is ~1 s for a 200 m/s plane, independent of range).

Space is swallowed (keydown *and* keyup, since buttons and checkboxes activate on
keyup) everywhere except text/number inputs and selects: a focused sound checkbox
would otherwise switch the sound off mid-countdown. The Claude Code browser pane's
`key` action sends Space with empty `code`/`key`, so it can't drive this. Test with
dispatched `KeyboardEvent`s instead (`isSpace()` also accepts `key === ' '`).

## Classification semantics

`predict()` samples the next 90 s at 1 s, then **refines to 0.05 s around the coarse
minimum**. Do not remove the refinement: a jet 8 km out moves ~1.8 deg per second
against a 0.53 deg disc, so at 1 s steps a dead-centre transit landing between two
samples was reported as a 1.4 R near miss — orange, and silent. `tBest` is the
fractional time of closest approach (`tMin` is it rounded, for display), `azMin/elMin`
its position, and `tIn/tOut` the nominal disc entry/exit to 0.02 s (null for a miss;
searched only ±2.5 s, as far as the audio tone can reach). All `t` values are seconds
after `pred.at` (wall-clock ms), because the audio scheduler runs between predictions.

- `transit` (red): the **nominal** path crosses the disc (`sepMin <= target.angR`).
- `near` (orange): within 3 target radii, **or** a possible transit once uncertainty is
  included (`sepMin <= angR + delta`).
- `far` (grey): everything else.

An earlier version folded `delta` into the transit test, which made a plane missing by
2.5 radii light up red. Keep the nominal/uncertain distinction — the user compares
these against what they actually see out the window.

## Prediction history (the fading lines)

Each distinct fix (`fixKey` = position + velocity) yields one predicted track stored
in wall-clock time (`p.curve.pts[].T`). When a new fix arrives the old curve moves to
`p.ghosts`, and ghosts older than `GHOST_S` (10 s, from when their fix was first seen)
are dropped. `render()` draws each ghost from *now* onward, interpolating the first
point, fading with age, under the current line — so they only show where they
disagree with it. This is the empirical counterpart of the error model below: the
model says how wrong a track *could* be; the fan shows how much it is actually moving.
A straight mock plane's ghosts agree to ~0.03 deg at +30 s; mock planes turning at
0.2-0.6 deg/s fan out 0.25-2.6 deg, growing as range shrinks.

## Error model

`posErr = 60 + gs*0.3 + growth*(age + t)` meters, converted to an angle via the slant
range. `growth` is 3 m/s normally, 25 m/s when `maneuvering` (recent track or
vertical-rate change). This is a heuristic, not a covariance — it exists so the UI can
show an honest uncertainty circle rather than a fake-confident line. Note that angular
error scales as 1/range: a close, low plane is inherently mushier than a cruising jet
40 km out, and the display should keep saying so.

## Data providers (state as of Sep 2026)

Browsers cannot call these APIs directly — **none send CORS headers**. That is the
only reason `serve.js` exists. `/api/planes?src=...&lat=&lon=&r=` proxies them and
returns `{ now, aircraft, _meta }`; `_meta` carries the per-source counts the header
line shows. A plain user agent gets **403** from adsb.fi — always send one.

| source | status | notes |
|---|---|---|
| `adsbfi` (opendata.adsb.fi) | **works, default** | fast; returns `aircraft` key |
| `adsblol` (api.adsb.lol) | flaky | was fully unreachable during development; returns `ac` key |
| local receiver (`PLANE_TRANSIT_LOCAL_URL`) | merged in when set | tar1090 `aircraft.json`, same schema |
| airplanes.live | **unusable** | now 403s without registration; removed from the UI |

Parsing traps: the aircraft-list key differs per provider (`ac` vs `aircraft`, both
handled); `alt_baro` can be the **string** `"ground"`; `gs`/`track` are missing on some
records. Rate limiting is real — a 429 triggers a 15 s client-side backoff.

**Measured 20 Sep 2026** (30 nm around one home antenna, vs adsb.fi):

| | aircraft with position | fix age median | p90 |
|---|---|---|---|
| adsb.fi | 40 | 0.3 s | 4.6 s |
| local receiver | 16 | 4.4 s | 25.8 s |

That is worth internalising: the public feed is currently **fresher and wider** than
the receiver, so the old "latency 2-15 s dominates everything" note below is pessimistic
for adsb.fi — though its p90 still reaches several seconds, and stale fixes are still
the thing to suspect when a prediction misbehaves. The local receiver earns its place
as a backup (public down or rate-limited) and for the occasional aircraft the public
feed lacks, not as an upgrade. `aircraft.json` is rewritten ~1 Hz and cached 0.9 s, so
a local fix is 1-2 s old at best; its `seen_pos` is corrected by the file's own age,
which is exact because it is the same machine's clock.

The receiver's weakness is **coverage, not transport**. Its feeder also streams
line-delimited JSON with every field on port 30047, 7-32 ms behind its own timestamp —
far fresher than the 1 Hz `aircraft.json` we poll — and readsb has an unexplored API on
30152. Deliberately not used: over 4 minutes the antenna heard 8 aircraft, only 2 of
them inside the 30 nm radius (adsb.fi: 16-40). What it hears it tracks at 0.5-1.1 s
between position messages, so the stream would be ~0.3 s fresh against ~0.5 s for the
public path with one browser open — ~40 m of dead reckoning, for two aircraft. Not
worth a persistent socket, reconnect and age-out table. Revisit if the antenna is
re-sited; `mergeFeeds()` already does the right thing with fresher records.
(The 4.4 s median in the table above counts aircraft the receiver had *lost*, still
lingering in `aircraft.json`; per tracked aircraft it is sub-second.)

`mergeFeeds()` keeps the public list as the base and lets a local record win only by
more than 0.5 s (hysteresis: a flip-flopping source would jitter the track), never with
a record missing speed/track/altitude (`usable()`). Public failure alone is not an
error while local data exists — that is the backup path, and it is tested by pointing
the upstream at an unreachable host.

**Not implemented:** automatic failover between the two *public* providers when one
times out. The plumbing is trivial since both go through the same proxy path.

## Map inset

Real OpenStreetMap raster tiles, drawn to canvas with `crossOrigin='anonymous'` so the
canvas stays untainted (the `/api/snap` debug path below needs `toBlob`). Tiles are
CSS-filtered to dark to match the UI. Web Mercator inflates ground distance by
`1/cos(lat)`, which is why `scale` and the range rings divide by `cosLat` — drop that
and the rings will be wrong by ~60% at this latitude. Keep the OSM attribution.

## Audio

Designed for the last 30 s, when the user is behind the camera and not looking at the
screen. Optional and off-switchable: with `cfg.sound` false, `checkAlerts()` disarms
everything and no audio node is created at all — not merely a muted gain.

Two layers, deliberately split:

- **`checkAlerts()`, 1 Hz, after `predict()`** decides *who* is counted down.
  Arming is strict (`alertWorthy`: transit, trust high, `delta <= 3*angR`,
  `tBest <= 30`). Staying armed is loose: up to 1.5 R and above the horizon, whatever
  the trust. That hysteresis is intentional — a prediction flickering across 1.0 R or
  a fix going briefly stale must not chop the countdown into pieces. A plane whose
  closest approach is now or past (`tBest < 0.05`) disarms silently; anything else
  that disarms (drifted past 1.5 R, or lost) plays the falling CALLED_OFF chime if it
  had been announced and its tone has not played. The rising HEADS_UP chime is
  retried every tick until audio is unlocked, then recorded in `alerted`.
- **`countdownLoop()`, 20 Hz** turns the lead plane (earliest closest approach among
  `armed`) into sound on the AudioContext clock, committing at most `LOOKAHEAD_S`
  (0.12 s) ahead, so a changed prediction is heard within one blip. Blip spacing is
  `beepGap(s) = clamp(s/10, 0.15, 2)`, re-derived on every pass against the *last*
  blip, so the cadence tightens immediately rather than after a stale 2 s wait.
  `toneWindow()` holds a steady tone entry→exit, 0.35-5 s, centred on closest
  approach whenever it is clamped (a slow radial pass sat on the disc for ~8 s in
  testing, and an entry-anchored 3 s cap ended the tone before the best moment).

All four sounds share `note()`, one pitch (880 Hz) for blips and tone, like a parking
sensor. `resetCountdown()` runs on sound-off, target-body change, and
`restartFetch()` — the last because clearing `planes` would otherwise read as every
armed plane being "lost" and fire a CALLED_OFF chime each. The `alerted` pruning runs
*after* the disarm pass, since that pass needs to know who was announced.

`cfg.soundVol` (1 / 3 / 6) multiplies every peak gain in `note()`, clamped to 0.5.
The base levels were tuned for a quiet room; sun mode is usually outdoors in daylight,
where the soft setting is inaudible. **Test sound** plays HEADS_UP, a compressed
countdown and a tone (~4 s) and doubles as the gesture that unlocks `AudioContext` —
a cue you only discover is silent during the actual transit window is worthless.

Browsers block `AudioContext` until a user gesture; `ensureAudio()` returns null while
suspended. The header shows "click to enable" until then.

**Screen wake lock.** While sound is on and the page is visible, `syncWakeLock()`
holds `navigator.wakeLock` ('screen'), re-requesting on `visibilitychange` (browsers
drop it when the page is hidden). A locked screen suspends the page and with it the
countdown. It needs a secure context: `localhost` qualifies, a plain-http LAN IP from
a phone does not, and `#wakeNote` says so. The Claude Code browser pane denies the
request outright (`NotAllowedError`), so the success path has not been exercised
there — check it in a real browser.

Timers in background tabs are throttled to ~1 Hz, which would starve the 20 Hz
scheduler; the wake lock plus keeping the page in front is the mitigation, not a
larger lookahead (committed audio cannot follow a changed prediction).

## Testing

**Automated:** `node --test test/*.test.js` (Node 18+, no dependencies; CI runs it on
every push, plus a Node 14 start-up check of serve.js). `test/load-app.js` runs
`astronomy.browser.min.js`, `geoid.js` and `app.js` in a `vm` sandbox where every DOM
lookup returns an inert stub, so the maths can be called directly: `parseLatLon`,
`geoidAt`, `refrShare`, `predict` (including the sub-second refinement and the
dead-reckoned "now"), the tone window and the arming rules. `test/serve.test.js` covers
the static allowlist, bad requests, `/api/snap`'s guards, `mergeFeeds` and the upstream
cap; it never contacts an aggregator. If you add top-level code to app.js that needs a
real value from the DOM at load time, the stub may need teaching about it.

**`mock` source** spawns synthetic planes deliberately aimed at the target (some hit,
some miss) with simulated feed latency. Use it to exercise the display when no real
transit is due — real ones are rare. Each mock plane is defined by a reference point
it passes through at `tRef` and a constant turn rate `omega` (40% of planes turn at
0.15-0.6 deg/s), so turning planes still genuinely cross the aim point while
straight-line dead reckoning from their early fixes drifts — that is what exercises
the fading prediction lines. Fixes report the truth at `now - age`, stamped `age` s
old. (An earlier version reported the *current* truth with an old stamp, which made
extrapolation overshoot and, once the dot was drawn dead-reckoned, jitter by degrees.)
Crossing planes only spawn when the target is more than 2 deg up. Their miss offset
(uniform ±2 R) is applied **perpendicular to the plane's apparent motion** (`skyDir`).
It used to be added to azimuth only, which for a plane moving sideways across the sky
just changes *when* it crosses: with the moon at 4.7 deg, 98% of crossing planes came
out as transits; now it is ~50%, evenly spread over 0-2 R.

**`POST /api/snap`** with a PNG body writes `snap.png` next to the sources. This exists
because screenshots are unavailable in some agent environments: draw the canvas(es)
into an offscreen canvas, `toBlob`, then `fetch('/api/snap', {method: 'POST', body:
blob})` and read the file. It only answers loopback clients, only `Content-Type:
image/png` (which a blob from `toBlob` sets; a cross-site form cannot send it without a
preflight) and only up to 20 MB. Delete `snap.png` when done; it is gitignored.

To verify audio without hearing it, wrap `AudioContext.prototype.createOscillator`
so each node's `start(when)` logs `frequency.value` and `when` (and `stop` gives the
duration). Unlock audio with a *real* click on Test sound first — a scripted
`.click()` is not a user gesture. Two complementary checks:

- **Logic**, synchronous: clear `planes`/`mockWorld`, call `resetCountdown()`, insert
  fake planes `{hex, flight, ghosts: [], trail: [], klass, trust: 'high', pred: {at:
  Date.now(), tBest, tMin, sepMin, delta, elMin: 10, azMin: 0, tIn: null, tOut: null,
  samples: []}}` and call `checkAlerts()` between mutations. Expected: arm → 784,
  1046.5 (HEADS_UP); `sepMin` 1.2 R → still armed, silent; 2.0 R → 1046.5, 784
  (CALLED_OFF); plane deleted → CALLED_OFF; `tBest = 0` → disarmed, silent; sound off →
  disarmed, silent; 1.4 R or `tBest` 45 → never arms. Do not assign to globals like
  `note` from the console — plain-script function declarations live on `window`.
  Reload afterwards: fake planes have no `lastSeen`, so `dropStalePlanes()` never
  removes them.
- **Timing**, live: run `mock` for a minute and print the logged notes against the
  arm/disarm times. Blips should run 2 s apart, tighten to 0.15 s, give way to one
  tone per pass, and resume for the next plane after the tone ends.

When measuring the fan of ghost tracks, interpolate both curves to the same wall-clock
`T`; comparing nearest 2 s samples invents ~0.8 deg of spread for a straight plane.

## Known limitations / next steps

1. Feed latency is still the error to suspect first. adsb.fi's median fix age is
   ~0.3 s, but its p90 is several seconds. A local receiver is merged in already;
   measured, it was not fresher and heard fewer aircraft (see "Data providers"), so it
   is a backup. Better antenna siting, then the receiver's streaming port, is the path
   if that changes.
2. Linear dead reckoning breaks in turns. `maneuvering` only widens the error band, and
   the fading prediction lines only *show* the drift; nothing corrects for it. Gentle
   turns (under ~1 deg per poll) are not flagged as maneuvering at all.
3. No provider failover (above).
4. Field validation has only just started: one evening, one report ("tone ends 3-5 s
   before the plane"), which led to the refraction and geoid fixes above. The pass log
   exists to collect more; nothing has yet confirmed the corrected frame in the field.
   The refraction share is a model assuming standard air.
5. Sun mode has its own warm palette but is still dark, which is right indoors and
   marginal outdoors in bright daylight on a phone. If field-testing says it is not
   readable, the hook is already in place: add a third variant to the `body.sun` CSS
   block and a matching `sky` palette, rather than special-casing colours at the call
   sites.
6. The tone is committed ~0.1 s before it starts and does not follow a prediction
   that shifts while it plays (a new fix mid-tone). Fine for a steady bias; a
   refinement if the log shows late jumps.
