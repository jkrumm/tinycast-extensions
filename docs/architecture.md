# Architecture

One Tinycast/Raycast extension (`extension/`, manifest name `jkrumm`), six
commands across three unrelated features that happen to share the same argo
proxy for two of them.

## Commands → modules → data sources

| Command | Mode | Entry | Feature modules | Data source |
|-|-|-|-|-|
| `my-tasks` | view | `src/my-tasks.tsx` | `ticktick/{client,types,format,search,create-task}.ts(x)` | argo `/ticktick/*` |
| `quick-add` | view | `src/quick-add.tsx` | `ticktick/{client,types,format,parse}.ts` | argo `/ticktick/*` |
| `ticktick-menu-bar` | menu-bar | `src/ticktick-menu-bar.tsx` | `ticktick/{client,types,format}.ts` | argo `/ticktick/*` |
| `claude-usage` | view | `src/claude-usage.tsx` | `usage/{quota,spend,aggregate,format,types}.ts` | `/tmp/claude_sl/usage_api.json` + argo `/usage/*` |
| `claude-usage-menu-bar` | menu-bar, `interval: 5m` | `src/claude-usage-menu-bar.tsx` | `usage/{quota,spend,aggregate,format,types}.ts` | same as above |
| `netgear` | view | `src/netgear.tsx` | `netgear/{client,transport,types}.ts` | Netgear MR2100 HTTP API (`netgearHost` pref) |

Shared: `lib/argo.ts` (bearer-authed fetch client, `prefs()`), `lib/preferences.ts`
(the `Preferences` interface, matches `package.json`'s `preferences` array).

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

## Testing boundary

Everything under `ticktick/`, `usage/`, `netgear/` that doesn't import
`@raycast/api` is unit-tested with vitest (`make test`) — parsing, formatting,
aggregation, and the netgear client against a fake transport. The six command
entry files (`src/*.tsx`) are the untested seam — they wire feature modules
into Raycast components and can only really be exercised inside a built
Tinycast install.
