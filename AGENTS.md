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

- `index.html` — markup + all CSS. Settings UI writes to `localStorage["plane-transit-cfg"]`,
  and the site part of it (`SITE_KEYS`: position, heights, geoid, source, radius, low
  planes) also to the server's settings file through `PUT /api/config` (`pushSite()`,
  debounced). At start-up `loadServerSite()` runs first: the server's site wins over
  the browser's copy, and a server with none adopts this browser's. Target, zoom,
  sound and map stay per device. `cfg.body` (`'moon' | 'sun'`) defaults to `'moon'` when absent.
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
- `engine.js` — the maths, with no globals: geodesy, refraction, body positions,
  aircraft ingestion (`aircraftFix`, `upsertPlane`), dead reckoning and `predictPlane`.
  Loaded by the page as a plain script (`window.PlaneTransitEngine`) and by the server
  with `require`; **both must make the same prediction, so prediction maths goes here,
  never into app.js or watch.js.** It takes the observer as a `site` (`makeSite`) and the
  body as a `target` (`bodyTarget`), and returns results rather than mutating the plane.
- `app.js` — the page: canvases, tables, audio, settings. It keeps thin wrappers with
  the old global names (`azElRange`, `sepAt`, `predict`, `updateTarget` …) over
  engine.js, built from `cfg`/`observer`/`obsECEF` by `site()` on every call, so the
  tests and the rest of the file read as before. `predict()` adds the page-only parts
  (trail, ghost tracks) on top of `predictPlane()`.
- `watch.js` — the server's watcher (see "Always-on mode and the API" below).
- `config.js` — the settings file: load, validate, atomic save, `PLANE_TRANSIT_WATCH`.
- `geoid.js` — EGM96 geoid heights on a 3° grid (~24 KB) and `geoidAt(lat, lon)`,
  generated from the NGA model (public domain) via egm96-universal. Within 2.7 m of
  the full model for 95% of the globe — a few metres is ~0.01 deg at 20 km, noise.
- `serve.js` — static server, ADS-B proxy, shared snapshot cache, local-receiver merge,
  upstream budget, settings endpoint, `/api/state` and `/metrics`.
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
global `fetch` in serve.js, watch.js, config.js or engine.js** (it arrived in Node 18),
and no syntax newer than Node 14 there (`??`, `?.`, `||=`). `PLANE_TRANSIT_PORT`,
`PLANE_TRANSIT_BIND`, `PLANE_TRANSIT_LOCAL_URL`, `PLANE_TRANSIT_CONFIG`,
`PLANE_TRANSIT_CONFIG_READONLY` and `PLANE_TRANSIT_WATCH` configure it. `require()`-ing
serve.js starts nothing (no timer, no settings read); the tests import `handle`, the
merge helpers and the budget from it, and call `loadSettings()` themselves.

**Nothing polls on a timer unless always-on mode is switched on.** By default the
browser drives everything: the client asks `/api/planes`, and only then does the server
ask an aggregator. That is what makes the pi free to leave running — see the pause
rules in `pollPause()` (hidden page past a 60 s grace unless a countdown is armed;
target below -2 deg) and the presence logging in serve.js. `cached()` gives every
browser the same snapshot with one in-flight upstream request per key, so extra tabs
and devices cost nothing. The always-on watcher is the one deliberate exception, off by
default, switched on only in the settings file, and paced by the sky (below). Keep it
that way: an interval that fetches regardless of what there is to see would quietly
burn the quota.

