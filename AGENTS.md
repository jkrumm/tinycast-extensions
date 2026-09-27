# tinycast-extensions

Personal Tinycast extension — one Raycast-format extension (`extension/`,
manifest name `jkrumm`) covering TickTick tasks, Claude usage, and a Netgear
Nighthawk M2 mobile router. **MacBook-only**: Tinycast and the router's LAN
(`192.168.1.1`) both live there, not on the mini.

Tinycast runs Raycast extensions natively (same `package.json` + `ray build`
output, JS in JavaScriptCore, UI in SwiftUI) — there is no separate SDK, no
dev server, and no hot reload. See `.claude/skills/tinycast/SKILL.md` for the
full runtime reference (what works, what doesn't, sourced against
`tinycast.dev` docs).

## Layout

```
extension/
  package.json          ← manifest: name "jkrumm", 6 commands, 5 preferences
  src/
    my-tasks.tsx         command — TickTick task list
    quick-add.tsx        command — TickTick quick add
    ticktick-menu-bar.tsx command — TickTick menu bar
    claude-usage.tsx      command — Claude quota + spend, Detail view
    claude-usage-menu-bar.tsx command — Claude quota + spend, menu bar (5m interval)
    netgear.tsx           command — Netgear MR2100 status + actions
    ticktick/             feature code: client, types, format, parse, search, create-task
    usage/                feature code: quota (fs read), spend (argo), aggregate (pure), format
    netgear/              feature code: client, transport (curl), types, fixtures, live-smoke
    lib/                  shared: argo.ts (fetch client), preferences.ts (Preferences type)
docs/
  architecture.md         commands → modules → data sources
  netgear-m2.md            verified Netgear API reference
```

Raycast requires command entry files at `src/<command-name>.tsx` — everything
else lives under a feature subdirectory. `lib/` holds only what's genuinely
shared (the argo fetch client): TickTick-only helpers (parsing, search,
formatting) live under `ticktick/`, not `lib/`.

## Build + install loop

```
make install    # bun install --frozen-lockfile
make build      # ray build -e dist -o extension/build
```

Then in Tinycast: **Settings → Extensions → Install → Add from folder** →
`extension/build`. Only `package.json`, the compiled command `.js` files, and
`assets/` are copied — never `node_modules`, never source maps. **There is no
hot reload or dev mode for a folder-imported extension** — re-run `make
build` after every change and re-add the folder. Whether re-adding the same
path updates in place vs. needs a manual uninstall first is unconfirmed;
uninstall-then-add-from-folder always works.

`make check` runs `tsc --noEmit` + eslint + prettier + the vitest suite — green is
the bar. It deliberately skips `ray lint`: that command's owner check calls the
live `raycast.com` API for the `author` and has **no flag to skip it**
(`--relaxed` doesn't), so it fails permanently for an extension that is never
published to the Store. eslint + prettier are everything else it runs.

## Preferences (extension-level)

| Name | Type | Required | Default |
|-|-|-|-|
| `apiToken` | password | yes | — |
| `baseUrl` | textfield | yes | `https://argo.jkrumm.com/api` |
| `defaultProjectId` | textfield | no | — |
| `netgearHost` | textfield | no | `http://192.168.1.1` |
| `netgearPassword` | password | no | — |

## Data sources per feature

- **TickTick** — argo proxy (`{baseUrl}/ticktick/*`), bearer `apiToken`. See
  `.claude/skills/ticktick-api/SKILL.md`.
- **Claude usage (quota)** — `/tmp/claude_sl/usage_api.json`, refreshed via
  `~/.claude/fetch_usage.py` (the same rate-limit-aware fetcher the
  statusline uses) when missing or >5 min stale. **Never calls
  `api.anthropic.com` directly.**
- **Claude usage (spend)** — argo proxy (`{baseUrl}/usage/timeseries`,
  `{baseUrl}/usage/summary`), bearer `apiToken`.
- **Netgear** — the router's own HTTP API at `netgearHost` (default
  `192.168.1.1`), via a `curl` subprocess (`netgear/transport.ts`) rather than
  Tinycast's `fetch` — cookie/redirect/plain-HTTP behaviour there is
  unconfirmed (see `.claude/skills/tinycast/SKILL.md`). See
  `docs/netgear-m2.md`.

## Bun-only, exact pins

Package manager is **Bun only** — `bun install`, `bun.lock` committed. Every
direct dependency in `package.json` is pinned to an **exact version** (no
`^`/`~`); bumping one is a deliberate, reviewed edit, never `bun update` with
no target.

## Safety

**Never trigger a Netgear action (reboot / connect / disconnect / SIM PIN or
PUK entry) from a test, a script, or an agent run against the real device.**
`netgear/live-smoke.ts` is read-only by construction (`getStatus` + `login`
only) and gated on `NETGEAR_LIVE=1`; the mutating actions
(`reboot`/`connect`/`disconnect`/`enterSimPin`/`enterSimPuk`) exist only on
`NetgearClient` and are exercised in tests exclusively against a fake
transport (`netgear/client.test.ts`).

## Menu-bar commands — stable vs. beta

`ticktick-menu-bar` and `claude-usage-menu-bar` need Tinycast's native
menu-bar rendering, which landed in `0.11.4-beta.100` (PR #963) — **stable
0.11.3 ships the JS shims but not the native drawing.** Install
`abue-ammar/tinycast/tinycast@beta` (a separate app, `Tinycast Beta.app`,
bundle id `com.tinycast.app.beta`) to see either menu-bar command render,
until 0.11.4 ships to stable (stable self-updates daily — check first).

## Context

- `.claude/skills/tinycast/SKILL.md` — Tinycast runtime reference (build for
  it, install/update loop, debugging, menu-bar semantics)
- `.claude/skills/raycast-extension/SKILL.md` — Raycast component/hook reference
- `.claude/skills/ticktick-api/SKILL.md` — argo TickTick proxy API reference
- `docs/architecture.md` — commands → modules → data sources
- `docs/netgear-m2.md` — Netgear MR2100 API reference (verified live)
