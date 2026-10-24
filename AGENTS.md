# tinycast-extensions

Personal Tinycast extension — one Raycast-format extension (`extension/`,
manifest name `jkrumm`) covering TickTick tasks, Claude usage, a Netgear
Nighthawk M2 mobile router, MacBook battery, network speed, and a camper
van's BLE power system (Ective battery + Victron solar).
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
  package.json          ← manifest: name "jkrumm", 13 commands, 9 preferences
  src/
    my-tasks.tsx         command — TickTick task list
    quick-add.tsx        command — TickTick quick add
    ticktick-menu-bar.tsx command — TickTick menu bar
    claude-usage.tsx      command — Claude usage Detail: working account, pool + per-account weekly pace, lane routing, spend
    claude-usage-menu-bar.tsx command — Claude working account + status mark, accounts, routing, spend; menu bar (2m interval)
    netgear.tsx           command — Netgear MR2100 status + actions + sub-views
    battery.tsx            command — MacBook charge/health + charge-limit control
    speed-test.tsx          command — networkQuality speed/latency/data-used + history
    van-power.tsx           command — Van Power: Ective battery + Victron solar over BLE, 72 h charts
    shortcuts.tsx           command — List of every global hotkey, launcher alias and favorite (Enter launches it), read live from Tinycast's defaults
    hub.tsx                 command — Grid dashboard, one tile per command
    ticktick/             feature code: client, types, format, parse, search, create-task
    usage/                feature code: quota (argo + local picker + fs read), local (spawns `claude-account`,
                           the only impure routing bit), routing + routing-text (pure: eligibility, merge,
                           divergence, lane/machine tables), summary (pure: THE reading every surface
                           uses — working account, weighted pool, pace, severity, title, lane groups),
                           heroes (capacity panel + metrics row, spend charts), spend (argo),
                           aggregate (pure), format
    netgear/              feature code: client, transport (curl), types, fixtures, live-smoke,
                           pin-store, flows (incl. ensureRouterReachable self-heal), wifi
                           (rejoiner), wifi-creds-store (persisted router Wi-Fi creds), errors
                           (friendly error text), live-actions, session (getClient/getPassword/
                           withAdmin, shared with the watchdog), watchdog (pure tick logic,
                           budget + Wi-Fi rejoin rule), watchdog-runner (one tick, injected
                           ports; run by `scripts/netgear-watchdog.ts`), watchdog-schedule (pure: log
                           policy), watchdog-storage (pure fs: `state.json` + `paused` flag +
                           `reboot-marker.json` in `~/.local/state/netgear-watchdog/`), adapters
                           (raycast-free pin/Wi-Fi stores), status-view (pure markdown),
                           internet-probe, log-view (Show Netgear Log), signal (pure: LTE rating +
                           ping summary parser), signal-view (pure: session history + Signal
                           Meter markdown), ping (execFile glue), signal-meter (live Detail),
                           apn (APN list + shared
                           add/edit/duplicate form), apn-model (pure: badges, validation, form
                           → client input, created-profile lookup), fake-router (in-process M2
                           fake for tests and click-testing), test-helpers (shared
                           flows/watchdog test fakes)
    battery/               feature code: collect (batt + ioreg), parse (pure), types
    speed-test/             feature code: run (networkQuality), parse (pure), types, fixtures
    shortcuts/              feature code: load (defaults export + app scan + manifest + keyboard layout +
                           launch, the impure bit), parse (pure: plist XML → hotkeys/aliases/favorites/
                           Hyper Key settings, binding JSON), format (pure: Hyper chord, key labels per
                           layout, free Hyper letters, `shortcutSections` for the List, markdown), fixtures
    van/                  feature code: run (spawns the BLE helper, the only impure bit), load
                           (read → sample → history), parse (pure: Ective frame, Victron readout),
                           history (pure 72 h ring, ETA, history throttle), sun (pure NOAA sunrise/sunset,
                           location parsing), format (pure, incl. battery warnings), storage (file store
                           `van-history`), victron-history (pure: the Victron's on-device 30-day
                           history registers → days/total; `runVictronHistory()` is in run.ts),
                           victron-trends (pure: stored-trend replies → 72 h series;
                           `runVictronTrends()` is in run.ts), consumption (pure: Ah consumed /
                           charged per local day + quality), sampler (pure: pause state, result
                           classification, low-battery alert state machine, subtitle/status words),
                           sampler-runner (one run), sampler-storage (file-backed `sampler.json` + `paused` flag, via `store.ts`),
                           notify (osascript notification), types, fixtures
    apple-llm/            feature code: run (spawns the helper, the only impure bit), parse (pure)
    lib/                  shared: argo.ts (fetch client), secrets.ts (Keychain/1Password chain),
                           action-log.ts (persistent log file), svg.ts + chart/ (hero/chart library, see svg-charts skill), preferences.ts (Preferences type),
                           action-log.ts (persistent log file, pure fs)
  helpers/
    van-ble/main.swift    Swift BLE helper (CoreBluetooth + CommonCrypto, no deps) → assets/van-ble
    apple-llm/main.swift  Swift CLI over the on-device Apple model (FoundationModels) → assets/apple-llm
  scripts/
    fake-router.ts        `make fake-router` entry — starts the fake M2 on 127.0.0.1:8188
    chart-previews.ts     `make previews` entry — renders every hero + chart gallery to PNGs
    coresvg-render.swift   renders an SVG through macOS' own decoder (previews `--coresvg`)
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

```
make helper     # swiftc extension/helpers/van-ble/main.swift → extension/assets/van-ble, then --selftest
make deploy     # build + copy into Tinycast Beta's installed extension
make watchdog-setup   # MacBook: render + load the 60 s netgear-watchdog LaunchAgent (jobrun-wrapped); -status / -teardown
```

`make build` depends on `make helper` (the compiled `assets/van-ble` is gitignored
and ships in `assets/` like any other asset, executable bit preserved by
`rsync -a`), and `make check` runs it first so the Swift file's crypto/framing
selftest is part of green.

**Every change ends with `make deploy`** — agents run it themselves, the user
never re-adds anything. "Add from folder" (Settings → Extensions → Install) is
only for the very first install: it copies `package.json`, the built command
`.js` and `assets/` (never `node_modules`, never source maps) into
`~/Library/Application Support/com.tinycast.app.beta/extensions/jkrumm/`, and
**re-adding the folder does not replace that copy** (verified 2026-09-27: the
installed `hub.js` stayed stale). `make deploy` rsyncs `extension/build/` there
itself — including `build/node_modules/`: since `@raycast/api` 2.x, `ray build`
moves dependencies shared by several commands (`@raycast/utils`, `d3-*`,
`chrono-node`, …) there and the command files `require()` them; Tinycast loads
them from 0.11.19-beta.117 (`126c998`), so that is the floor; Tinycast reads a command's JS on every run, so the next open shows the
change. The **command list** is different: Tinycast scans manifests only at
launch (`ExtensionManager.refresh()`), so a new/renamed command stays invisible
until a restart — `make deploy` restarts Tinycast Beta itself whenever the
deployed `package.json` changed. Verify with `shasum` of the installed vs built `.js` if in doubt, or
run `make status` — it prints that same deployed-vs-built check alongside
background command metadata and the netgear-watchdog log (see § Debugging in
the tinycast skill). There is no hot reload or dev mode.