**One upstream budget for everything** (`upstreamRefusal()`), browser and watcher
alike: 5 requests per 10 s (half adsb.fi's published 1/s), 20,000 a day, and after any
4xx a pause of 30 s doubling to 15 min (`upstreamResult()`), because adsb.fi counts
refused requests against the limit and may block an IP that keeps making them.
Timeouts and 5xx don't back off; the next poll is the retry. Requests send
`Accept-Encoding: gzip` and a user agent naming the project (a plain one gets 403).
The server also rounds lat/lon to 0.01 deg, as the page does, so a caller can't mint
a cache key per metre.

## UI layout (what is used when)

Sorted by how often a photographer touches it, not by when it was built:

- **Header, every session:** Moon/Sun toggle, where to point (`S 178° · 14.5° up`,
  exact numbers + diameter + set time in the tooltip), % lit, feed status dot, sound
  button (on / off / "tap to enable" while the browser blocks audio), clock, ⚙.
- **On the sky view, mid-session:** the `#nextCard` (lead plane: the armed countdown
  first, else the first transit / shown near miss; redrawn at 10 Hz — it is what you
  read from a metre away with the camera up), zoom −/+ (and the wheel) over
  `SPANS`, near-miss filter, map toggle, `?` legend. A click on the map inset enlarges
  it over the sky view (see "The map"): the same −/+ then zoom the map, ⌖ recentres,
  the toggle reads "sky view", and the legend shows the map's own marks. `#skyState` replaces an empty
  sky when the target is down: rise time and direction, when it clears `GOOD_EL`,
  and a switch to the other body if that one is up (still through the sun gate).
- **Sidebar:** predicted passes open; all tracked planes and the pass log are
  `<details>`, collapsed unless left open (`plane-transit-open-*`).
- **Settings panel, rarely:** location, height, sound check; data source, radius,
  low planes and geoid under Advanced.

**Privacy:** the position is stored in the browser and in the server's settings file
(so that every device and the watcher share one setup), and `fetchLive()` sends it
rounded to 0.01 deg with the radius padded by 1 nm — the aggregator gets the area,
not the doorstep. `/api/state` and `/metrics` never include it. `fetchGen` drops responses that were in flight across a
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
silhouette, mapFilter, mapDim, mapRing, mapText, observer) or from the body's `disc` / `accent`.
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
an airliner on a 2.5 s cache.

**The public feed's answer is itself a snapshot, and its age counts too** (`feedAgeS()`
in serve.js, `_meta.feedAgeS`). adsb.fi rebuilds what it hands out every 2 s, and every
`seen_pos` in it counts from the snapshot's `now`, not from our request. Measured on
live traffic (Nov 2026): polled every 3 s, the answer was 0.7 and 1.7 s old in turn, so
positions advanced by 2 s and 4 s of flight alternately while `seen_pos` said "0.2 s"
every time. Every plane was drawn 0.5-2 s (100-450 m for a jet) behind where it was,
and corrected by ±230 m at each poll — 99% of corrections were over 50 m. With the
snapshot's age added, the median correction is 5 m and 1% are over 50 m.
This overturns an earlier rule here ("do not use the aggregator's `now`: the skew
between their clock and ours is unknown"). The skew *is* unknown, so it is measured:
the smallest `our clock − their now` seen in the last 10-20 minutes. If that is within
a refresh of zero (-0.3 to 2.5 s) the clocks agree — any NTP-synced box — and the
difference is taken as the age. If not, only the change from that freshest answer is
counted: the 2 s rhythm is still removed, an unknown constant under one refresh is
not. A jump of a minute is a clock being set, and starts the measurement over.
adsb.lol's `now` is in milliseconds; both are handled. The local receiver needs none
of this: it shares our clock.

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
`seen − mid`. From three marks on, `passLogOffset()` sums them up under the table:
median offset, median deviation, and whether the offset is steady (larger than the
scatter and than 0.3 s). Medians, so one fumbled press moves neither. It is only
reported — never applied to a prediction. Reading a handful of rows:

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

The fan's numeric side is the **miss trend**: each curve also keeps `miss` (its
`sepMin`, or null when the minimum sat at either end of the window — passed, or still
coming — see `realMin()`), and `missFrom()` returns the oldest ghost's miss when the
current one differs by at least `TREND_R` (0.5 R). The passes table and the card then
show `1.4→0.6 R`. Measured on live adsb.fi traffic (Sept 2026, moon at 20 deg): a
steady plane moves it 0.02-0.3 R between fixes; a departure turning 35 deg moved it by
tens of R. A turn shows up here even when it is too gentle for `maneuvering`.
It is shown instead of "turning towards / away from you": which way the plane turns
on the ground does not say whether it turns onto the disc; this does.

`pred.dir` is the way the plane crosses the sky at closest approach, relative to the
target (the camera follows it), in the sky view's frame: degrees from up towards
screen right, like `target.limb`. The table and card draw it as a rotated SVG arrow
(`dirArrow()`, `#ncDir`); with the plane off screen it is what says which edge of the
frame it will enter from. In the sky view, `drawHeads()` puts arrowheads along each
predicted line every `HEAD_GAP` px of screen.

## Sky view: the dome and the depth cues

`project()` is stereographic, centred on the target, zenith up — the sky as a dome
seen from inside. It replaced a flat chart (x = Δaz · cos el₀, y = Δel) that was right
only near the centre: it spread the zenith over the full width, so an overhead pass
drew a streak across the view. Things to know before touching it:

