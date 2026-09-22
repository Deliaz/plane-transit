# Contributing

Thanks for looking. Plane Transit is small on purpose: plain HTML, one script, one tiny
server, no dependencies and no build step. Contributions that keep it that way are
the easiest to take.

## Getting started

```
node serve.js                 # http://localhost:8321
node --test test/*.test.js    # Node 18+ for the tests; the server itself runs on 14+
```

Pick **mock (demo planes)** under ⚙ → Advanced → data source to get planes aimed at
the moon or sun on demand. Real transits are rare, so this is how nearly everything
gets exercised.

**Read [AGENTS.md](AGENTS.md) before changing `app.js` or `serve.js`.** It is written for
AI agents and humans alike, and it explains the choices that look like bugs but are
deliberate: refraction applied unequally to planes and the target, dead reckoning from
the fix time rather than from now, the sub-second refinement in `predict()`, the audio
hysteresis, the two halves of each colour theme.

## Ground rules

- **Sun safety is not negotiable.** Keep the sun-mode warning banner and the
  filter-confirmation dialog, and never make sun mode the default.
- **No dependencies, no build step.** Vendored files are fine when they are small and
  carry their license (`astronomy.browser.min.js` is the example).
- **`serve.js` runs on Node 14.** No global `fetch` there, no syntax newer than Node 14
  understands. CI checks it.
- **Nothing polls on a timer.** The page asks, the server fetches. See "Nothing polls
  on a timer" in AGENTS.md before touching fetching.
- A file the page loads must be added to `STATIC` in `serve.js`, which serves nothing
  else.
- Match the surrounding code: SI units internally, degrees for angles, comments that
  say *why*.

## Pull requests

- Run the tests, and add one when you change the maths: `test/app.test.js` shows how
  to call `app.js` functions without a browser.
- Say how you checked the change in the browser — mock mode, a real pass, a screenshot.
- For anything that changes prediction or timing, say what you expect it to move and
  by how much. Field results are the best evidence there is.

## Field reports

The most useful thing you can send is a real pass. Turn the sound cue on, press
**Space** the moment the plane is on the disc, and copy the pass log rows (they are
also printed to the browser console as `[pass]`). A few rows are enough to tell a feed
delay from a height or position error; AGENTS.md, "Pass log", explains how to read
them. Please leave your own coordinates out of the report.
