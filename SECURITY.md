# Security

## Reporting a vulnerability

Please report security problems privately, through GitHub's **Report a vulnerability**
button on this repository's Security tab, rather than in a public issue. You should get
an answer within a week.

## What to expect from Plane Transit

`serve.js` is built for a trusted home network:

- It has **no authentication**, and listens on all interfaces by default so phones on
  the same wifi can reach it. Do not expose it to the internet. Set
  `PLANE_TRANSIT_BIND=127.0.0.1` to keep it to one machine.
- It serves only the page's own files, never the rest of the checkout.
- It proxies ADS-B requests to public aggregators, capped at 5 requests per 10 s and
  20,000 a day in total, with the observer position rounded to about 1 km.
- `PUT /api/config` lets any page on the network change the shared location and data
  source (JSON only, so a page on another site cannot send it without a CORS preflight,
  which the server never answers). It cannot switch on always-on polling; that is only
  in the settings file. `PLANE_TRANSIT_CONFIG_READONLY=1` turns saving off.
- `/api/state` and `/metrics` are read-only. They never include the observer's
  position, though the directions to the moon, the sun and nearby aircraft narrow it
  down for anyone who can read them.
- `/api/snap` (a development aid that writes one PNG next to the sources) answers
  only requests from the same machine, only with an `image/png` body, up to 20 MB.

The optional HTTPS setup (`deploy/make-cert.sh`) creates a private certificate
authority that is name-constrained to your server's names and subnet, so even a leaked
CA key cannot impersonate other sites; the key stays on the computer that ran the
script. A weakness in that design — anything that would let the CA vouch for a name
outside its constraints, or move its key onto the server — is exactly the kind of
report we want.

Your position is stored in your browser and in the server's settings file
(`~/.config/plane-transit/settings/config.json` on the machine running it). It is sent,
rounded to ~1 km, to the ADS-B aggregator you choose, and to four decimals (~10 m) to open-meteo.com once when
you set it, to look up the ground height.