- It is conformal and its scale at the centre is exactly `ppd`, so the disc, the 3 R
  ring and the uncertainty circles stay circles, and near the target it agrees with
  the flat frame engine.js reports in (`pred.dir`, `target.limb`, `/api/state` paths).
  Do not "fix" those to match: they are the same thing where it matters.
- Past ~127° from the target (`Z < -0.6`) points are held on a ring 4 rad out, in the
  right direction. That bounds every coordinate, which the horizon relies on: it is
  a 360-point polygon filled even-odd, not `ctx.arc` — with the target low the true
  circle is millions of pixels across, and Safari and Firefox draw arcs as cubics.
- Grid lines are sampled only within `reach` (the view's corner, as an angle).
  Meridians stop at 80° except every 30°, or the zenith is a blot.

Where a plane appears says nothing about whether it is coming or going; **size does**.
Everything about a plane is scaled by `depth(range) = min(1, NEAR_M / range)`, true
1/range perspective: the plane shape (`drawPlane()`), the band along its track and
trail (`drawBand()`, also fading with distance) and the arrowheads. A jet closing
from 27 to 15 km grows 80% along its line; a sideways crosser stays even. A gentler
curve (a square root was tried on paper) flattens exactly that difference. The label's
second line says it in words from `rangeRate()` (first two samples, ±`CLOSING_MS`).
Sizes are *not* to scale — an airliner at 20 km spans a fifth of the disc.

The plane shape is a flat model turned to its track and seen from below at the
plane's elevation, but never flatter than `MIN_TILT` (35°): truly edge on, a low
plane is a dash. Its attitude alone does not settle in or out (a foreshortened shape
reads both ways — an earlier note here ruled out a 3D arrow for that reason); the
size gradient along the band is what does, and the shape only has to agree with it:
nose up the screen coming, down towards the horizon going.

## Following a turn

`planeAt()` used to be a straight line from the last report, whatever the plane was
doing. Now `upsertPlane()` keeps the track of the last few distinct reports
(`p.fixes`, by each report's own time) and `turnRate()` turns them into `p.turn`,
deg/s. **It is 0 unless the reports agree**: at least three within 12 s, covering 4 s,
every step the same way and none of them nearly flat (a flat step means the turn is
over), at least 0.3 deg/s and 2 deg in all. ADS-B track wanders by a few tenths of a
degree; with 0.6 deg of noise a straight flight was never once taken for a turn. And
with `p.turn` 0, `planeAt()` runs the old lines unchanged — a test compares it with
the old formula to the last bit. So only planes caught turning are predicted
differently.

For those, the plane flies its arc for `TURN.holdS` (12 s) past the report and
straight on from the heading reached. Not the whole 90 s: a turn that stops early
would be extrapolated into a circle. Measured on synthetic flights reported every
3 s (rms position error, straight line → this):

| | at +10 s | at +20 s | at +80 s |
|---|---|---|---|
| steady 0.4 deg/s turn | 92 → 16 m | 336 → 67 m | 5.0 → 3.6 km |
| steady 1.5 deg/s turn | 285 → 11 m | 1032 → 193 m | 13.6 → 10.2 km |
| 45 deg bend at 1.2 deg/s | 157 → 110 m | 541 → 404 m | 5.7 → 5.3 km |
| 20 deg bend at 1 deg/s | 110 → 107 m | 348 → 363 m | 3.1 → 3.1 km |
| S-turn, 30 deg each way | 134 → 106 m | 453 → 394 m | 3.7 → 4.1 km |

So: a large gain where it matters for the tone (the last 20 s of a steady turn), a
wash on short bends (the turn is half over by the time three reports show it), and up
to 10% worse far ahead when a turn reverses. A longer hold wins more on steady turns
and loses more on the rest; `TURN.holdS = 0` switches all of it off. `maneuvering`,
`trust` and the error model are deliberately untouched: a gently turning plane still
arms as before, and the passes table marks it `↻` (`⚠` stays for hard manoeuvres).

## Animation

**Drawing must never change a prediction, and a test holds it to that**
(`drawing changes nothing that the prediction, the alerts or the tone read`): the same
traffic through two fresh pages, one drawing thirty frames a tick and one never
drawing, must give byte-identical predictions, classes, trust, miss trend, arming and
tone windows. The only thing drawing writes to a plane is `p.drawn`, which only
`shownPos()` reads. Keep it so: anything new that a frame wants to remember goes there,
never into a field `predict()`, `checkAlerts()` or `countdownLoop()` look at. Drawing
also shares one thread with the 20 Hz tone scheduler, so `animate()` gives itself at
most a quarter of it: after a frame that took `x` ms it waits at least `4x` (and never
less than 30 ms).

`tick()` predicts once a second; `animate()` redraws the sky ~30 times a second in
between (requestAnimationFrame, so not in a hidden tab; not with
`prefers-reduced-motion`; not the map inset, whose filtered tiles are expensive).
A frame computes nothing new: `posNow()` asks the same `planeAt()` + `azElRange()`
that `predict()` uses for the frame's own moment, and at a tick it returns the tick's
position exactly (tested). **It is extrapolation, not interpolation between reports**
— interpolating would draw every plane one report behind. Tracks, bands and the
`+30s` ticks start from the frame's position too, so the arrowheads flow along with
the plane.

**The drawn plane slides to a new report; it does not jump** (`shownPos()`). Once the
motion was smooth, every new report showed as a twitch. Nearly all of that was the
feed's snapshot age (above), fixed where it arises; what is left is the honest
disagreement between two reports — 5 m typically, 15 m at the 90th percentile, more
when a late report or a turn comes in — and that is what gets eased.
`shownPos()` remembers the report a plane was last drawn from; when it changes, the
offset between the old track flown on to this frame and the new position is kept as
`p.drawn.slip` and eased to zero over `SLIP_S` (1.5 s, smoothstep; a correction
arriving mid-slide starts from wherever the marker is). A typical correction is a
fraction of a second of flight, so the plane slows a little or hurries a little and
never backs up. **Only the marker does this.** `p.az` / `p.el`, the track, the miss,
the tables and the tone switch to the new report at once — `posNow()` stays the raw
position and is what the tests compare with a tick. A correction over `SLIP_MAX_M`
(1.5 km) still jumps: that is not timing noise, it is news, and the fan of old
predictions shows the same thing. A plane not drawn for 2 s (off screen, hidden tab)
starts fresh. The cost is honesty of the marker for up to 1.5 s after a report: it can
be a few tens of metres from the best estimate, which matters only to someone judging
a crossing by eye in that instant rather than by the tone.

## The plane to scale

For a transit or near miss with its closest approach still ahead, `render()` draws
the plane at that point at its true size: `wingspanM(p)` (ICAO type → `WINGSPAN_M`,
else the ADS-B size class `p.cat`, else 36 m) over `pred.rangeMin`, with its real
tilt (no `MIN_TILT`). Dark (`sky.silhouette`) on the disc, outlined in the class
colour when it misses. Skipped under 3 px half-span, i.e. unless zoomed in. It
answers "how big will it be in the shot": an A320 at 20 km is a fifth of the disc, a
777 at 12 km over half.

## Search radius

`cfg.radiusNm`: 20-120 nm in the UI (config.js accepts up to 249), default 30. What
it has to cover follows from the target's elevation: a plane on the disc is
`altitude / tan(el)` away, plus up to ~21 km for the 90 s before it gets there. At
30 nm a cruising jet is fetched in time only with the target above ~19 deg, and not
at all below ~12 deg. Cost, measured with 400 planes (roughly 120 nm over busy
airspace): a tick's predictions take ~35 ms in desktop Chrome, ~0.3 ms per plane in
Node on the same machine — expect several times that on a phone or the pi, where the
watcher predicts every plane once a second per watched body. Drawing does not grow
with it: `render()` leaves out planes whose trail and track stay outside the view
(four projected points per plane), 1-4 ms a frame at 400 planes. An "auto" radius
that follows the target's elevation is the idea on the table; nothing prefilters
planes before `predictPlane()` yet.

## Error model

`posErr = 60 + gs*0.3 + growth*(age + t)` meters, converted to an angle via the slant
range. `growth` is 3 m/s normally, 25 m/s when `maneuvering` (recent track or
vertical-rate change). This is a heuristic, not a covariance — it exists so the UI can
show an honest uncertainty circle rather than a fake-confident line. Note that angular
error scales as 1/range: a close, low plane is inherently mushier than a cruising jet
40 km out, and the display should keep saying so.

## Always-on mode and the API

`watch.js` runs the page's prediction on the server for the configured site and every
watched body (`watch.bodies`; the sun only when named), once a second, and keeps the
result for `/api/state`. It exists so other programs — dashboards, notifiers — can
build on the predictions without a browser and without re-implementing them. It is
deliberately **only a reporter**: no statistics, no history, no notifications in this
repo. Consumers count passes from the state; the server keeps nothing on disk but the
settings.

Data comes in two ways, both through `snapshot()` in serve.js and so through the shared
cache and the one budget:

- **Peek, every tick:** a public snapshot someone else (a browser) already fetched for
  the same cache key, newer than the last one ingested. Never a request of its own.
  `feedParams()` builds the key exactly as the page does (`radiusNm + 1`, 0.01 deg),
  so a page open on the shared settings feeds the watcher for free.
- **Fetch, only with `watch.enabled`:** when what it has is older than the pace asks
  for. `decide()` sets the pace: `paused` (no request) while every watched body is
  below `minEl`; `idle`, `idleS` (15 s) while one is up; `burst`, `burstS` (3 s) while
  an upcoming pass has `missR <= 2` or `missR <= 1 + err0R`. Use `err0R`, not `errR`:
  the latter grows with lead time and put every plane within ~15 km into burst a
  minute out. With a browser polling the same key it waits an extra 2 s before
  fetching, or it jumps into the half-second gap between the page's 3 s polls and
  the 2.5 s cache (measured: 2 extra requests per 30 s before that slack).

15 s idle is enough to see every pass coming: the window is 90 s, so a plane is seen
~6 times before its closest approach. The burst sharpens the timing of the crossing,
and costs ≤ 30 requests per pass. Expect ~5,000 requests a day watching the moon.

**Passes** (`updatePasses()`), keyed `body|hex`. Created when a prediction has a real
minimum ahead (`realMin`), the body up at it, and `missR <= PASS_R` (5). Updated every
tick while upcoming. They end as:

- `passed` — closest approach reached (`tBest` no longer a real minimum) at or after
  the last predicted `tca` (3 s slack), or the plane left the feed after its `tca`;
- `called_off` — prediction drifted past `CALL_OFF_R` (6; the gap to 5 is hysteresis),
  or closest approach jumped to "now" well before the predicted `tca` (a turn away —
  the same rule as the page's audio: the timing, not the miss, tells a pass from a turn);
- `lost` — gone from the feed (30 s stale) before its `tca`, or the body set.

A finished pass keeps the numbers of its **last upcoming prediction** — the shortest
lead, the best — not the post-pass ones, where `sepMin` is just the current separation
growing. Finished passes stay in the state `RECENT_MS` (10 min), so a reader polling
every few seconds sees every ending; `id` (`body-hex-firstSeenSeconds`) lets it count
each once. A plane called off and then back on track is a new pass with a new id.

**`/api/state` format** (`v: 1`; change `v` if you break it): `watch` (mode, reason,
interval, `dataAgeS`, error), `bodies.<b>` (az/el/angR/rates/illum/limb, `watching` =
up past `minEl` with data under 30 s old — the denominator for statistics; the sun's
entry carries a filter warning), `aircraft` (az/el/range from the observer, never
lat/lon), `passes` (times as epoch ms; `missR`/`errR`/`err0R` in disc radii; `path`,
`now`, `closest` as `x`/`y` degrees from the body's centre in the sky view's frame, x
right along azimuth × cos el, y up). **No observer position anywhere in it** — a test
checks.

**`/metrics`** is the service's health in Prometheus text format (requests, refusals,
back-off, mode, interval, data age, body elevations). Pass counts do not belong there;
they are a consumer's business.

**Settings** (`config.js`): `site` is what the page's setup writes; `watch` is only ever
written by hand (or overridden by `PLANE_TRANSIT_WATCH`, which is never saved back —
serve.js keeps `fileWatch` apart for that). `PUT /api/config` takes `{site}` only,
JSON only (a cross-origin page would need a preflight the server never answers),
16 KB max. Everything is clamped on the way in and out, so a hand edit with a typo
falls back to defaults. The file is in its own directory because the unit makes only
that directory writable (`ReadWritePaths`), and an atomic save needs a temporary file
beside it.

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
records. Rate limiting is real — a 429 triggers a 15 s client-side backoff, and the
server's own back-off (above) stops it asking upstream at all for a while. adsb.fi's
terms (checked Oct 2026): 1 request per second, personal non-commercial use,
attribution with a link (the page footer has it); refused requests count against the
limit and can earn a temporary IP block.

**Measured 20 Sep 2026** (30 nm around one home antenna, vs adsb.fi):

| | aircraft with position | fix age median | p90 |
|---|---|---|---|
| adsb.fi | 40 | 0.3 s | 4.6 s |
| local receiver | 16 | 4.4 s | 25.8 s |

**Read that table with the snapshot age in mind** (found Nov 2026, see "Age every
snapshot you hand on"): adsb.fi's `seen_pos` counts from a snapshot that is 0.5-2 s old
on arrival, so its real median age was nearer 1.5 s than 0.3 s — about the same as the
receiver's, not fresher. The conclusion below survives on coverage, and because an age
that is *known* costs almost nothing in straight flight; `mergeFeeds()` now compares
true ages, so a local record wins more often than it did.

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

**The two public feeds cover for each other** (`publicFeed()` in serve.js). A feed
that is down — a timeout, a 5xx, a broken answer — is passed over for `FAILOVER_MS`
(60 s) and the other one asked instead; after that it gets one try per minute with a
2 s wait until it answers again. The waits are sized so that a failed try plus the
other feed's answer fit inside the browser's 5 s: only the poll that discovers the
outage is lost. A **4xx is never failed over** — that is a refusal, the back-off's
business, and it stops every upstream request. Every request, to either feed, goes
through `askUpstream()` and so through the one budget. The answer carries `_via`
(→ `_meta.failover`) because the cache hands it to callers that never saw the
failure; the header then reads `live ok (12 ac) · via adsb.lol (adsb.fi: timeout)`.
Tested in `test/failover.test.js` against two local stand-ins (its own file: the
budget and the back-off are per process).

## The map

Real OpenStreetMap raster tiles, drawn to canvas with `crossOrigin='anonymous'` so the
canvas stays untainted (the `/api/snap` debug path below needs `toBlob`). Web Mercator
inflates ground distance by `1/cos(lat)`: `mapFrame()` works in px per *Mercator* metre
(`scale`) and hands out `ppm(lat)`, px per ground metre — drop the cosine and the rings
will be wrong by ~60% at this latitude. Keep the OSM attribution.

`#mapBox` holds two canvases. `#mapTiles` is the tiles, darkened by a **CSS** filter
(`sky.mapFilter`; a canvas `ctx.filter` costs a full-canvas pass per draw and Safari
has not got it) and redrawn only when the view moves or a tile arrives (`tilesKey`,
`tilesStale`). `#map` on top is everything of ours, about 0.1 ms a frame. A tile that
has not arrived is filled from a coarser one already held. `tileCache` is
least-recently-used, 400 tiles.

Two states, one renderer (`renderMap(frameMs, fresh)`):
- **inset**: you in the middle, the search radius to the edge, drawn once a tick;
- **enlarged** (`mapView.big`, a click on the inset): it covers the sky view, so
  `render()` draws it *instead of* the sky, every animation frame. Drag, wheel, pinch
  and double-click move it (`panMap`, `zoomMap`: `mapView.zoom` multiplies the fitted
  scale, `lat`/`lon` is the centre, null while it follows the observer). The sky view's
  −/+ zoom the map while it is up and the figure between them is the width of ground
  shown (`renderSkyCtl`). `mapView` is not saved: a reload opens on the sky.

### The ground under a crossing

The enlarged map exists for one thing: for each plane, the line on the ground from
which it is seen on the centre of the disc. `engine.js` has the maths —
`bodyEcef(site, key, date)`, the body's centre as a point in space, and
`transitPoint(B, pos, groundH)`, where the line from that point through a plane comes
down at ellipsoidal height `groundH`. `h / tan(elevation)` beyond the plane, away from
the body: 17 km for a jet at 10 km with the target 30° up, 57 km at 10°.

- It is held to the prediction's frame, not derived beside it: after the straight
  line gives a first place, `transitPoint` asks `azElRange()` what that place would
  see (the plane with its share of refraction) against the body with all of it, and
  steps until they agree to 2e-5°. Two or three steps; ~1.6 µs a call.
  `test/ground.test.js` stands an observer on the result and has `predictPlane()`
  report a transit there at that second, within 0.02 R.
- A point, not a direction, for the body: the moon's parallax between two places 50 km
  apart is 0.03 R, and comes out by itself. Between `bodyEcef(now)` and
  `bodyEcef(now + 120 s)` the page interpolates in a straight line (0.0005° off).
- `null` when there is nowhere to stand: the body under 1°, the plane less than 30 m
  above `groundH`, or the line running past `CAST_MAX_M` (400 km) — with the body low
  it never comes down at all, the Earth curves away under it.
- `groundH` is the observer's own height (`site().h`), the only one known. That makes
  the line through the observer's dot exactly the pass the prediction reports
  (`test/app.test.js` checks the two agree in disc radii), and makes every other place
  wrong by its height difference over `tan(el)`. No terrain model: do not add a
  network lookup per point.
- `castTracks()` builds one list per plane on every tick the map is drawn (10 s steps,
  3 s for a turning plane; ~0.03 ms a plane). Between ticks `castFrom()` moves the
  same list on to the frame's moment. They live in `casts`, **not on the plane
  record** — nothing the prediction reads is touched, and the drawing-changes-nothing
  test runs a third page with the map enlarged to hold that.
- The band: the disc's footprint at a point is an ellipse, `angR × range` across the
  line of sight and that over `sin(el)` along it. Its half-width square to the line is
  what is drawn. It means the plane's *centre* is on the disc — the same thing
  `klass === 'transit'` means. Close to an airport a plane is larger than the disc
  and touches it from further out; that is not drawn.
- Enlarged, the spot is labelled with the flight. With the target at 6° a plane 2 km up
  is 19 km from its line and the band is 2-3 km wide (`along` is `across / sin(el)`,
  ten times it): the first person to see that took the lines for flight paths and the
  bands for boxes round them. The name at the line is what says otherwise.
- In the inset, traffic that is `far` gets the bare line only: with forty planes every
  mark on every one buries the two that matter.

What it does not do yet: remember. The lines are the next 90 s of the planes in the
air now, and the corridor on the ground moves with the body, so they are not a map of
where to stand in an hour. That needs the flights kept (position, height, time) and
their lines recomputed for a chosen moment — see "Known limitations".

## Audio

Designed for the last 90 s, when the user is getting behind the camera and then not
looking at the screen. Optional and off-switchable: with `cfg.sound` false,
`checkAlerts()` disarms everything and no audio node is created at all — not merely a
muted gain.

Two layers, deliberately split:

- **`checkAlerts()`, 1 Hz, after `predict()`** decides *who* is counted down.
  Arming is strict (`alertWorthy`: transit, trust high, `delta0 <= 3*angR`,
  `tBest <= ARM_S` = 90 s, the whole prediction window). `delta0` is the uncertainty
  *without* the lead-time growth term: with `delta`, a plane 16 km out with the moon
  at 40 deg read ±5.7 R at 90 s and ±3.1 R at 30 s, so it armed ~25 s ahead whatever
  the horizon (the user asked for 90 s after hearing it start at 30). An early bet
  that drifts is what the call-off is for. Staying armed is loose: up to 1.5 R and
  above the horizon, whatever the trust. That hysteresis is intentional — a
  prediction flickering across 1.0 R or a fix going briefly stale must not chop the
  countdown into pieces. Anything that disarms off track (past 1.5 R or below the
  horizon: drifted, turned, lost) plays the falling CALLED_OFF chime if it had been
  announced and its tone has not played, and is dropped from `alerted`, so a plane
  that comes back gets a fresh HEADS_UP. It is the miss that decides, not `tBest < 0.05` alone: a plane that
  turns back has its closest approach *now*, and an earlier "passed → silent" rule
  dropped exactly those without a sound. Only a pass within 1.5 R disarms silently.
  The rising HEADS_UP chime is retried every tick until audio is unlocked, then
  recorded in `alerted`.
- **`countdownLoop()`, 20 Hz** turns the lead plane (earliest closest approach among
  `armed`) into sound on the AudioContext clock, committing at most `LOOKAHEAD_S`
  (0.12 s) ahead, so a changed prediction is heard within one blip. Blip spacing is
  `beepGap(s) = clamp(s/10, 0.15, 5)` — the cadence says how long is left, and 90 s
  of 2 s blips was a lot to sit through — re-derived on every pass against the
  *last* blip, so the cadence tightens immediately rather than after a stale wait.
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
countdown, a tone and then CALLED_OFF (~5.5 s; the chimes share one level), and
doubles as the gesture that unlocks `AudioContext` —
a cue you only discover is silent during the actual transit window is worthless.

Browsers block `AudioContext` until a user gesture; `ensureAudio()` returns null while
suspended. The header shows "click to enable" until then. It resumes from **any**
state but `running`, not just `suspended`: iOS Safari parks the context in a
non-standard `interrupted` state after the page has been in the background (camera
app, lock screen, a call). An earlier `=== 'suspended'` check left it there, silent
until a reload, while "tap to enable" did nothing. A context that was once started may
resume without a gesture, so the countdown loop and a `visibilitychange` handler bring
it back on their own. Chromium has no `interrupted`; to test, override the instance's
`state` getter to report a real `suspend()` as `interrupted`.

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
dead-reckoned "now"), the tone window and the arming rules — through app.js's
wrappers, so they test engine.js as the page uses it. `test/engine.test.js` requires
engine.js directly for turn-following (and that a straight flight is predicted to the
bit as before); `test/ground.test.js` for the ground under a crossing; `test/failover.test.js` covers the feeds standing in for each other. `test/serve.test.js` covers
the static allowlist, bad requests, `/api/snap`'s guards, `mergeFeeds` and the upstream
cap; `test/api.test.js` the settings endpoint, `/api/state`, `/metrics`, the back-off,
the daily ceiling, gzip and the user agent; `test/watch.test.js` the watcher's pacing
and pass lifecycle against a fake feed and clock (a synthetic plane aimed at the
moon), and settings validation. None of them contacts an aggregator. If you add top-level code to app.js that needs a
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

- **Logic**, synchronous — `test/app.test.js` covers this with a recording fake
  `AudioContext`; in a browser: clear `planes`/`mockWorld`, call `resetCountdown()`, insert
  fake planes `{hex, flight, ghosts: [], trail: [], klass, trust: 'high', pred: {at:
  Date.now(), tBest, tMin, sepMin, delta, delta0, elMin: 10, azMin: 0, tIn: null, tOut: null,
  samples: []}}` and call `checkAlerts()` between mutations. Expected: arm → 784,
  1046.5 (HEADS_UP); `sepMin` 1.2 R → still armed, silent; 2.0 R → 1046.5, 784
  (CALLED_OFF); `tBest = 0` with `sepMin` 40 R (turned back) → CALLED_OFF; back on
  track → HEADS_UP again; plane deleted → CALLED_OFF; `tBest = 0` on the disc →
  disarmed, silent; sound off → disarmed, silent; 1.4 R, `tBest` 95 or `delta0`
  over 3 R → never arms. Do not assign to globals like
  `note` from the console — plain-script function declarations live on `window`.
  Reload afterwards: fake planes have no `lastSeen`, so `dropStalePlanes()` never
  removes them.
- **Timing**, live: run `mock` for a minute and print the logged notes against the
  arm/disarm times. Blips should run 5 s apart, tighten to 0.15 s, give way to one
  tone per pass, and resume for the next plane after the tone ends.

When measuring the fan of ghost tracks, interpolate both curves to the same wall-clock
`T`; comparing nearest 2 s samples invents ~0.8 deg of spread for a straight plane.

## Known limitations / next steps

1. Feed latency is still the error to suspect first. adsb.fi's median fix age is
   ~0.3 s, but its p90 is several seconds. A local receiver is merged in already;
   measured, it was not fresher and heard fewer aircraft (see "Data providers"), so it
   is a backup. Better antenna siting, then the receiver's streaming port, is the path
   if that changes.
2. A turn is followed for 12 s and no further (see "Following a turn"): nothing says
   how long it lasts. Past that, and for turns under 0.3 deg/s, the fading prediction
   lines and the miss trend are still what shows the drift. The model has only met
   synthetic flights; real turns (roll-in, roll-out, wind) will differ.
3. The pass log's timing offset is reported, not applied. Feeding it back into the
   prediction is the obvious next step once a few evenings agree on a number.
4. Field validation has only just started: one evening, one report ("tone ends 3-5 s
   before the plane"), which led to the refraction and geoid fixes above. The pass log
   exists to collect more; nothing has yet confirmed the corrected frame in the field.
   The refraction share is a model assuming standard air.
5. Sun mode has its own warm palette but is still dark, which is right indoors and
   marginal outdoors in bright daylight on a phone. If field-testing says it is not
   readable, the hook is already in place: add a third variant to the `body.sun` CSS
   block and a matching `sky` palette, rather than special-casing colours at the call
   sites.
6. The map's crossing lines are live only (see "The map"). Planning where to stand
   later — near an airport, say — needs the last hour's flights kept and their lines
   recomputed for the moment asked about, because the corridor moves with the target;
   and the runway in use changes with the wind, so even that only holds while the
   traffic pattern does. Heights there come from pressure altitude as often as GNSS,
   and close to the runway 50 m of height is 140 m of ground with the target 20° up.
7. The tone is committed ~0.1 s before it starts and does not follow a prediction
   that shifts while it plays (a new fix mid-tone). Fine for a steady bias; a
   refinement if the log shows late jumps.