`make van-sampler-check` judges the latest `van-sampler` run (the store's `sampler.json` + `paused` flag + the `background` lines in `van-log.jsonl`); `ARGS="--wait 2"` blocks for the next two runs and exits non-zero on a failure or an overdue run.

`make tinycast-version` prints the installed Tinycast Beta vs the latest upstream release and the runtime commits since the skill was last verified (recipe: tinycast skill § Checking upstream).

`make previews` renders the chart gallery and every production hero (see § SVG hero images).

`make check` runs `tsc --noEmit` + eslint + prettier + the vitest suite + the
e2e render harness (`make e2e`, below) + the helper's `--selftest` — green is the bar. It deliberately
skips `ray lint`: that command's owner check calls the live `raycast.com` API
for the `author` and has **no flag to skip it** (`--relaxed` doesn't), so it
fails permanently for an extension that is never published to the Store.
eslint + prettier are everything else it runs.

### End-to-end render harness

Unit tests exercise pure logic; nothing mounted a command's actual React tree
until now. `make e2e` does: it renders every Detail/List/Grid command's real
component with `react-test-renderer` (no jsdom — see `src/e2e/render.ts`'s
header comment for why that's enough for React 19 here) against a fake
`@raycast/api`/`@raycast/utils` (`src/e2e/raycast-fake.tsx`,
`src/e2e/raycast-utils-fake.tsx`, aliased in by `vitest.e2e.config.ts`), with
each command's own data loaders mocked to a fixture. This is exactly the class
of bug a unit test can't see: `speed-test.tsx`'s null-record crash (see the
speed-test crash notes in `src/speed-test/parse.ts`) would have failed
`src/e2e/speed-test.e2e.test.tsx` on the spot. Fixture suites live at
`src/e2e/<command>.e2e.test.tsx`; assertions check for real content and use
`assertNoBadSubstrings()` to catch a `NaN`/`undefined`/`null` leaking into
rendered markdown.

`E2E_LIVE=1 make e2e-live` additionally runs `src/e2e/live.e2e.test.tsx`
(self-skipping without the env var) — the same harness, but against the real
router, `batt`/`ioreg`, the real quota fetcher, and the real argo proxy, for
netgear/battery/claude-usage/shortcuts/hub; speed-test renders whatever's already in
(fake, in-memory) history and never runs `networkQuality`. **Strictly
read-only**: netgear reconstructs its own client with a transport whose
`postForm` always throws — `getStatus()` never needs it — so nothing on this
path can mutate the router even by accident, and `lib/secrets`'s `getSecret`
is repointed to a Keychain-only lookup (no 1Password `op read` fallback) so a
live run never risks a biometric-prompt hang. Each command's rendered
markdown is written to `/tmp/tinycast-e2e/<command>.md` for a human to read
afterwards.

**The Swift renderer itself (how Tinycast actually paints this markdown/these
SVGs) is the one layer none of this touches** — `make e2e`/`e2e-live` prove
the React tree renders and the data is sane, not that it looks right on
screen; that's still a manual `make deploy` + open-in-Tinycast check (or
`@verifier` for a screenshot).

### Fake router

`netgear/fake-router.ts` is an in-process `node:http` fake of the M2's web API
for the real `CurlNetgearHttp` transport: the `/api/model.json` →
`/sess_cd_tmp` session-cookie redirect, per-session `secToken` and Guest/Admin
role (Guest hides `profileList`, `profile.default` and the Wi-Fi passphrase),
login via `session.password`, `/Forms/profile` create/update/delete with
`access_control` enforcement (the active profile can't be deleted),
`/Forms/config` connect/disconnect with timed Connecting/Disconnecting
transitions (`wwan.connect=0` while not Connected is rejected, like the real
one), `wwan.autoconnect`, `wwan.profile.default`, reboot (accepts the
`general.shutdown` values in `state.acceptedShutdownValues`, default only
`restart`; anything else gets errno 1 / errdetail `general.shutdown` like the
real router; unreachable for a configurable time, then a Locked SIM, uptime
reset) and `sim.pin.entry`. A wrong token or a
rejected action → 302 to `/error.json` with the real non-JSON body, success →
302 `/success.json`. Built from `fixtures/model-admin.fixture.json`.
`startFakeRouter({ port?, password, delays })` returns `{ url, state,
setConnection(), failNext(path), close() }`; `state` is mutable, so a test sets
`state.autoconnect`, `state.simStatus`, a profile's `accessControl` directly;
`state.ignoreConnect = true` makes connect requests accepted no-ops (a wedged
router — a reboot clears it); `state.acceptedShutdownValues = ["Restart"]` /
`[]` exercises `client.reboot()`'s fallback / both-refused paths.

- **`fake-router.integration.test.ts`** runs in `make check` (real curl against
  a random loopback port): login, profile create → activate by id diff,
  update with/without password, active/locked delete rejection, roaming,
  `flows.reconnect()` from every state incl. rejected-request tolerance,
  reboot + PIN unlock, a watchdog tick, and the watchdog's last-resort reboot
  of a router stuck Disconnected (3 ticks → `general.shutdown=restart` → comes
  back → rejoin, unlock, `recovered`). It asserts the fake's URL is
  loopback and never touches `192.168.1.1`.
- **`make fake-router`** serves it on `127.0.0.1:8188` (password `fake`, SIM PIN
  `1234`). To click-test the mutating flows (APN edit/delete, reconnect,
  restart), set the extension's **Netgear Host** preference to
  `http://127.0.0.1:8188` and **Netgear Password** to `fake`, then reset the
  host preference. **While the preference points there the watchdog targets the
  fake too** (it reads the same preference) — its roaming/connect fixes land on
  the fake, and the real router is not being watched.

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
| `victronKey` | password | no | — (override; see Secrets) |
| `victronKeyRef` | textfield | yes | `op://Private/Solar Camper Victron/Instant Readout Key` |

## Secrets

The repo is public, so nothing secret lives in it, and the user shouldn't
have to paste a token into a preference field either. `lib/secrets.ts`
exports `getSecret(key, preferences)` — a resolution chain, pure and
unit-tested (no `@raycast/api` import, same split as `usage/aggregate.ts`):

1. The matching preference override (`apiToken`/`netgearPassword`/`victronKey`), if set.
2. macOS Keychain, service `tinycast-extensions`, account = the key name.
3. `/opt/homebrew/bin/op read <ref> --account tkrumm` (biometric prompt) —
   `ref` is `apiTokenRef`/`netgearPasswordRef`/`victronKeyRef`. On success, caches into
   Keychain via `security add-generic-password -U` so 1Password is never
   asked again until the entry is cleared or the secret rotates.

`netgear/pin-store.ts`'s `KeychainSimPinStore` uses the same Keychain service
with a per-SIM account instead, `netgear-sim-pin:<iccid>` — no 1Password tier,
since a SIM PIN is only ever set locally (from the "Enter SIM PIN"/"Save PIN"
forms), never seeded from a vault. `netgear-sim-last-iccid` holds the last SIM
seen unlocked (a Locked SIM hides its ICCID) — see `docs/netgear-m2.md`.

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
Tinycast never triggers a 1Password prompt. `victronKey` is the one tolerant
entry: if its 1Password field doesn't exist yet, `make secrets` prints a skip
line and still caches the others, and Van Power shows "Victron key missing —
run make secrets" while still reading the battery.

## Data sources per feature

- **TickTick** — argo proxy (`{baseUrl}/ticktick/*`), bearer token from the
  secrets chain. See `.claude/skills/ticktick-api/SKILL.md`.
- **Claude usage (accounts)** — two Max accounts (`iu` 20x primary, `me` 5x).
  Primary source: Argo `GET /agents/overview` (agent-gateway is loopback-only
  and pushes its overview to Argo ≤10 min) → `latest.quota.accounts`, 5 s
  timeout, mapped in the pure `usage/accounts.ts`; freshness per account =
  min(`updated_at`, `receivedAt`), disabled accounts hidden. Any Argo failure or
  a payload without `quota` falls back to the local path below, shown as
  `iu (local)`. With ≥ 2 accounts every surface reads `usage/summary.ts` (below); with one
  account (legacy local fallback) the old single-quota views stay. The top-level
  quota buckets stay the primary account's.
- **Claude usage (routing view)** — routing is **per machine**, so the views keep
  both sides: the mini's accounts from Argo (above) and this Mac's from
  `claude-account usage --json` plus `claude-account pick --lane <lane> --dry --why`
  for the six lanes (`usage/local.ts`: binary `~/.local/bin/claude-account`, explicit
  `PATH` with `/opt/homebrew/bin` for its `env bun` shebang, 8 s timeout; `--dry`
  neither refreshes the quota cache nor writes a pick-log line, and the extension
  never refreshes anything itself). `usage/routing.ts` merges them per id (fresher
  numbers win, **auth and exhaustion are this Mac's**) into `quota.accounts`, keeps
  both raw sides in `quota.routing = { local, argo, picks }`, restates the picker's
  eligibility (enabled ∧ auth_ok ∧ not exhausted ∧ 5h < 85 ∧ 7d < 90 ∧ sample < 6 h,
  `docs/claude-accounts.md` in dotfiles) so a view can say *why* an account is out, and
  flags where the machines disagree. Argo carries no per-lane picks, so the mini side
  is eligibility only (**proposed Argo field, not shipped:**
  `snapshot.quota.picks = {lane: {picked, reason, stale}}` — once present the Detail can
  show the mini's routing next to this Mac's; until then the views handle its absence).
- **Claude usage (summary + layout)** — `usage/summary.ts` turns merged accounts +
  `routing` into one `UsageSummary`: the **working account** (this Mac's `interactive`
  pick; without the picker, the eligible account with most capacity left, flagged
  "estimated"), the **pool** (weekly use weighted by plan multiple, `max20x`=20,
  `max5x`=5 — a % of a 5x plan is a quarter of a 20x %; equal weights when a plan is
  unknown; `left` in plan units, "6.8x of 25x"), per-account weekly **pace**
  (`limits.ts weeklyPace`), and a **severity** (spill > broken [auth, exhausted,
  sample > 1 h] > low [pool < 15 % left] > ok). Surfaces, one hierarchy:
  menu-bar title `me 9%` = working account + its weekly use, prefix `▾` low,
  `⚠` broken, `⊘ spill` (ring icon = pool use); dropdown = headline line, Accounts
  (weekly + pace + 5h per account, flags), Routing (lanes grouped by account+reason in
  plain words, divergences), Spend submenu; Detail = bold headline, `capacityPanel`
  (pool + one column per account, pace tick, "out Fri 14:00" / "~20% at reset" /
  "not pickable: …"), `capacityMetrics` row (each account's 5h, spend today / 7 days),
  `## Routing` (lane table: work → account → why; machines table), then spend charts;
  hub tile `me · pool 73%`. Model caps (Fable) and extra usage only show in the
  single-account view.
- **Claude usage (local quota fallback)** — `/tmp/claude_sl/usage_api.json`, refreshed via
  `~/.claude/fetch_usage.py` (the same rate-limit-aware fetcher the
  statusline uses) when missing or >5 min stale. **Never calls
  `api.anthropic.com` directly.** Weekly-first (a Max plan's binding limit):
  `usage/limits.ts` reads `seven_day`/`five_hour` and the model-specific
  weekly caps from the fetcher's generic `limits` list (`kind:
  "weekly_scoped"`, labelled by the API — Fable as of 2026-10; never hardcode
  a model, the legacy `seven_day_sonnet` is only a fallback for old files),
  plus the weekly pace (linear projection to the reset, `runsOutAt` when
  ahead). The menu-bar title is the bare weekly percent (`14%`, same as the
  ring; ` · 5h 85%` appended only at ≥ 80 %), refreshed every 2 min (the
  file is refetched when > 100 s old, `uv` capped at 20 s, spend capped at
  25 s — Tinycast keeps the old title if a run is still loading at its 60 s
  deadline); ` (stale)` is appended to the title only when the quota is older
  than 15 min, and the dropdown says when it was fetched. The menu bar fetches
  the **7-day** spend series (~65 KB; the 30-day one the detail view needs is
  ~360 KB, 7–15 s over the mobile router) and a failed spend fetch is one
  dropdown line saying why, never a title marker.
- **Claude usage (spend)** — argo proxy (`{baseUrl}/usage/timeseries`,
  `{baseUrl}/usage/summary`), bearer token from the secrets chain.
- **Netgear** — the router's own HTTP API at `netgearHost` (default
  `192.168.1.1`), via a `curl` subprocess (`netgear/transport.ts`) rather than
  Tinycast's `fetch` — cookie/redirect/plain-HTTP behaviour there is
  unconfirmed (see `.claude/skills/tinycast/SKILL.md`). See
  `docs/netgear-m2.md`. `netgear.tsx` loads a `Stamped<{ status, internet }>`
  (`lib/freshness.ts`) and shows a `freshnessBanner`/`updatingLine` instead of
  silently painting stale cached data when the router is unreachable; Wi-Fi
  credentials this Mac has seen from an Admin session are persisted
  (`netgear/wifi-creds-store.ts`) so `flows.ts`'s `ensureRouterReachable()`
  can self-heal — `withAdmin({ selfHeal: true })` runs it before Reconnect,
  Restart & Reconnect, and Enter/Unblock SIM PIN, and a "Rejoin Router Wi-Fi"
  action covers everything else. `netgear/errors.ts`'s `describeNetgearError`
  turns raw curl/router failures into one consistent friendly message
  everywhere, each saying what happened and what to do. **Persistent action
  log**: `console.log` is compiled out of the release app, so
  `lib/action-log.ts` appends one human-readable line per event to
  `netgear.log` in `supportPath` (`~/Library/Application Support/com.tinycast.app.beta/extension-support/jkrumm/`,
  rotates to `netgear.log.1` at 512 KB; logging never throws) —
  `withAdmin` (start / every progress step / ok / failed with raw error +
  stack), `netgear.tsx`'s auto-unlock and Rejoin Wi-Fi, the lock wait, and the
  watchdog's non-routine events and crashes all write to it via
  `session.ts`'s `logNetgear()`. Read it with `make logs`, `make status`
  (last 25 lines), or the **Show Netgear Log** action (cmd+shift+L). The
  action-log/fs code may only import fs functions Tinycast's node shim
  implements — `lib/tinycast-runtime.test.ts` enforces it (named imports only).
  `flows.ts`'s `reconnect()`
  is state-aware (reads the connection first, only disconnects a Connected /
  stuck-Connecting router, and tolerates a "rejected" connect/disconnect when
  the router is already moving the right way). There is **no cross-process action lock** any more: the
  watchdog (launchd) and a manual UI action can touch the router in the same
  second; the tick's own state-aware flows tolerate a "rejected" call and the
  next tick re-reads. The open `netgear.tsx` view is live: it
  re-reads every 10s, probes real internet in parallel with the router read
  (headline `· No internet` when `Connected` but the probe fails), and shows a
  `🔄 Watchdog:` line while a tick runs; fields sit two pairs per table row,
  followed by a Watchdog section (state, drops in the last hour, 6 newest
  events).
  **The watchdog** is a launchd job, `com.jkrumm.netgear-watchdog` (60 s, wrapped
  in dotfiles' `jobrun` so `jobs-grade` sees a stalled one; `make watchdog-setup`
  / `-teardown` / `-status`, MacBook only), running `scripts/netgear-watchdog.ts`
  (one tick, plain bun) with pure logic in `netgear/watchdog.ts`. It is no
  longer a Tinycast background command, so it keeps ticking with a view open
  and is not subject to Tinycast's kill. It keeps the mobile connection up unattended: it
  auto-unlocks a Locked SIM only with an already-saved PIN (the same
  one-automatic-attempt rule `flows.ts`'s `autoUnlockIfPossible` enforces —
  never loosened for the watchdog), connects when Ready but disconnected,
  and reconnects after two consecutive failed internet probes (a captive-
  portal HTTP check, not just `connection === "Connected"`) — the 2nd probe
  runs **in the same tick**, 10s after the 1st fails (`CONFIRM_DELAY_MS`), so
  an outage is acted on at once instead of a tick (~75s) later; a re-probe that
  succeeds is a plain `ok` blip, and a budget too short for the confirm
  (`budgetMs - 18s < 25s`) falls back to counting across ticks. Every
  non-routine event (probe-failed, reconnected, connect-failed, data toggle,
  rebooted, recovered) carries `band=… radio=…% operator=… rat=… rsrp=… rsrq=… sinr=…` from the
  status the tick already read in its log detail (`incidentContext`), to
  correlate carrier-side drops with radio conditions. Reconnects use an
  escalating backoff (`WatchdogState.reconnectStreak`: 2 min after the 1st
  reconnect, 5 min after the 2nd, 10 min from the 3rd; reset by a successful
  probe). It also keeps **data roaming always on**: as Admin with a readable
  `wwan.autoconnect` other than `Always`, it writes `Always`
  (`client.setRoaming(true)`), returns a `roaming-enabled` event ("Data roaming
  re-enabled (was HomeNetwork)") and lets the next tick do the connection
  checks — one write per tick and per 10 minutes
  (`WatchdogState.lastRoamingAttemptAt`, also after a failed write), never on
  an unreadable value. The Netgear view has no roaming toggle, only an
  **Enable Data Roaming** action while it is off. Escalation ladder for a stuck
  router, split by what it reports. **Router not Connected** (`connect-failed`,
  stuck Disconnected — connect accepted, nothing happens, `inactivityCause`
  307): connect → **reboot on the 2nd consecutive `connect-failed` tick**
  (`STUCK_DISCONNECTED_REBOOT_THRESHOLD = 2`), **no data toggle** — it failed
  2/2 live on 2026-10-05 (10:43, 13:35) and only a reboot cleared both, within
  ~3 min. **Router Connected but the internet probe fails**:
  connect/reconnect → data off/on → reboot at 3 (`STUCK_REBOOT_THRESHOLD`; a
  `reconnect-failed` tick also uses 3). `WatchdogState.stuckStreak`
  counts ticks ending in `connect-failed`/`reconnect-failed` (or `probe-failed`
  once `reconnectStreak >= 2`, i.e. reconnects didn't help) and resets on
  `ok`/`connected`/`recovered`. On the **second** stuck tick of the
  Connected-no-internet path (streak 1, SIM
  Ready, `WatchdogState.dataToggledAt` unset) the tick runs `flows.ts`
  `toggleData` instead of its reconnect — `wwan.autoconnect=Never`, wait
  for Disconnected, then **always** `Always` in a `finally` (roaming is never
  left off), wait for Connected, ~9s measured live — emitting `data-toggled`
  ("Mobile data switched off/on to reset the connection") or
  `data-toggle-failed` (breadcrumb `toggling-data`, same `wwan.*` log detail);
  both count as stuck and set `dataToggledAt`, so it runs **once per stuck
  episode** (cleared with the streak). If the next tick is `ok` the streak
  resets; if it is stuck again, the **reboot is the last resort**: at 3 (2 for a `connect-failed` tick), with no reboot in the last 30 min
  (`lastRebootAt`, anyone's, also after a refused attempt), the SIM **Ready**
  (never a Locked/Blocked one — a reboot can't fix that and could re-lock it)
  and no reboot already being recovered from, it sends `client.reboot()`
  fire-and-forget (event `rebooted`, "Router stuck — restarted it (<reason>)";
  the `connect-failed` and `rebooted` events carry `wwan.connection` and the raw
  `wwan.inactivityCause` in their log detail — the stuck-state diagnostic)
  and writes the **reboot marker** `{ at, source: "ui" | "watchdog", iccid }`
  (`WatchdogState.reboot`). While the marker is < 5 min old an unreachable
  router is expected: the tick rejoins the Mac's Wi-Fi at once (bypassing the
  "zero internet" rule and the 5-min backoff; at most once per 30s, else a
  `rebooting` event), then logs in, auto-unlocks with the marker's ICCID as
  `knownIccid` and connects; **Connected + internet probe OK + the router's
  uptime shorter than the time since the reboot** emits `recovered` ("Back
  online after restart") and clears the marker. A marker past 5 min is no
  longer recovered from but kept (cleared on the next healthy tick, or after
  30 min) so the open view can warn. The UI's **Restart & Reconnect** is
  detached from the view's lifetime (Tinycast kills a closed view's JS): confirm
  → `withAdmin` (captures the Wi-Fi creds on login) → send the reboot → write
  the same marker (`recordReboot` in `watchdog-storage.ts`, `source: "ui"`) →
  release the lock → toast "Router restarting — reconnects automatically
  (~2 min)"; the watchdog does the recovery. The live view shows `🔄 Router
  restarting… (m:ss elapsed)` instead of the "Router not reachable" banner
  while the marker is < 5 min old and the router isn't back, and `⚠️ Router did
  not come back after the restart` (Rejoin hint) after that. The UI lock TTL
  is 2 min accordingly. Otherwise it only joins Wi-Fi under
  one narrow rule — router unreachable **and** the Mac has zero internet at
  all **and** creds are known, backed off to once per 5 minutes (never while
  a normal home Wi-Fi with real internet is active). A rejoin only counts as
  `rejoined` if the router answers afterwards (polled ~10s; `networksetup`
  reports a join of an off-air SSID as success) — else `rejoin-failed`. The
  watchdog also reads the router's **battery** from every status
  (`WatchdogState.lastBattery`): `battery-low` (notice only, once per crossing
  at ≤20%/≤10%, 🔋 in the launcher subtitle), `battery-empty` (unreachable +
  last reading ≤10% not charging within 12h: no rejoins except one per 30 min,
  the view's offline banner says so) and `power-restored` once it is back.
  A reachable router with a Ready SIM that is not **registered**
  (`RouterStatus.registered`: `wwan.currentNWserviceType` not
  ""/`LimitedService`/`NoService` and an operator name) is left alone — no
  connect, data toggle or reboot (they cannot help; 2026-10-06 it sat on
  `LimitedService` for an hour): the tick logs `no-service` ("No service" in the
  subtitle, 📵 in the log, collapsed like `idle`, only the first of a streak in
  the file log) and resets the stuck ladder. A restart is tried early, then backed off: the
  first after 5 continuous minutes (`noServiceSince`), the next after 30 min,
  2 h, then every 6 h since the last one (`noServiceRebootCount`,
  `lastNoServiceRebootAt`; reset when it registers again) — 2026-10-07 a
  restart fixed a router camped on a bad cell within a minute, 2026-10-06 it
  did not because there was no coverage at all. The first registered tick logs
  `service-restored` and runs the normal flow. The view shows `# No service`
  with a 📵 warning (Restart & Reconnect becomes the primary action), and
  `reconnect()`/`ensureConnected()` fail fast with "No mobile network … try
  Restart & Reconnect" instead of polling. The Signal Meter headlines "Not
  registered (limited service)". Every tick still runs under a hard, shortened
  budget (`DEFAULT_WATCHDOG_BUDGET_MS`, see `docs/netgear-m2.md` § Watchdog; jobrun
  adds a 90 s deadline) and persists an in-progress breadcrumb (`onAction`) before
  any long action. A closed-lid Mac's dark wakes can still freeze a run
  mid-tick; no code can prevent that. State and a 60-event ring buffer live in
  `~/.local/state/netgear-watchdog/state.json` (daemon-owned) beside the UI-owned
  `paused` flag and `reboot-marker.json` (a Restart the UI sent; the next tick
  applies and deletes it), so the two processes never write the same file;
  `netgear/watchdog-storage.ts` is pure fs. `netgear.tsx` reads it for a status
  row plus **Pause/Resume Watchdog** and **Watchdog Log** actions. The watchdog's
  admin password is Keychain only (`make secrets`; the preference override
  does not reach launchd). The log is the same `netgear.log` (source `watchdog`). The
The
  **Signal Meter** action (cmd+shift+S, `netgear/signal-meter.tsx`) is a live
  Detail for finding the router's best physical spot: every 2 s it reads the
  model (a guest GET, no login — skipped while the previous tick still runs) and
  runs `ping -c 4 -i 0.25 -t 3 1.1.1.1`, then shows an overall verdict
  (`rateSignal`: worst of SINR and RSRP, see `docs/netgear-m2.md` § Signal), a
  SINR/RSRP/RSRQ panel, a SINR trend of the last 60 samples, a table (band,
  cell id, CA secondary cells, tx power, ping, best SINR this session). State is
  session-only; the main view's pair table carries a compact `Signal` row.
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

- **Apple on-device model** — `extension/helpers/apple-llm/main.swift` (built
  by `make helper` into the gitignored `assets/apple-llm`, `--selftest` in
  `make check`): an agnostic CLI over `SystemLanguageModel` (macOS 26+, Apple
  Intelligence enabled; verified live 2026-10-20). One JSON request on stdin
  (`{"mode":"check"}`, `{"mode":"prompt","prompt","instructions?"}`,
  `{"mode":"translate","texts":[…],"to?"}`), ONE JSON line out
  (`{ok, available, reason?, results[], error?}`), exit 0 whatever happens;
  a fresh session per text. `apple-llm/run.ts` spawns it from `assetsPath`;
  the SMS detail's **Translate to English** (cmd+T) is the first user. The
  texts are untrusted: a small model can be talked out of translating
  ("ignore previous instructions…" returned "Hello"), so the original always
  stays on screen next to the translation and the output is only ever shown,
  never acted on. Not yet exposed over HTTP — the CLI is the interface.

- **Shortcuts** — `/usr/bin/defaults export com.tinycast.app.beta -` (an XML plist;
  `plutil -convert json` fails on its `<data>`/`<date>` values, so `shortcuts/parse.ts`
  extracts only `hotkey.<action>` strings, `launcherAliases`, `favoriteApps` and the
  top-level `hyperKeyPhysicalKey`/`hyperKeyIncludesShift`) → read-only, nothing is
  written back. The command is a `List` (searchable by name and key; sections
  Hyper — Apps / Hyper — Commands / Tinycast / Aliases / Favorites, built by the pure
  `shortcutSections`, the component is thin): icon = `{ fileIcon: <.app path> }` for apps,
  the command's own `package.json` `icon` asset for this extension's commands, accessory
  = one tag (`Hyper Y`). Enter launches (`open -b <bundle id>` for apps, `launchCommand`
  for own commands, `load.ts` `launchTarget`); Copy as Markdown and Refresh follow.
  Bindings are JSON strings (`{"combo":{"_0":{"carbonModifiers":6656,"carbonKeyCode":17}}}`);
  **Hyper** is Tinycast's own Hyper Key chord ⌃⌥⌘ (6400, ⌃⌥⇧⌘ with
  `hyperKeyIncludesShift`) when `hyperKeyPhysicalKey` is set and not `none`, else
  Karabiner's ⌃⌥⇧ (6656). A binding with exactly that chord renders `Hyper <Key>`, a
  superset `Hyper ⇧<Key>`; other kinds (`doubleTap`, `globe`, …) by their kind name. Key codes
  are physical US positions; `load.ts` reads `defaults read com.apple.HIToolbox
  AppleCurrentKeyboardLayoutInputSourceID` and `format.ts` swaps Y/Z for German/Swiss/Austrian
  layouts (keycode 6 prints Y, 16 prints Z). App names and paths come from
  one `/bin/sh` scan of every `.app`'s `CFBundleIdentifier` in `/Applications`,
  `/System/Applications` and `~/Applications` (incl. Chrome PWAs) — not `mdfind`,
  Spotlight is off on this Mac; unknown ids show as the id with the `Icon.AppWindow`
  fallback. Command titles/icons come from the installed `package.json` next to
  `assets/`. The hub tile shows the hotkey count only (no app scan).
  The fixture holds only hotkey/alias/favorite keys — the real domain also has AI
  connection and MCP server settings that must never enter this public repo.

- **Van power** — two BLE devices read by one native helper,
  `extension/helpers/van-ble/main.swift` (Foundation + CoreBluetooth +
  CommonCrypto, built by `make helper` into the gitignored
  `extension/assets/van-ble`) and spawned by `van/run.ts` via
  `child_process.spawn(path.join(environment.assetsPath, "van-ble"))`. **In the
  Van Power view, Tinycast Beta is the TCC-responsible process** — it carries
  `NSBluetoothAlwaysUsageDescription` and the user's Bluetooth grant — so that
  helper is a bare binary. The **launchd sampler** (below) runs a *separately
  signed* copy with the usage description embedded (`helpers/van-ble/Info.plist`,
  `-sectcreate __TEXT __info_plist`) as the launchd *program*, so the grant is
  attributed to it and Tinycast need not run — **unproven until
  `make van-sampler-spike` passes on the MacBook**; research, spike and the
  `.app` fallback: `docs/van-sampler-tcc.md`. `--supervise -- <cmd>` (spawn as a
  child, never `exec`) and `--tcc-probe` exist only for that. It is transport +
  AES decrypt only; all field parsing is pure TS in `van/parse.ts`. Contract:
  optional Victron key (32 hex chars) on **stdin** (never argv), scans ≤10 s,
  exits as soon as it has both, prints ONE JSON line
  (`{battery, victron, errors[]}`), exit 0 even when a device is missing
  (`bluetooth-off`/`bluetooth-unauthorized` return promptly), hard 15 s
  deadline. `--selftest` checks AES-CTR against a victron-ble test vector and
  the Ective CRC/reassembly against a syssi frame.
  - **Ective LiFePO4** (Topband BMS v1; verified against
    syssi/esphome-topband-bms, Apache-2.0): advertised name `NWJ…` or service
    `FFE0`; connect, notify on characteristic `FFE4`, no auth, no writes. The
    BMS pushes a 113-byte frame (SOF `0x5E`/`0x83`/`0xB0` + 112 ASCII hex chars
    → 56 bytes, CRC = sum(d[0..53]) big-endian in d[54..55]) in arbitrary
    chunks; the helper reassembles and CRC-checks, then disconnects. **The
    phone app may hold the only connection** — a failed connect surfaces as
    "close the phone app".
  - **Victron SmartSolar** (verified against keshavdv/victron-ble): passive —
    the Instant Readout manufacturer-data advertisement (company `0x02E1`,
    record `0x10`, readout type `0x01` = solar charger), AES-128-CTR with the
    little-endian counter block from the IV, key-check byte = key[0]. Needs the
    per-device Instant Readout key (`victronKey`).
  - **Readings** come from opening Van Power and from the pausable background
    sampler (below); each appends one sample to the file store's `van-history.json`
    (72 h, samples closer than 2 min dedupe) through the one shared
    `readAndPersist(source)` in `van/load.ts`. Charts (SoC; solar W vs battery
    A) draw only with ≥6 samples in the window, otherwise they are omitted
    silently. The hub tile shows the last stored sample and never runs BLE.
  - **Background sampler** (launchd `com.jkrumm.van-sampler`, 15 min, wrapped
    in `jobrun`; `extension/scripts/van-sampler.ts` → `van/sampler-runner.ts`;
    `launchd/com.jkrumm.van-sampler.plist.tmpl`; program = signed `van-ble
    --supervise`, built by `make van-sampler-build`; **gated**: `make
    van-sampler-setup` refuses until `make van-sampler-spike` has passed for the
    installed binary). It moved out of Tinycast (where it ran only with no view
    open and died with the app) and deleted: the `van-sampler` command, its
    manifest entry and the LocalStorage state. State is files in
    `~/.local/state/van-sampler/` (`VAN_SAMPLER_DIR`) shared with the view
    (`van/store.ts`, atomic tmp+rename): `sampler.json` (daemon), `paused`
    (view's flag), `van-history.json` (72 h ring, both append),
    `victron-history.json` (cache, both); the view migrates the old LocalStorage
    keys once on open (`van/legacy.ts`). The capture/trend logs stay in
    Tinycast's support dir (`VAN_SUPPORT_DIR`). The helper path is
    `VAN_BLE_BIN` (set by the plist). Each run is
    the same **live read only** as an open (Ective frame + Victron Instant
    Readout advert via `readVan`; the live read itself never opens the connected
    Victron GATT session — the trends top-up below is a separate step after it),
    persisted exactly like an open — a
    `van-history` sample plus a `van-log.jsonl` capture line with `source:
    "background"` and `estimateReason: "background"` (no Victron read, so no live
    estimate). The Victron key is resolved **Keychain-only**
    (`lib/secrets.ts` `KeychainOnlyRunner`): a missing entry means no solar
    decode until `make secrets`, never a 1Password biometric prompt nobody can
    answer. Nothing found is an outcome, not an error: no sample, no log line,
    launcher subtitle "Van not in range" / "Phone app holds the battery"
    (BMS `battery-connect-failed`) / "Bluetooth off" / "83 % · 12:40" /
    "Paused" (printed on stdout and kept in `sampler.json`; a failed read is
    "Read failed", the run still exits 0 — only a crash is red to `jobrun`).
    **Pause / Resume**: the `paused` flag file plus `sampler.json` `{ lastRunAt,
    lastResult, lastAlert }` (default active; `van/sampler.ts` pure,
    `sampler-storage.ts` glue); Van Power's **Pause / Resume Background Sampling** action flips it and
    one quiet line says "Background sampling every 15 min · last 12:40" or
    "paused" — a paused run returns at once, so pausing for a month costs
    nothing. **Low-battery alert**: a reading at or below 30 % or 15 % posts one
    macOS notification (`van/notify.ts`, `osascript display notification` via
    callback-style `execFile`, never throws: "Van battery 28 % — stop charging
    devices from the van"); a threshold is latched once reported and re-armed
    only after the charge is ≥ 5 points above it (`alertStep`); a reading that
    jumps through both reports the lower. **Trends top-up**: the charge-current
    trend (what the consumption needs) only grows through the connected GATT
    session, so after the live read, when the charger's advert was heard, the
    Ective frame was read (a closed-lid Mac's ~2 s DarkWakes hear only the advert
    and froze 4 of 6 top-ups mid-session) and the
    cache's `updatedAt` is over 3 h old (and was set by a foreground read at
    least once — pairing happens there, never unattended), the run calls the same
    `loadVictronHistory` an open does (`--victron-all --since`, history only if
    `victronHistoryDue`; merge, cache, `van-trends.jsonl` and the `victronRead`
    start/done/failed lines all come with it; ~9–25 s, no new BLE write, the
    helper allowlist untouched). Sampler state adds `lastTrendsAttemptAt` (saved
    *before* the read, so a run killed mid-session still counts: one
    attempt per 3 h, a failure included), `lastTrends { at, outcome: ok | failed
    | pairing, detail }` and `trendsBackoffUntil` (a `victron-pairing-timeout` /
    `-failed` backs off 24 h so the macOS pairing dialog never appears
    unattended). `make van-sampler-check` prints `lastTrends`. The first
    notification may need
    allowing under System Settings → Notifications → Script Editor. Constraints:
    `jobrun --timeout 420` bounds a run (the helper's own 15 s read deadline
    fits; the top-up's guard is 200 s); a view open and the daemon may scan at
    the same time (two writers on the store, last rename wins; the connected
    Victron session is exclusive, so a clash costs one top-up). **Install** (the
    MacBook, logged in): `make van-sampler-spike`, then `make van-sampler-setup`;
    `make van-sampler-status` / `van-sampler-teardown`. The charge chart draws a dot per reading
    only up to 30 readings, then one per 2 h plus the latest.
  - **Victron on-device history** (`van-ble --victron-history`, no stdin/key;
    TS API `runVictronHistory()` in `van/run.ts` → `van/victron-history.ts`,
    wired into Van Power, see below): the charger's own 30 daily records over a
    **connected GATT session** — a different protocol from the advert. Sources:
    patlux/ve-smart-telemetry (decompiled VictronConnect, live-tested) + the
    BlueSolar HEX protocol PDF Rev 18 § History data. Service
    `306b0001-b081-4037-83dc-e59fcc3cdfd0`, chars `…0002` Control, `…0003`
    LastData, `…0004` Data (notify on all three). Sequence: read Control →
    write Control `fa 80 ff`, `f9 80` → LastData `01`, `03 00`, keep-alive
    `06 00 82 18 93 42 10 27` (instance 0, vreg 0x93 = 10 s; repeated every 3 s)
    → `03 01`, `03 03` → ~1 s drain → GET `05 03 81 19 <vreg>` for 0x104F
    (total; byte 18 = days available) and 0x1050 + N for N < days available
    (0x1050 = today). Inbound: Data (0004) chunks concatenate, a LastData
    (0003) chunk ends the frame; the CBOR-ish stream is read for
    `08 <inst> <vreg> 58 22 <34 B>` Value records (acks `07`, instance-0
    keep-alive echoes ignored); after 65 inbound chunks the helper writes
    Control `f9 <n>`. Deadlines: scan ≤10 s, connect 15 s, **60 s for the
    first encrypted access** (the Victron PIN — 1Password "Solar Camper
    Victron" — is entered once in macOS' own passkey dialog; CoreBluetooth has
    no pairing API), then 45 s of reads; the TS side only has a 150 s hang
    guard. Output: `{victronHistory: {totalHex, days: [{vreg, hex}]} | null,
    errors[]}`; errors `victron-not-found`, `victron-connect-failed` (the phone
    app may hold the one connection), `victron-pairing-timeout`,
    `victron-pairing-failed` (e.g. the first run, before pairing completed),
    `victron-service-missing`, `victron-total-unreadable`,
    `victron-reply-timeout`, `victron-history-timeout`, `victron-disconnected`,
    `victron-write-failed`, `victron-unsafe-write-blocked`; diagnostics go to
    stderr. Layout (little-endian, unsigned): day record 34 B — yield u32 ×0.01
    kWh @1, consumed u32 @5 (0xFFFFFFFF = n/a → `null`), batt V max/min u16
    ×0.01 @9/@11, errors u8×4 @14, bulk/absorption/float min u16 @18/20/22,
    max power u32 W @24, max batt A u16 ×0.1 @28, max PV V u16 ×0.01 @30, day
    seq u16 @32; total 34 B (firmware ≥ 1.17; 19 B on 1.16) — errors @2–5, user
    yield u32 @6, system yield u32 @10, PV V max u16 @14, batt V max u16 @16,
    days available u8 @18, batt V min u16 @19. Live-verified 2026-10-05: 30 days.
  - **Victron stored trends** (`van-ble --victron-trends`, same connected
    session and init as the history; TS `runVictronTrends()` in `van/run.ts` →
    `van/victron-trends.ts`; ~15 s for the full 72 h stitch. **`--victron-all`**
    = the daily history AND the trends in one session (one connect/pairing
    check, ~22 s), output `{victronHistory, victronTrendsRaw, errors}`, a failed
    part is null + an error code and the other survives; `runVictronAll()` →
    `{history, trends, errors}`). **Incremental:** `--since <unixMs>` plans
    requests only for samples newer than that instant (minus one step of
    overlap, via the anchor), `--skip-history` drops the daily history
    (`victronHistory: null`); `runVictronAll({sinceMs, history})`, then
    `mergeTrends(cached, fresh, nowMs)` (dedupe by slot — closer than half the
    finer step — finer step wins, tie → fresh, 72 h trim). A 1 h refresh is 22
    pushes ≈ 8.6 s (12.8 s with history) vs 21 s for the full run): the 30-minute samples the
    BLE module keeps for ~45 days. Source: VictronConnect 6.43's shared
    `vregs.json` + `TrendsManager` (static analysis of the official Linux
    AppImage, nothing run), verified live. **`0xEC20` is not trends** (it is the
    BLE-network receive list). GET `0xEC5D` (16 B = 8 × u16 trend vregs; here
    `EC89 EDBB EC8A EC88 ED8D ED8F` = output A, PV V, PV W, batt °C, batt V,
    batt A), `0xEC4A+i` config (byte 0 subtrends, byte 1 max samples per push =
    56 for 8-bit / 28 for 16-bit trends, then u16 sample-count / u16 step pairs:
    (120,1) (239,30) (288,300) (2160,1800)), `0xEC52+i` time refs (4 × u32, the
    newest ref of each subtrend), `0xEC5A` (u32 device clock, +1 per second),
    `0xEC5F` (time tuple, unused). Then per trend the push request, setValues on
    instance 3 `0xEC5B`: `06 03 82 19 ec 5b 46 <trend u8><timeRef u32 LE><n u8>`.
    Reply (a Value record on `0xEC5B`, ~90 ms): `<trend u8><ref u32><n u8><step
    u16><n samples>`, 1 byte (8-bit trends) or 2 bytes each, **newest first**:
    sample i is at `ref − i·step`; the device aligns `ref` up to the step grid
    and picks the subtrend from the timeRef's age. Invalid: `0xFF` (un8), `0x7F`
    (sn8), `0xFFFF`/`0x7FFF`. Scales: V/100, batt A/10, PV W/1. The helper plans
    requests from the config and time refs: per trend subtrends 3, 2, 1, each
    walking back from its newest ref by `maxPush × step` until 72 h before the
    anchor (a trend whose first reply is all "not available" is skipped) and prints raw hex + anchor
    (`{victronTrendsRaw: {anchor, supportedHex, configsHex, timeRefsHex, pushes,
    …} | null, errors[]}`); `victron-trends.ts` decodes it to `{anchor,
    trends: [{vreg, segments, samples: [{t unix ms, v | null}]}]}`. **Clock:**
    the device clock drifts against wall time (its 0xEC5F tuple extrapolates days
    off), so times are anchored to the last `0xEC5A` read paired with the Mac's
    `Date()` at the reply — never the tuple; the clock ticks 1 Hz, so only a
    sub-percent rate error remains. **Cascade:** each subtrend holds what the
    previous one aged out, so subtrend 3 (30 min) ends ~26 h before now;
    subtrend 2 (5 min, 288 samples) covers ~2–26 h ago, subtrend 1 (30 s)
    the last 2 h. `decodeTrends` stitches them: 30 s averaged to 5 min
    (incomplete old buckets dropped), the finest data wins in overlaps, result
    `{vreg, segments: [{stepS, fromMs, toMs, count}], samples}` time-sorted over
    the last 72 h (live: 404 samples, 92 × 1800 s + 312 × 300 s, one 5-minute
    hole at the 3→2 seam). Live-verified 2026-10-05.
  - **How Van Power uses it** (`van-power.tsx`, `van/load.ts`): the cache is
    painted **first**. `loadVictronCache()` reads the file store (`victron-history.json`,
    one key: `{attemptedAt, ok, updatedAt, historyAt, history, trends}`) on the
    first frame — charts and bars appear at once, with one quiet line
    ("Victron data updated 12 min ago · reading Victron…") — and a second
    `useCachedPromise` then runs `loadVictronHistory()` **only after the live read
    finished** (`execute: liveDone`: the connected session blocks the charger's
    advert, so they never overlap; Refresh does the live read at once and is
    refused with a toast while the Victron session runs). **Every open** tops the
    cache up: `runVictronAll({ sinceMs, history })` (`van-ble --victron-all
    --since …`, one ~10–25 s session) fetches only trend samples newer than the
    cache's lagging series, `mergeTrends` (victron-trends.ts) merges them in, and
    the 30-day daily history is skipped unless it is missing, from a previous
    local day or over an hour old (`victronHistoryDue`). The cache keeps just PV
    power and battery voltage at native 5/30-minute resolution (`compactTrends`,
    ~40 KB), trimmed to 72 h. A **partial result is used**, a part a read missed
    keeps its older value, and a failed read keeps the cache, leaves `updatedAt`
    alone and shows at most one muted `Victron history unavailable (…)` line
    (retried on the next open). The first-ever read can take ~2 min behind
    macOS' pairing dialog.
  - **The 3-day headline** (`van/heroes.ts` `chargeChartImage`) is two charts
    stacked in one image (`heroRows`) that share the x axis, a fixed 72 h window,
    weekday labels at the local midnights and the **night shading** from
    `van/sun.ts` (pure NOAA solar-position equations, unit-tested; place
    **estimated, never configured**: latitude 45° N, longitude from the Mac's UTC
    offset — good to about an hour). **Battery %** is on top, in the green
    gradient style (0–100, 20 % low line, min/max/last chips): the line is an
    **estimate** from `van/soc-estimate.ts`, our own Ective readings are bare
    solid dots on it, and the legend says so ("estimated from charge/discharge, ●
    measured"). **Solar W** (the PV-power trend, a dense yellow area) is below.
    The voltage itself only appears in the panel's sub line.
  - **`van/soc-estimate.ts`** (pure, unit-tested) is **coulomb counting
    anchored to the readings** — voltage is *not* converted to a percentage
    (a LiFePO4 curve is flat from ~20 to ~90 % and a published voltage table did
    not fit this pack). It integrates `dSoC/dt = (chargerA(t) − L) / capacity`
    (`capacityAh` from the BMS, 100 when unknown), where `chargerA` is the
    Victron's battery-current trend (0xED8F, ≥ 0 into the pack, 0 while it
    sleeps at night). **The house load L is derived per interval from the energy
    balance between consecutive anchors, never from an instantaneous current**
    (the BMS's current at a reading is a laptop or power bank that happened to be
    on; the first real night — 82 % → 54 % in 8.2 h with the charger asleep —
    was 3.2 A on average while the readings said −4.9 A and −1.2 A):
    `L_i = (∫chargerA dt − ΔSoC · capacity / 100) / Δt`, ≥ 0, used inside that
    interval so the curve hits both anchors by construction. Anchors are every
    reading and the ends of every **confirmed full** (charger voltage ≥ 13.9 V,
    awake — a sleeping charger holds its last voltage — and the current tapered
    below 0.03 C; the stretch is pinned to 100 %, a reading within 2 h wins).
    Intervals under 2 h (two readings minutes apart) or inside one full are
    "unreliable" and borrow the typical load; **before the first / after the last
    anchor the typical load carries on — the median of ALL reliable intervals of
    the last ~3 days, not the nearest one** (a quiet 0.5 A evening predicted
    93.8 % for the next morning where the BMS said 73 %); with no reliable
    interval at all the fallback is the median of the instantaneous (charger −
    BMS) currents, then 0.6 A. A leftover (L clamped at 0, or the
    integration clamped at 0/100) is spread linearly so both anchors are always
    exact; everything is clamped to 0–100. Output `{t, soc, kind:
    "measured"|"estimated"}[]`; no charger trend → only the readings; with no
    trend but ≥ 6 readings the chart is the plain measured line. Free
    integration far from a reading drifts: where it has to clamp at 0 or 100 the
    estimate there is not to be trusted. The cache keeps PV power, battery V and
    A (and PV V when pushed); a cache without the current is read in full once.
    Readings exist only because the command was opened or the background sampler
    ran (never a Victron GATT session in the background). Below the charts, "Solar yield · last 14 days" (daily
    bars, weekday over day number, only the best day labelled, subtle dashed
    average over complete days, 30-day total in the heading), then
    "Consumption · last 14 days" (next bullet).

  - **Daily consumption** (`van/consumption.ts`, pure, unit-tested; chart in
    `van/heroes.ts` `consumptionChartImage`, heading `consumptionSummaryText`):
    Ah the house loads drew per **local day** and Ah the Victron charged in, with
    a quality marker. A day's consumption is ∫ of the load the estimator already
    infers between consecutive anchors (`intervalLoads`), an interval split across
    midnight proportionally; hours outside every reliable interval (before the
    first / after the last anchor, unreliable or full-pinned intervals) use the
    estimator's `typicalLoadA` (the median-of-reliable-intervals fallback,
    refactored out of `estimateSoc`). **The charger trend bounds what is known**
    (regression 2026-10-10: the trend ended 08:46, the sampler kept reading the
    Ective, the pack went 65 → 100 %, and the day came out "measured" with 0 Ah
    charged because `valueAt` past the last sample read as 0 A):
    `coveredSpans`/`spansCover` (soc-estimate.ts) say where the trend has samples
    — one 30-min step of tolerance at its ends, no interior hole over 1 h — and an
    `IntervalLoad` the trend does not fully cover has `covered: false` and is
    never `reliable` (the consumption borrows the typical load there; in
    `estimateSoc` it is drawn as a straight line between the two readings, and
    nothing is extrapolated beyond the trend's ends). `chargedAh` = ∫ charger
    current (5-min steps like `chargeBetween`), **only for a day the trend covers
    for all its elapsed hours**, else `null`. `coverage` = share of the day's
    elapsed hours inside reliable intervals → `quality`: **measured** ≥ 0.8,
    **mixed** ≥ 0.3, else **estimated**; **pending** when the trend ends over 1 h
    before the day does (waiting for Victron data: an open, or the sampler's
    top-up) — faded most, excluded from the averages, noted under the chart; today
    is `partial`. A day with neither a trend sample nor an anchor interval is `null`
    (omitted), and with no charger-current trend at all every day is `null`.
    `dailyConsumption` first **thins the readings to ≥ 2 h apart**
    (`thinCaptures`): the sampler's 15-minute readings would make every interval
    "unreliable". **Accuracy ~±3–5 %** on days with anchors hours apart (the SoC is
    an integer %, ≈ 0.94 Ah per step on this pack); **blind spot**: charging the
    Victron does not see (shore power, alternator) raises the SoC without
    `chargedAh`, so it reads as *lower* consumption. Data source
    (`loadConsumption` in `van/load.ts`, after the Victron read lands and from the
    cache on first paint): 14 days exceed the 72 h cache, so readings come from
    `van-log.jsonl` (`parseCaptureLog`/`toCaptures`) with the `van-history`
    samples laid over them, trends from `van-trends.jsonl` (`parseTrendsLog`)
    with the cached trends laid over (`mergeLongTrends`, no 72 h trim). The chart
    is the yield chart's twin (weekday over day number, "Today / so far", dashed
    average over complete measured/mixed days — also in the heading with the
    average charged in): estimated days are faded (`BarItem.opacity`, mixed
    slightly, pending most), a day with no data keeps its place as "—". Starts at the first
    known day; fewer than two days → no chart.
  - **SoC estimator tuning loop.** Two append-only files in the extension's
    support dir (`~/Library/Application Support/com.tinycast.app.beta/extension-support/jkrumm/`,
    written by `van/capture-log.ts` with only shim-safe fs calls, never throwing):
    - `van-log.jsonl` — one line per Van Power open or background-sampler run
      (`source: "open" | "background"`, absent in older lines = open;
      `make van-eval` shows it as `src`), 60 days:
      `{ t, source, ective: { soc, currentA, voltageV, capacityAh, tempC }, victron:
      { chargeA, batteryV, pvW, state } | null, estimateAtT }`, plus, in the same
      file, one `{ t, victronRead: { phase: "start"|"done"|"failed", … } }` line
      per Victron read phase (since-when, whether the history was asked for,
      duration, new samples, helper errors / the failure reason). A `start` with
      no `done`/`failed` after it means **the read never finished** — Tinycast
      kills a closed view's JS, so a quick look at Van Power can end before the
      ~20–35 s live-then-Victron sequence does; `make van-eval` prints it as
      "cut short". A read that finds nothing newer (a sleeping charger logs
      nothing) is `done` with `newSamples 0`, not a failure. `estimateAtT` is
      what the estimator predicted for that moment **without** this reading,
      computed from the previous readings once the **Victron read has merged the
      day's charger current in** (a prediction from the hours-old cache at open
      would miss the day's solar). The open writes its line at once with
      `estimateAtT: null, estimateReason: "stale-trends"`; when the read lands a
      `{ t, estimateUpdate: { estimateAtT, reason } }` line replaces it
      (`parseCaptureLog` merges them; `"no-estimate"` = nothing to anchor or
      integrate from). If the open ends or the read fails first it stays
      `stale-trends` — never a misleading number; `make van-eval` leaves those
      (and pre-fix entries without a reason, shown as `legacy`) out of the live
      MAE and prints how many.
    - `van-trends.jsonl` — the Victron's trend samples (battery A, battery V, PV W
      at native 5/30-minute resolution) appended on every read, 30 days; the view
      itself still only uses 72 h. Lines overlap by one step; readers dedupe by
      the minute (`parseTrendsLog`).
    - **`make van-eval`** (`scripts/van-eval.ts` → `van/soc-eval.ts`, pure,
      read-only; `ARGS="<dir>"` or `$VAN_SUPPORT_DIR` to point elsewhere) replays
      the estimator **leave-one-out** over every reading and prints, per reading,
      measured vs predicted, the error, the hours to the nearest *other* anchor
      (reading or confirmed full), day/night, and the logged live `estimateAtT`
      with its error; then MAE / max for both, the **implied load `L` per interval
      between consecutive anchors** (readings and confirmed fulls — the table the
      estimator itself uses, flagged where an interval is too short to trust), the
      fallback load, the **Victron read log** and the current constants
      (`ESTIMATOR_CONSTANTS`: `DEFAULT_LOAD_A`, `FULL_VOLTS`, `FULL_TAPER_C`, …),
      and a **per-day table** of the last 14 days (consumed Ah, charged Ah,
      coverage, quality incl. `pending` — `van/consumption.ts`; intervals the
      Victron trend does not cover are flagged in the interval table).
      Tune a constant in `van/soc-estimate.ts`, re-run, compare MAE. It is thin
      until the log has filled: each open (and each background run) adds one reading.

## Bun-only, exact pins

Package manager is **Bun only** — `bun install`, `bun.lock` committed. Every
direct dependency in `package.json` is pinned to an **exact version** (no
`^`/`~`); bumping one is a deliberate, reviewed edit, never `bun update` with
no target.

## Safety

Mutating flows are exercised against the **fake router** (§ Fake router),
never the real device. **Never trigger a Netgear action (reboot / connect / disconnect / SIM PIN,
PUK, APN, or roaming change / SMS mark-read or delete) from a test or an
unattended script.** `netgear/live-smoke.ts` is read-only by construction
(`getStatus` + `login` only) and gated on `NETGEAR_LIVE=1`; every mutating
`NetgearClient` method and `netgear/flows.ts` orchestration (`reconnect`,
`rebootAndReconnect`, `unlockSim`) is exercised in tests exclusively against a
fake transport (`netgear/client.test.ts`, `netgear/flows.test.ts`). The one
place a live action may run at all is `netgear/live-actions.ts`
(`NETGEAR_LIVE_ACTIONS=1`, actions `reconnect`/`reboot`) — and only manually,
with the user's explicit go-ahead each time, never as part of a test or an
agent run.

**Victron history is read-only, enforced in code.** `van-ble --victron-history`
may only write: the init bytes above, the keep-alive (vreg 0x93 exactly), the
Control credit `f9 <n>`, and GET (opcode `05`, instance 3) for vregs
`0x104F…0x106E`. `victronWriteAllowed` in `main.swift` is the allowlist and
`HistoryReader.safeWrite` the only `writeValue` call site — any other frame
aborts the session with `victron-unsafe-write-blocked`. **Never send opcode
`06` for any other vreg, and never `0x1030` (clear history — it wipes the
charger's 30 days irrecoverably).** `--selftest` (run by `make helper` /
`make check`) asserts the allowlist accepts exactly the above and rejects
`0x1030`, neighbouring vregs and other setValues. Widening it is a deliberate,
reviewed edit with a matching selftest case, never a workaround.

**The one extra write: the trends request.** `van-ble --victron-trends` (only
that mode, `victronWriteAllowed(…, trends: true)`) additionally allows GET for
`0xEC5D`, `0xEC4A…0xEC59`, `0xEC5A`, `0xEC5F` and exactly one setValues:
instance 3, vreg `0xEC5B`, bstr of exactly 6 bytes (`trend < 8`, `1…56`
samples) — VictronConnect's own request for stored trends (`vregs.json`:
"SET vreg to send parameters and retrieve data"; the app sends it for every
trends view). Its payload is a query, not a value: trend index, time reference,
sample count. Safe by use (the app issues it constantly on every user's
charger), not by device source. Still blocked and selftested: `0xEC5C` (trends
clear — wipes the store), `0xEC63`/`0xEC64` (lists), `0xEC5F` set (the app
sets the time tuple once per device boot; we never do), `0x1030`, every other
setValues, other opcodes and instances, and a trend request in any other mode.

## SVG hero images and icon previews

`lib/svg.ts` is the entry of a small chart library (`lib/chart/{core,series,bars,gauges}.ts`;
d3-scale/shape/time-format as math only, output a plain SVG string):
`areaChart`/`lineChart` (1–2 series, dual axis, time x), `barChart` (vertical /
horizontal / stacked), `sparkline`, `ring`/`ringGaugeRow`, `thresholdBar`,
`batteryGlyph`, `signalBars`, `menuBarRing`, `tile`, all on one `THEME`. Embed via
`toDataUri()` into markdown / `Grid.Item.content` / `MenuBarExtra`'s `icon`.
Colours are always `raycast-*` names (`RAYCAST_COLOR`), never hex — Tinycast
rewrites them to the live theme (gradients and opacity included, see the tinycast
skill § Designing for Tinycast beta). **API, design rules and perf numbers:
`.claude/skills/svg-charts/SKILL.md`.** A command's hero builders live in a pure
`<feature>/heroes.ts` (no `@raycast/api`) and are listed in
`lib/chart/production-heroes.ts`, so tests and previews render exactly what ships.

**Preview loop after any chart change**: `make previews` renders every hero and a
gallery to `/tmp/tinycast-previews/` (`*.{dark,light}.png`, `sheet-*.png`; `ARGS="van
--coresvg"` filters / renders through macOS' own SVG decoder) — read the PNGs back
before calling a chart done. Plain `rsvg-convert` can't render `raycast-*` tokens as-is;
the script substitutes Tinycast's resolved palette first.

**Sizing is `HERO_COL_WIDTH` (720), not a full-window guess.** Every Detail
command drops its `Detail.Metadata` sidebar once the hero images carry the
numbers a sidebar used to (see § Metadata below and `docs/architecture.md`),
so the markdown pane is the full column (~730pt at the 750-wide `standard`
window) — `HERO_COL_WIDTH` is a conservative round number under that.
`toDataUri()` always appends a `?raycast-width=&raycast-height=` hint
matching the SVG's own declared size (Tinycast beta has no 220pt image
height cap, unlike stable 0.11.3 — it draws at intrinsic/hinted size,
never upscaling). `assertLegible` plus svg.test.ts's production-hero block
enforce ≥11pt text (≥20pt for the one headline number, `role: "primary"`) at that
column width for every production hero — run it after any layout change.

## Metadata: dropped in favour of full-width heroes

`claude-usage`, `netgear`, `battery`, `speed-test`, and `van-power` render **no
`Detail.Metadata` sidebar**, and share one look: **no filled boxes** (Tinycast's
window is translucent — grey cards read like form fields), only hairlines and
type, built from the `raycast-*` tokens so both appearances work. Top down:
**status panel → quiet metrics row → charts → (only what is left) a markdown
table**, and **every number is drawn once**.

- `statusPanel()` (`lib/chart/cards.ts`) — 1–3 big headline columns (label, one
  number, a horizontal gauge, one sub line); it replaces rows of big rings that
  ate the fold for two numbers. Van Power (battery + solar), battery
  (charge + health), speed-test (download + upload), netgear (signal + battery).
  Claude usage (pool + per-account weekly with a week-elapsed tick; one account: weekly + 5h + one model cap).
- `statCards({ size: "compact" })` — one hairline row of label-over-value
  metrics: battery's voltage/temperature/adapter, speed-test's
  latency/responsiveness/interface, netgear's internet (toned)/data/uptime/
  clients, claude-usage's each account's 5h/today (vs avg)/7-day spend (one account: weekly pace/week gone/today/quota-week spend). Van Power has
  none: cell spread and temperature are **warning lines** (spread ≥ 100 mV, or ≥ 50 mV while the charge is 20–90 % — cells naturally diverge at the ends of charge —
  < 5 °C or > 40 °C), cycles/capacity/charger current are cut as numbers that
  change no decision.
- A markdown table stays only for genuinely long-tail reference text, using
  Tinycast beta's real `Grid` table rendering (stable 0.11.3 renders a table
  as plain text — see the skill's § Stable 0.11.3 differences): netgear's
  roaming/APN/PIN/SMS/SIM operator, speed-test's "Recent Tests", netgear's
  "Connected Devices" and watchdog log (plain `Detail`s with a table too, not
  `List`s).

Charts that repeat a panel number drop their last-value chip (`lastValues:
false`). `.claude/skills/svg-charts/SKILL.md` has the API and the
panel-vs-cards-vs-table rule.

## Menu-bar commands — beta only

`ticktick-menu-bar` and `claude-usage-menu-bar` need Tinycast's native
menu-bar rendering (`NSStatusItem`), which landed in `0.11.4-beta.100`
(PR #963) — **stable 0.11.3 ships the JS shims but not the native drawing,
so both commands are invisible there.** This repo's target channel is
already beta (`com.tinycast.app.beta`) for exactly this reason — see the
top of this file. `claude-usage-menu-bar` uses `lib/svg.ts`'s
`menuBarRing()` for a live, no-text ring icon (18×18pt, nothing reads at
that size, the pool's weekly use) and keeps its status-item `title` to the working account
plus its weekly use (`me 9%`, a mark prefix when something needs attention), since
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
5. Data loading: `useCachedPromise` (`@raycast/utils`), not `usePromise` —
   Detail/List/Grid have no loading chrome (see § Loading & performance in the
   tinycast skill), so a bare `usePromise` shows a blank pane on every cold
   open. Pass `{ keepPreviousData: true }`, keep the loaded value plain JSON
   (no secrets, no class instances), and gate any effect that reacts to the
   data on `!isLoading` so a stale cached value can't trigger a side effect
   before the real fetch lands — `netgear.tsx`'s auto-unlock is the reference.
6. Secrets only via `src/lib/secrets.ts` (new key → a `*Ref` preference with an
   `op://` default, `make secrets` entry). Nothing secret or identifying in
   code, fixtures or docs — the repo is public.
7. `make check && make deploy`, then open the command in Tinycast.
8. Launcher access lives in **dotfiles**, not here: add an alias + favorite for
   `extension:jkrumm/<name>` to `config/tinycast/defaults.json`, then
   `make tinycast-apply` (restarts Tinycast) and commit there.

When a Tinycast fact is unclear, read the source rather than guessing:
`gh api repos/abue-ammar/tinycast/contents/<path>?ref=main` (renderer lives
under `Tinycast/Features/Extensions/`), and record what you learn in the
tinycast skill.

## Context

- `.claude/skills/svg-charts/SKILL.md` — chart/hero library: API, theme, design rules, preview loop, perf
- `.claude/skills/tinycast/SKILL.md` — Tinycast runtime reference (build for
  it, install/update loop, debugging, menu-bar semantics)
- `.claude/skills/raycast-extension/SKILL.md` — Raycast component/hook reference
- `.claude/skills/ticktick-api/SKILL.md` — argo TickTick proxy API reference
- `docs/architecture.md` — commands → modules → data sources
- `docs/netgear-m2.md` — Netgear MR2100 API reference (verified live)
