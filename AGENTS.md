# tinycast-extensions

Personal Tinycast extension — one Raycast-format extension (`extension/`,
manifest name `jkrumm`) covering TickTick tasks, Claude usage, a Netgear
Nighthawk M2 mobile router, MacBook battery, and network speed.
**MacBook-only**: Tinycast, the router's LAN (`192.168.1.1`), `batt`, and
`networkQuality` all live there, not on the mini.

Tinycast runs Raycast extensions natively (same `package.json` + `ray build`
output, JS in JavaScriptCore, UI in SwiftUI) — there is no separate SDK, no
dev server, and no hot reload. **Target install channel is beta**
(`com.tinycast.app.beta`, `0.11.10-beta.x` = upstream `main`) — install
`abue-ammar/tinycast/tinycast@beta`, not stable; native `MenuBarExtra`
rendering and markdown tables-as-grid both need it. See
`.claude/skills/tinycast/SKILL.md` for the full runtime reference (what
works, what doesn't, sourced against `tinycast.dev` docs and, for
render-size/layout facts, directly against Tinycast's `main`-branch Swift
source) and its § Stable 0.11.3 differences if this ever needs reinstalling
there.

## Layout

```
extension/
  package.json          ← manifest: name "jkrumm", 9 commands, 7 preferences
  src/
    my-tasks.tsx         command — TickTick task list
    quick-add.tsx        command — TickTick quick add
    ticktick-menu-bar.tsx command — TickTick menu bar
    claude-usage.tsx      command — Claude quota rings + spend charts, Detail view
    claude-usage-menu-bar.tsx command — Claude quota + spend, menu bar (5m interval)
    netgear.tsx           command — Netgear MR2100 status + actions + sub-views
    battery.tsx            command — MacBook charge/health + charge-limit control
    speed-test.tsx          command — networkQuality speed/latency/data-used + history
    hub.tsx                 command — Grid dashboard, one tile per command
    ticktick/             feature code: client, types, format, parse, search, create-task
    usage/                feature code: quota (fs read), spend (argo), aggregate (pure), format
    netgear/              feature code: client, transport (curl), types, fixtures, live-smoke
    battery/               feature code: collect (batt + ioreg), parse (pure), types
    speed-test/             feature code: run (networkQuality), parse (pure), types, fixtures
    lib/                  shared: argo.ts (fetch client), secrets.ts (Keychain/1Password chain),
                           svg.ts (hero-image toolkit), preferences.ts (Preferences type)
  assets/
    *.png                 command icons — generated, don't hand-edit
    src/*.svg              command icon sources — edit these, then `make icons`
docs/
  architecture.md         commands → modules → data sources
  netgear-m2.md            verified Netgear API reference
```

Raycast requires command entry files at `src/<command-name>.tsx` — everything
else lives under a feature subdirectory. `lib/` holds only what's genuinely
shared (the argo fetch client, the secrets chain, the SVG toolkit):
TickTick-only helpers (parsing, search, formatting) live under `ticktick/`,
not `lib/`.

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

