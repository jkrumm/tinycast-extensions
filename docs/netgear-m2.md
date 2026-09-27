# Netgear Nighthawk M2 (MR2100) — HTTP API reference

Verified live against a real MR2100 at `192.168.1.1` on 2026-09-27
(`GET /api/model.json` in both Guest and Admin roles). Action endpoints
(reboot/connect/disconnect/PIN/PUK) are **documented from the brief, never
executed against the real device** — implemented and unit-tested against a
fake transport only (`extension/src/netgear/client.test.ts`).

## Session and auth

1. `GET {host}/api/model.json` — the very first hit returns an HTTP 302 to
   `/sess_cd_tmp?...`, which sets a session cookie. Following the redirect
   (curl `-L` with a cookie jar, `-c jar -b jar`) lands on the actual JSON
   response. **Verified.**
2. The JSON always includes `session.secToken` (a per-session CSRF-style
   token) and `session.userRole` — `"Guest"` until elevated, `"Admin"` after
   a successful login. **Verified** (both roles observed live).
3. **Login**: `POST {host}/Forms/config`, form-urlencoded body
   `session.password=<pw>&token=<secToken>`, same cookie jar → HTTP 204 on
   success. A subsequent `GET /api/model.json` then shows
   `session.userRole: "Admin"`. **Verified** (204 + role flip observed live).
4. Guest role can read status (`GET /api/model.json`); mutating actions
   require Admin. **Verified** — actions were not attempted, but the device
   only meaningfully differs by `userRole` in the model.

## Actions — from the brief, never executed live

All are `POST {host}/Forms/config`, form-urlencoded, with `token=<secToken>`
plus `ok_redirect=/success.json&err_redirect=/error.json`:

| Action | Fields |
|-|-|
| Reboot | `general.shutdown=Restart` |
| Connect | `wwan.connect=DefaultProfile` |
| Disconnect | `wwan.connect=0` |
| SIM PIN entry | `sim.pin.entry=<pin>` |
| SIM PUK entry | `sim.puk.entry=<puk>&sim.newpin=<pin>` |

Implemented in `NetgearClient` (`extension/src/netgear/client.ts`); exercised
only via `client.test.ts`'s fake transport, which asserts the exact field set
per action. **Never call these against the real device from a test, script,
or agent run.**

## Fields read from `model.json`

| Path | Used for |
|-|-|
| `session.userRole` | Guest/Admin |
| `session.secToken` | CSRF token required on every `POST /Forms/config` |
| `wwan.connection` | raw connection state |
| `wwan.connectionText` | e.g. `"4G+"` |
| `wwan.registerNetworkDisplay` | operator name |
| `wwan.roaming` | roaming flag |
| `wwan.dataUsage.generic.dataTransferred` | bytes this billing cycle → GB |
| `wwanadv.curBand` | e.g. `"LTE B7"` |
| `wwanadv.radioQuality` | signal, 0-100% |
| `wwanadv.rxLevel` / `wwanadv.txLevel` | dBm |
| `power.battChargeLevel` | 0-100% |
| `power.charging` | bool |
| `power.batteryState` | e.g. `"Normal"` |
| `sim.status` | `"Ready"` / `"SIM PIN required"` / etc. |
| `sim.pin.mode`, `sim.pin.retry` | PIN state + retries left |
| `sim.puk.retry` | PUK retries left |
| `router.clientList.count` | connected LAN/WiFi clients, when present |

`extension/src/netgear/fixtures/*.fixture.json` are hand-trimmed to exactly
these fields, with fake values substituted for anything identifying
(operator name, no phone number/IMSI/ICCID/MAC/SSID present at all — they
were dropped, not redacted-in-place, since the parser never reads them).

## Transport

Tinycast's `fetch`/`http` bridge has cookies disabled and unconfirmed
redirect + plain-HTTP/LAN behaviour (`.claude/skills/tinycast/SKILL.md`), so
`extension/src/netgear/transport.ts` shells out to the system `/usr/bin/curl`
instead, behind the `NetgearHttp` port interface:

- `-s -m 8 -L -c <jar> -b <jar>` — silent, 8s timeout, follow redirects,
  persistent cookie jar (`environment.supportPath`).
- The admin password is **never on the curl argv** (visible via `ps`):
  `postForm()`'s `stdinField` option appends `--data-urlencode
  session.password@-` and writes the password to curl's stdin instead.

## Unconfirmed / not attempted

- Whether re-logging in in a fresh session mid-way through a stale cookie
  jar behaves differently from a first login — not tested across restarts.
- Concurrent access (Tinycast + the device's own web UI open at once) —
  not tested.
- Firmware/model differences on a non-MR2100 Nighthawk — this reference is
  MR2100-specific (`general.model` in the fixture).
