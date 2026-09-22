# Running Plane Transit at home (Raspberry Pi)

Plane Transit is happiest on a small always-on box on your home network, so any phone on
the wifi can open it. A Raspberry Pi is the obvious choice; anything with Linux,
systemd and Node works the same way.

Personal notes about your own box (its address, what else runs there, your CA
fingerprint) belong in a `DEPLOY.local.md` next to this file: `*.local.md` is
gitignored and never deployed.

## What the box needs

| | |
|---|---|
| OS | any Linux with systemd (Raspberry Pi OS is fine) |
| node | 14 or newer at `/usr/bin/node` (`sudo apt install -y nodejs`) |
| ssh | key login from your computer, and **passwordless sudo** (to install the systemd unit) |
| ram | it idles at ~60 MB; the unit caps it at 250 MB |
| ports | **8321** (http) and **8443** (https) |

The scripts talk to the box through an ssh host alias, `pi` by default. Either add one
to `~/.ssh/config`:

```
Host pi
  HostName mypi.local        # or its IP address
  User pi
```

or point the scripts at it with `PLANE_TRANSIT_HOST=mypi.local`. Tip: if your router hands
out addresses by DHCP, use the `.local` name (or reserve the address), or `ssh pi` will
break the day the box moves.

If the box runs the [adsb.im](https://adsb.im/) feeder image, these ports are already
taken: 80 (feeder setup UI), 8080 (ultrafeeder/tar1090), 8081/8082 (piaware), 8754
(fr24), 9999 (dozzle), 30001-32006 (feeds). Plane Transit's defaults don't clash.

## Deploy

```
./deploy/deploy.sh              # rsync + install/refresh systemd unit + restart + verify
./deploy/deploy.sh --status     # what is running there right now
```

It ships the **working tree**, uncommitted changes included (that is deliberate — you
will want to fix something between two passes), and prints the git state so you know
what went out. It installs into `~/plane-transit` on the box. Overrides: `PLANE_TRANSIT_HOST`,
`PLANE_TRANSIT_DIR`, `PLANE_TRANSIT_PORT`, `PLANE_TRANSIT_LOCAL_URL`, `PLANE_TRANSIT_TLS_DIR`,
`PLANE_TRANSIT_TLS_PORT`.

The unit is `deploy/plane-transit.service`, installed to `/etc/systemd/system/` with the
`__PLACEHOLDERS__` substituted. It is enabled, so it survives reboots.

```
ssh pi journalctl -u plane-transit -f          # logs, including the active/idle transitions
ssh pi systemctl restart plane-transit
curl -s http://mypi.local:8321/api/status | jq    # counters, local feed health
```

**A Raspberry Pi on wifi may drop new connections while its wifi sleeps** — `ssh pi`
fails with "No route to host", then works on the second or third try. An already-open
session keeps it awake. Not a Plane Transit problem; just retry.

## Why it costs nothing when you are not using it

There is no polling timer anywhere. The browser asks the server, the server asks the
aggregator, and nothing asks when nobody is watching:

- **Page closed** → no requests at all.
- **Page hidden** (background tab, screen off) for more than 60 s → the browser stops
  asking; the header says `paused — page hidden`. An armed countdown is the exception:
  if a pass is already being counted down, data keeps flowing, because you may have
  switched to the camera app for the last 30 s of it.
- **Target below the horizon** (more than 2° down) → paused; there is nothing to
  photograph. Switch target (moon/sun) and it resumes.
- **Several tabs or devices open at once** → still one upstream request per 2.5 s; they
  share one snapshot (`cached()` in serve.js, with a single in-flight request per key).

`/api/status` shows `active`, `idleFor`, `clientReqs` vs `upstreamReqs` and
`sharedHits`, so you can check the aggregator is genuinely not being hit, and
`upstreamLimited` counts requests refused by the 10-per-10-s cap (normally 0).

One consequence of sharing a snapshot: it can be up to 2.5 s old when a second browser
gets it, and the aggregator's `seen_pos` was measured before that. The server adds the
cache age back on before answering (`_meta.cacheAgeS` shows how much), because the
browser dead-reckons from that timestamp — an unaged fix would quietly shift the plane
by speed × cache age, ~500 m for an airliner.

## The local receiver (addition and backup, never a replacement)

If the box also runs an ADS-B receiver, point `PLANE_TRANSIT_LOCAL_URL` at its tar1090 JSON
— on the adsb.im image that is `http://localhost:8080/data/aircraft.json`, which is
what `deploy.sh` sets by default. Same schema as the public APIs. The server merges it
**per aircraft**:

- the public feed is the base list;
- a local record replaces a public one only when its fix is more than 0.5 s fresher
  (the margin stops the source flip-flopping between polls, which would jitter the
  predicted track);
- local aircraft the public feed does not carry are added;
- a local record missing speed, track or altitude never displaces a complete public
  one (`usable()`);
- if the public feed fails entirely, the response is local-only and the header says
  `local receiver only (N ac) — <error>`. This is the backup case, and it works
  (verified by pointing the upstream at an unreachable host).

**Measured 20 Sep 2026**, 30 nm around one home antenna — worth knowing
before you trust either:

| | aircraft with position | fix age median | p90 |
|---|---|---|---|
| adsb.fi | 40 | 0.3 s | 4.6 s |
| local receiver | 16 | 4.4 s | 25.8 s |

So the public feed was *fresher and wider* than that antenna, and local won an
aircraft only occasionally. Do not expect a receiver to improve timing in normal
conditions; it earns its place when adsb.fi rate-limits, goes down, or lags. A
well-sited antenna may do better — measure yours.

Timing detail: `aircraft.json` is rewritten about once a second and cached here for
0.9 s, so a local fix is 1-2 s old at best. `seen_pos` is corrected by the file's own
age (`data.now`), which is exact because that clock is the same machine's.

### Why not one of the streaming ports?

An adsb.im feeder exposes far better sources than that snapshot file, and they were
measured before settling for it (20 Sep 2026):

| port | protocol | latency |
|---|---|---|
| 30047 | **JSON, one object per position update**, all fields incl. `alt_geom`, `gs`, `track` | 7-32 ms (median 21) after the receiver's own timestamp |
| 30003 | SBS/BaseStation text | real time, but baro altitude only |
| 30002 / 30005 / 30006 | raw AVR / Beast binary | real time, needs a decoder |
| 8080 `/data/aircraft.json` | 1 Hz snapshot — **what we use** | 1-2 s |

So the file is the slowest thing on the box by a wide margin, and switching to 30047
would be maybe 60 lines (persistent socket, line-delimited JSON, reconnect, age-out).
`readsb` also has an on-demand API on port 30152 (`--net-api-port`), unexplored.

**Skipping it is the deliberate choice**, and the reason is coverage, not transport.
Over a 4 minute capture of port 30047 the receiver heard 8 aircraft, **2 of them inside
the 30 nm search radius** — against 16-40 from adsb.fi. What it does hear, it hears
well: median gaps between position messages were 0.5 s (32.6 km, 20° elevation), 0.6 s
(33.6 km, 1.4°) and 0.5-1.1 s for the rest, out to 102 km.

So the arithmetic for a transit candidate, with one browser open:

| path | typical age of the fix the browser uses |
|---|---|
| public, single browser (cache missed) | `seen_pos` 0.3 s + fetch 0.2 s ≈ **0.5 s** |
| local via `aircraft.json` | reception gap ~0.25 s + file 0-1 s + 0.9 s cache ≈ **1.5-2 s** |
| local via port 30047 | reception gap ~0.25 s + 0.02 s ≈ **0.3 s** |

The stream would beat the public path by ~0.2 s (≈40 m of dead reckoning, well under a
disc radius) and only for the two-ish aircraft in range that the antenna hears. That is
not worth a persistent socket, reconnect logic and an age-out table. The snapshot file
stays: it costs nothing and covers the case that actually matters, adsb.fi being down
or rate-limiting.

Revisit if nearby coverage improves — a better-sited antenna would make local the
fresher source for exactly the close, low aircraft that transits are made of. Then port
30047 is the upgrade, and `mergeFeeds()` already does the right thing with fresher
records.

Careful reading the earlier table: the receiver's 4.4 s median `seen_pos` counts
aircraft it had *lost* and whose records were still lingering in `aircraft.json`. Per
aircraft it is currently tracking, it is sub-second.

## HTTPS (for location and screen wake lock)

Browsers only allow geolocation and the screen wake lock in a **secure context**, and
`http://mypi.local:8321` is not one. So the box can also serve
**https://mypi.local:8443**. Use that address on your phone. Plain http stays up for
devices that don't have the certificate installed yet, and it links to the https
address.

```
./deploy/make-cert.sh           # create the CA once, (re)issue + ship the server cert
./deploy/make-cert.sh --info    # CA fingerprint, what it may sign for, expiry dates
```

`make-cert.sh` asks the box for its hostname and LAN address, so it needs no
configuration; `PLANE_TRANSIT_TLS_NAME`, `PLANE_TRANSIT_TLS_SHORT`, `PLANE_TRANSIT_TLS_IP` and
`PLANE_TRANSIT_TLS_SUBNET` override what it finds.

How it is built, and why:

- **A private certificate authority** signs the server certificate. After you install its
  root on a device once, the page opens with no warning at all. That matters for a
  one-hand, camera-up tool; a click-through self-signed certificate would not do.
- **The CA is name-constrained** to the box's names (`mypi.local`, `mypi`) and its /24
  subnet (e.g. `192.168.1.0/24`). An ordinary root certificate on your phone could vouch
  for *any* site, bank included, so a leaked key would be a real problem. This one
  cannot: certificates it signs for `www.google.com`, `evil.local`, `8.8.8.8` or an
  address outside the subnet are rejected with `permitted subtree violation`, and
  `pathlen:0` stops it minting a sub-CA to escape.
- **The CA private key lives only on your computer**, in `~/.plane-transit-ca/`, outside the
  repo. The box — which may run a stack of third-party feeder containers — only ever
  gets the server certificate and that certificate's own key, in
  `~/.config/plane-transit/tls/` (mode 700, key 600). That directory is outside the deploy
  directory on purpose, because `rsync --delete` would wipe anything inside it.
- `serve.js` turns https on by itself when it finds `server.crt` + `server.key` in
  `PLANE_TRANSIT_TLS_DIR`. If they're missing it runs plain http as before.

`make-cert.sh` prints the CA's SHA-256 fingerprint (and `--info` shows it again). Note
it down — in your `DEPLOY.local.md`, say — and compare it on each device before
trusting the certificate.

### Installing the CA on a device (once per device)

Download it on the device from **http://mypi.local:8321/plane-transit-ca.crt**, then:

- **iPhone / iPad** (use Safari for the download):
  1. Allow the configuration profile download.
  2. Settings → *Profile Downloaded* → Install (asks for your passcode).
  3. **Then also** Settings → General → About → **Certificate Trust Settings** → turn on
     *Plane Transit home CA (mypi)*. Without this second step Safari still won't trust it.

  The fingerprint is under Settings → General → VPN & Device Management → the profile →
  More Details.
- **Android**: Settings → Security → Encryption & credentials → Install a certificate →
  **CA certificate**, then pick the downloaded file (menu names vary by vendor). Chrome
  trusts user-installed CAs for websites. If `mypi.local` doesn't resolve on your
  Android version, use the box's IP address, `https://<ip>:8443`; the certificate
  covers it too.
- **macOS**: open the `.crt` → Keychain Access → double-click *Plane Transit home CA* → Trust
  → *When using this certificate: Always Trust*. Safari and Chrome use this. Firefox has
  its own store unless `security.enterprise_roots.enabled` is on.

To undo it, delete the profile / certificate from the device.

### Things that change when you switch to https

- **Settings don't carry over.** They live in `localStorage`, which is per origin
  (scheme + host + port), so `https://…:8443` opens the first-run setup again.
- **Use my location** now works. It asks for GPS and reports the accuracy it got, and
  warns when the fix is worse than ±50 m (every ~200 m is about a second of timing).
  It takes only latitude and longitude — phone altitudes are tens of metres off — and
  ground height comes from terrain data as before.
- **Wake lock** works, so the screen stays on through a countdown.

### Renewal

The server certificate is valid for 825 days (Apple's maximum); `--info` shows when it
expires. Run `./deploy/make-cert.sh` any time before then. It re-uses the same CA, so
devices need nothing. The CA itself is valid for 10 years.

If the box gets a new address inside the same /24, just run `make-cert.sh` again: the
CA allows the whole subnet. A move to a different subnet needs a new CA, which means
removing the old CA from devices and installing the new one: delete `~/.plane-transit-ca/`
and run it again. The `.local` name is unaffected by any of this, which is why it is
the address to use.

## Checklist after changing prediction/audio code

1. `node --test test/*.test.js`
2. `./deploy/deploy.sh`
3. `curl -s http://mypi.local:8321/api/status | jq '.active, .local'`
4. Open the page, confirm the header shows `live ok (N ac)`, then hide the tab for a
   minute and confirm it flips to `paused — page hidden`.
5. `ssh pi journalctl -u plane-transit -n 20` — expect an `active` line when you opened it
   and an `idle` line about 20 s after you closed it.
