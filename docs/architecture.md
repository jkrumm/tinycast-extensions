# Architecture

One Tinycast/Raycast extension (`extension/`, manifest name `jkrumm`), eleven
commands across six features that share the argo proxy (TickTick, Claude
usage) and the secrets chain (TickTick, Netgear, Victron) where useful.

## Commands → modules → data sources

| Command | Mode | Entry | Feature modules | Data source |
|-|-|-|-|-|
| `my-tasks` | view | `src/my-tasks.tsx` | `ticktick/{client,types,format,search,create-task}.ts(x)` | argo `/ticktick/*` |
| `quick-add` | view | `src/quick-add.tsx` | `ticktick/{client,types,format,parse}.ts` | argo `/ticktick/*` |
| `ticktick-menu-bar` | menu-bar | `src/ticktick-menu-bar.tsx` | `ticktick/{client,types,format}.ts` | argo `/ticktick/*` |
| `claude-usage` | view | `src/claude-usage.tsx` | `usage/{quota,spend,aggregate,format,heroes,types}.ts`, `lib/svg.ts` | `/tmp/claude_sl/usage_api.json` + argo `/usage/*` |
| `claude-usage-menu-bar` | menu-bar, `interval: 5m` | `src/claude-usage-menu-bar.tsx` | `usage/{quota,spend,aggregate,format,types}.ts` | same as above |
| `netgear` | view | `src/netgear.tsx` | `netgear/{client,transport,types,session,flows,pin-store,wifi,status-view,action-lock,internet-probe,apn-model,signal,signal-view,ping}.ts`, sub-views `netgear/{sim-forms,apn,sms,devices,watchdog-view,signal-meter}.tsx` (test/dev only: `netgear/fake-router.ts`), `lib/svg.ts` | Netgear MR2100 HTTP API (`netgearHost` pref) |
| `netgear-watchdog` | no-view, `interval: 1m` | `src/netgear-watchdog.tsx` | `netgear/{watchdog,watchdog-storage,internet-probe,action-lock,session}.ts` | same Netgear HTTP API + `curl` captive-portal probe + `LocalStorage` |
| `battery` | view | `src/battery.tsx` | `battery/{collect,parse,heroes,types}.ts`, `lib/svg.ts` | `batt status --json` + `ioreg -rn AppleSmartBattery` |
| `speed-test` | view | `src/speed-test.tsx` | `speed-test/{run,parse,heroes,types}.ts`, `lib/svg.ts` | `/usr/bin/networkQuality` + `LocalStorage` history |
| `van-power` | view | `src/van-power.tsx` | `van/{run,load,parse,history,victron-history,format,heroes,storage,types}.ts`, `lib/svg.ts` | `assets/van-ble` (Swift BLE helper: Ective BMS notify + Victron Instant Readout advert) + `LocalStorage` 72 h history |
| `hub` | view | `src/hub.tsx` | reads every feature module above, one tile each | all of the above, loaded independently per tile |