Command icons are generated, never hand-edited: `assets/src/*.svg` (plain hex
colours — these are static PNG assets, not the `data:` SVGs `lib/svg.ts`
builds, so Tinycast's `raycast-*` rewrite never applies to them) → `make
icons` (`rsvg-convert`, 512×512) → `assets/*.png`, wired per-command via
`icon` in `package.json`. A menu-bar command reuses its parent command's
icon (`ticktick-menu-bar` → `tasks.png`, `claude-usage-menu-bar` →
`usage.png`).

## Preferences (extension-level)

| Name | Type | Required | Default |
|-|-|-|-|
| `apiToken` | password | no | — (override; see Secrets) |
| `apiTokenRef` | textfield | yes | `op://common/api/SECRET` |
| `baseUrl` | textfield | yes | `https://argo.jkrumm.com/api` |
| `defaultProjectId` | textfield | no | — |
| `netgearHost` | textfield | no | `http://192.168.1.1` |
| `netgearPassword` | password | no | — (override; see Secrets) |
| `netgearPasswordRef` | textfield | yes | `op://Private/Netgear M2 Jo/Admin Passwort` |

## Secrets

The repo is public, so nothing secret lives in it, and the user shouldn't
have to paste a token into a preference field either. `lib/secrets.ts`
exports `getSecret(key, preferences)` — a resolution chain, pure and
unit-tested (no `@raycast/api` import, same split as `usage/aggregate.ts`):

1. The matching preference override (`apiToken`/`netgearPassword`), if set.
2. macOS Keychain, service `tinycast-extensions`, account = the key name.
3. `/opt/homebrew/bin/op read <ref> --account tkrumm` (biometric prompt) —
   `ref` is `apiTokenRef`/`netgearPasswordRef`. On success, caches into
   Keychain via `security add-generic-password -U` so 1Password is never
   asked again until the entry is cleared or the secret rotates.

All three failing throws `SecretUnavailableError`, whose message names
`make secrets`. `lib/argo.ts`'s `authHeader()` and `netgear.tsx`'s
`requirePasswordOrToast()` both go through this chain — `useAuthHeaders()`
(a small hook in `lib/argo.ts`) exists only because `@raycast/utils`'
`useFetch` takes a plain headers object, not a promise, so the token has to
resolve before the fetch executes (`execute: ready`).

```bash
make secrets        # pre-seed Keychain from 1Password — one biometric pass
make secrets-clear   # drop the cached Keychain entries (forces re-resolution)
```

Run `make secrets` once after `make install` on a fresh machine; after that,
Tinycast never triggers a 1Password prompt.

## Data sources per feature

- **TickTick** — argo proxy (`{baseUrl}/ticktick/*`), bearer token from the
  secrets chain. See `.claude/skills/ticktick-api/SKILL.md`.
- **Claude usage (quota)** — `/tmp/claude_sl/usage_api.json`, refreshed via
  `~/.claude/fetch_usage.py` (the same rate-limit-aware fetcher the
  statusline uses) when missing or >5 min stale. **Never calls
  `api.anthropic.com` directly.**
- **Claude usage (spend)** — argo proxy (`{baseUrl}/usage/timeseries`,
  `{baseUrl}/usage/summary`), bearer token from the secrets chain.
- **Netgear** — the router's own HTTP API at `netgearHost` (default
  `192.168.1.1`), via a `curl` subprocess (`netgear/transport.ts`) rather than
  Tinycast's `fetch` — cookie/redirect/plain-HTTP behaviour there is
  unconfirmed (see `.claude/skills/tinycast/SKILL.md`). See
  `docs/netgear-m2.md`.
- **Battery** — `$(brew --prefix)/opt/batt/bin/batt status --json` (charge,
  limit, rate) + `ioreg -rn AppleSmartBattery` parsed with a targeted regex,
  not `plutil -convert json` — a couple of unrelated huge-integer fields in
  the real device tree make plutil's JSON conversion fail outright
  (`battery/parse.ts`). `~/.config/batt/pause-until` for the auto-reset
  pause state. Limit changes shell out to
  `~/SourceRoot/dotfiles/launcher/battery-limit.sh`.
- **Speed Test** — `/usr/bin/networkQuality` (`speed-test/run.ts`), quick
  (`-c -M 4 -u`, download-only, ~4s/~15MB) or full (`-c`, ~10-20s/~170MB).
  Last 20 results persisted in `LocalStorage`.

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

## SVG hero images and icon previews

`lib/svg.ts` builds every hero/tile image as a plain string (`ringGaugeRow`,
`thresholdBar`, `barChart`, `sparkline`, `batteryGlyph`, `signalBars`,
`menuBarRing`, `tile`), embedded via `toDataUri()` into
markdown/`Grid.Item.content`/`MenuBarExtra`'s `icon` as
`data:image/svg+xml;base64,…`. Colours are always `raycast-*` names
(`RAYCAST_COLOR`), never hex — Tinycast rewrites them to the live theme at
decode time (see `.claude/skills/tinycast/SKILL.md` § Designing for Tinycast
beta). Because of that rewrite, **`rsvg-convert` can't render one of these
SVGs as-is** — preview it by substituting the `raycast-*` tokens for a fixed
dark-theme hex palette first, then converting:

```bash
# substitute raycast-* -> hex, then:
rsvg-convert --background-color='#1e1e1e' <file>.dark.svg -o <file>.png
```

Write previews to `/tmp/tinycast-previews/` when iterating on `lib/svg.ts` or
any hero-image layout — read the PNGs back before calling a chart "done".

**Sizing is `HERO_COL_WIDTH` (680), not a full-window guess.** Every Detail
command drops its `Detail.Metadata` sidebar once the hero images carry the
numbers a sidebar used to (see § Metadata below and `docs/architecture.md`),
so the markdown pane is the full column (~730pt at the 750-wide `standard`
window) — `HERO_COL_WIDTH` is a conservative round number under that.
`toDataUri()` always appends a `?raycast-width=&raycast-height=` hint
matching the SVG's own declared size (Tinycast beta has no 220pt image
height cap, unlike stable 0.11.3 — it draws at intrinsic/hinted size,
never upscaling). `computeImageScale`/`assertLegible` plus svg.test.ts's
"Hero image legibility" block enforce ≥11pt text (≥20pt for the one
headline number, tagged `role: "primary"` in `text()`) at that column
width for every production hero — run it after any layout change.

## Metadata: dropped in favour of full-width heroes

`claude-usage`, `netgear`, `battery`, and `speed-test` render **no
`Detail.Metadata` sidebar** — every number a sidebar used to hold now lives
either in a hero image (quota %, radio quality, battery %, download/upload
Mbps) or in a plain markdown table for the rest (state, voltage, SIM,
connected clients, latency, …), using Tinycast beta's real `Grid` table
rendering (stable 0.11.3 renders a table as plain text — see the skill's §
Stable 0.11.3 differences). `netgear`'s "Connected Devices" and "SMS"
sub-views are plain `Detail`s with a table too, not `List`s, for the same
reason.

## Menu-bar commands — beta only

`ticktick-menu-bar` and `claude-usage-menu-bar` need Tinycast's native
menu-bar rendering (`NSStatusItem`), which landed in `0.11.4-beta.100`
(PR #963) — **stable 0.11.3 ships the JS shims but not the native drawing,
so both commands are invisible there.** This repo's target channel is
already beta (`com.tinycast.app.beta`) for exactly this reason — see the
top of this file. `claude-usage-menu-bar` uses `lib/svg.ts`'s
`menuBarRing()` for a live, no-text ring icon (18×18pt, nothing reads at
that size) and keeps its status-item `title` to just the 5h percent, since
a native title now costs real menu-bar space next to every other app's.

## Adding a command

1. `extension/src/<name>.tsx` (entry file name = command `name`) + feature code
   in `extension/src/<feature>/`; keep parsing/formatting pure and unit-tested
   (anything importing `@raycast/api` can't run under vitest).
2. `package.json` → `commands[]` with its own `icon`: add
   `assets/src/<icon>.svg` in the family style (512², rounded square, one colour,
   white glyph), then `make icons`.
3. Dashboard: add a `TILES` entry + status loader in `src/hub.tsx` (tiles are
   16:9, icon left, one short status line — keep it under ~18 characters).
4. Heroes: build SVGs with `src/lib/svg.ts`, add them to the legibility test,
   render previews to `/tmp/tinycast-previews/` and look at them.
5. Secrets only via `src/lib/secrets.ts` (new key → a `*Ref` preference with an
   `op://` default, `make secrets` entry). Nothing secret or identifying in
   code, fixtures or docs — the repo is public.
6. `make check && make build`, re-add `extension/build` in Tinycast, try it.
7. Launcher access lives in **dotfiles**, not here: add an alias + favorite for
   `extension:jkrumm/<name>` to `config/tinycast/defaults.json`, then
   `make tinycast-apply` (restarts Tinycast) and commit there.

When a Tinycast fact is unclear, read the source rather than guessing:
`gh api repos/abue-ammar/tinycast/contents/<path>?ref=main` (renderer lives
under `Tinycast/Features/Extensions/`), and record what you learn in the
tinycast skill.

## Context

- `.claude/skills/tinycast/SKILL.md` — Tinycast runtime reference (build for
  it, install/update loop, debugging, menu-bar semantics)
- `.claude/skills/raycast-extension/SKILL.md` — Raycast component/hook reference
- `.claude/skills/ticktick-api/SKILL.md` — argo TickTick proxy API reference
- `docs/architecture.md` — commands → modules → data sources
- `docs/netgear-m2.md` — Netgear MR2100 API reference (verified live)