Shared: `lib/argo.ts` (bearer-authed fetch client, `prefs()`, `useAuthHeaders()`),
`lib/secrets.ts` (override → Keychain → 1Password resolution chain, pure),
`lib/svg.ts` + `lib/chart/` (chart/hero/tile SVG library, pure — see the svg-charts skill), `lib/preferences.ts` (the
`Preferences` interface, matches `package.json`'s `preferences` array).

## Data flow

```
TickTick commands
  └─ ticktick/client.ts
       └─ lib/argo.ts (argoFetch, bearer from prefs().apiToken)
            └─ {baseUrl}/ticktick/*

Claude usage commands
  ├─ usage/quota.ts
  │    └─ fs.readFile(/tmp/claude_sl/usage_api.json)
  │         └─ (if missing/stale) execFile ~/.claude/fetch_usage.py, re-read
  └─ usage/spend.ts
       └─ lib/argo.ts (argoFetch, bearer from prefs().apiToken)
            └─ {baseUrl}/usage/timeseries, {baseUrl}/usage/summary
       └─ usage/aggregate.ts (pure: today = last UTC-day bucket, 7d = sum)

Netgear command
  └─ netgear/client.ts (NetgearClient)
       └─ netgear/transport.ts (CurlNetgearHttp — NetgearHttp port)
            └─ /usr/bin/curl (cookie jar under environment.supportPath)
                 └─ {netgearHost}/api/model.json, {netgearHost}/Forms/config

Battery command
  └─ battery/collect.ts
       ├─ execFile batt status --json
       ├─ execFile ioreg -rn AppleSmartBattery → battery/parse.ts (regex, not plutil)
       └─ fs.readFile ~/.config/batt/pause-until
       (limit changes: execFile /bin/bash ~/SourceRoot/dotfiles/launcher/battery-limit.sh)

Speed Test command
  └─ speed-test/run.ts
       └─ execFile /usr/bin/networkQuality -c [-M 4 -u]
            └─ speed-test/parse.ts (pure) → LocalStorage history (last 20)

Van Power command
  └─ van/load.ts → van/run.ts
       ├─ lib/secrets.ts getSecret("victronKey")   (missing key ≠ failure)
       ├─ spawn assets/van-ble (key on stdin) — CoreBluetooth, ≤10 s scan, 15 s deadline
       │    ├─ Ective BMS: connect FFE0/FFE4, reassemble + CRC a 113-byte frame
       │    └─ Victron: manufacturer-data advert, AES-128-CTR decrypt
       ├─ van/parse.ts (pure) → reading → sample
       └─ van/history.ts (pure) + van/storage.ts → LocalStorage `van-history` (72 h)
  (hub tile reads the last stored sample only; no background command)

Victron on-device history (`runVictronHistory()`, API only — not wired into a command yet)
  └─ van/run.ts → spawn assets/van-ble --victron-history (no key, no stdin)
       ├─ CoreBluetooth: find the Victron (0x02E1 advert), connect, notify on
       │    Control/LastData/Data, init + keep-alive, GET 0x104F then 0x1050…
       │    (one per day, ≤ days available) — write allowlist in main.swift, read-only
       └─ van/victron-history.ts (pure) → total + days[] (date, yield, V/A/W extremes,
            bulk/absorption/float minutes, errors)

Every command's secret (TickTick/usage bearer token, Netgear admin password, Victron key)
  └─ lib/secrets.ts: resolveSecret()/getSecret()
       ├─ preference override, if set
       ├─ security find-generic-password -s tinycast-extensions -a <key>
       └─ op read <ref> --account tkrumm  (caches the result into Keychain)
```

## Why curl for Netgear, argoFetch for everything else

`argoFetch` (TickTick + usage spend) talks to `argo.jkrumm.com` over HTTPS —
plain `fetch` is fine there. The Netgear MR2100 is plain-HTTP LAN with
cookie-based session auth; Tinycast's `fetch` bridge has cookies disabled and
unconfirmed redirect/plain-HTTP behaviour (`.claude/skills/tinycast/SKILL.md`).
`netgear/transport.ts` shells out to the system `curl` instead, behind the
`NetgearHttp` port interface so `netgear/client.ts`'s parsing and
form-building logic stays unit-testable against a fake transport
(`netgear/client.test.ts`) without ever touching a real socket or curl binary.

## Why `usage/aggregate.ts` is split from `usage/spend.ts`

`@raycast/api` ships types only — no runtime module — so anything importing
it (even transitively through `lib/argo.ts`) fails to resolve under vitest.
`usage/aggregate.ts` holds the pure `aggregateSpend()` logic with zero
`@raycast/api` dependency so it can be unit-tested directly; `usage/spend.ts`
re-exports it alongside the two argo-backed fetchers used at runtime.

## Why `lib/secrets.ts` never imports `@raycast/api`

Same constraint as above, applied to `getPreferenceValues`: `lib/secrets.ts`
takes preferences and a `SecretRunner` as plain arguments instead of reading
`getPreferenceValues()` itself, so it stays fully unit-testable (a fake
runner stands in for `security`/`op`) and callers (`lib/argo.ts`,
`netgear.tsx`) are the only places that touch `@raycast/api`.

## Metadata: dropped in favour of full-width hero images

Every Detail command (`claude-usage`, `netgear`, `battery`, `speed-test`,
`van-power`)
renders **no `Detail.Metadata` sidebar**. Two things made that the better
trade once the target channel became Tinycast beta:

- On beta, a plain `Detail`'s markdown pane is the full column width minus
  the sidebar (≈489pt with the 240pt sidebar vs. ≈730pt without, at the
  750-wide `standard` window) — dropping it is a real width gain, not
  cosmetic.
- Beta also renders markdown tables as a real `Grid` (stable 0.11.3 doesn't
  — see `.claude/skills/tinycast/SKILL.md` § Stable 0.11.3 differences), so
  the fields that used to justify a sidebar (state, voltage, SIM, connected
  clients, latency, …) used to sit in a markdown table below the hero images;
  now only the long-tail reference text does. The headline numbers are an SVG
  **status panel** (big numbers with a gauge, `statusPanel()`) plus one
  hairline **metrics row** (`statCards({ size: "compact" })`) in
  `lib/chart/cards.ts` — no filled boxes, since Tinycast's window is
  translucent and grey cards read like form fields — and each number is drawn
  once, so the view scans faster and fits more above the fold.

The numbers a sidebar used to carry that *are* visually prominent (quota %,
radio quality, battery %, download/upload Mbps) live in the hero SVGs
themselves (`lib/svg.ts`, sized to `HERO_COL_WIDTH` — see AGENTS.md § SVG
hero images). `netgear`'s "Connected Devices" and "SMS" sub-views are plain
`Detail`s with a table too, not `List`s, for the same reason.

## Testing boundary

Everything under `ticktick/`, `usage/`, `netgear/`, `battery/`, `speed-test/`,
`van/`, and `lib/` that doesn't import `@raycast/api` is unit-tested with vitest
(`make test`) — parsing, formatting, aggregation, the netgear client against
a fake transport, the secrets chain against a fake runner, and the SVG
toolkit's string output. The eleven command entry files (`src/*.tsx`) are the
untested seam — they wire feature modules into Raycast components and can
only really be exercised inside a built Tinycast install.
