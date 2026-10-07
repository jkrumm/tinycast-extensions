# Netgear Nighthawk M2 (MR2100) — HTTP API reference

Verified live against a real MR2100 at `192.168.1.1` on 2026-09-27
(`GET /api/model.json` in both Guest and Admin roles). Action endpoints
(reboot/connect/disconnect/PIN/PUK/APN/roaming/SMS) are sourced from the
router's own web UI JS (`/static/js/script.js`, firmware `NTGX24_10.19.03.00`)
and implemented + unit-tested against a fake transport
(`extension/src/netgear/client.test.ts`, `flows.test.ts`) — **never executed
against the real device from a test or an unattended script.**

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
   **The password POST is a toggle** (verified live 2026-10-04): on a session
   that is already Admin it logs *out* to Guest (204 either way, with
   redirect fields `{ "success": true }` either way). A Guest session then
   gets every write refused with `/error.json` → `{"errno": 1, "errdetail":
   "<first field>"}`. `client.login()` therefore only posts when the model
   says Guest, verifies Admin afterwards (else throws "Router login failed"),
   and `action()` re-logs-in and retries once when a refusal comes back on a
   session that is no longer Admin (another process sharing the cookie jar,
   or expiry). This — not the value casing below — was the cause of the
   refused restarts: `withAdmin` logged in unconditionally while the open
   view kept the shared session Admin.
4. Guest role can read status (`GET /api/model.json`); mutating actions
   require Admin. **Verified** — actions were not attempted, but the device
   only meaningfully differs by `userRole` in the model.

## Actions — sourced from the web UI's own JS, never executed live

All POSTs are form-urlencoded with `token=<secToken>&ok_redirect=/success.json
&err_redirect=/error.json`. Success body: `{ "success": true }`. The web UI's
own `action()` routes the POST **path** by which field is present:

- any field starting with `profile` (the web UI's profile delete is
  `profile.id` + `action=delete`, not a `wwan.profileList.deleteId` field —
  that id only appears in this path-routing check) → `/Forms/profile`
- a non-empty `sim.pin.change` or `sim.newpin` → `/Forms/pinChange`
- everything else → `/Forms/config`

| Action | Path | Fields | Live-tested |
|-|-|-|-|
| Reboot | `/Forms/config` | `general.shutdown=restart`, else `Restart` (see below) | yes, 2026-10-04 |
| Connect | `/Forms/config` | `wwan.connect=DefaultProfile` | yes, 2026-09-27 |
| Disconnect | `/Forms/config` | `wwan.connect=0` | yes, 2026-09-27 |
| Enter SIM PIN | `/Forms/config` | `sim.pin.entry=<pin>` (secret field) | yes, 2026-09-27 |
| PUK unblock | `/Forms/pinChange` | `sim.puk.entry=<puk>&sim.newpin=<newpin>` (secret fields) | no |
| Change SIM PIN | `/Forms/pinChange` | `sim.pin.change=<oldpin>&sim.newpin=<newpin>` (secret fields) | no |
| Enable PIN lock | `/Forms/config` | `sim.pin.enable=<pin>` (secret field) | no |
| Disable PIN lock | `/Forms/config` | `sim.pin.disable=<pin>` (secret field) | no |
| Set active APN | `/Forms/config` | `wwan.profile.default=<id>&wwan.profile.promptForApnSelection=false` | no |
| Update APN profile | `/Forms/profile` | `action=update&profile.id=<id>&profile.name&profile.apn&profile.username&profile.type&profile.pdproamingtype&profile.authtype`; `profile.password` **only if the user changed it** (secret field); no `ipaddr` — from web UI source, 2026-10-02 | no |
| Delete APN profile | `/Forms/profile` | `action=delete&profile.id=<id>`; the router refuses the active profile and delete-deny ones — from web UI source, 2026-10-02 | no |
| Create APN profile | `/Forms/profile` | `action=create&profile.name&profile.apn&profile.username&profile.password&profile.authtype&profile.type&profile.pdproamingtype&profile.ipaddr=0.0.0.0` — the id is router-assigned, found by re-reading `profileList` for the new `name` | no |
| Data roaming | `/Forms/config` | `wwan.autoconnect=Always` (allow) / `HomeNetwork` (home only); the web UI also writes `Never` and `RoamNetwork` | no |
| SMS mark read | `/Forms/config` | `sms.readId=<id>` | no |
| SMS delete | `/Forms/config` | `sms.deleteId=<id>` | no |

Implemented in `NetgearClient` (`extension/src/netgear/client.ts`), exercised
only via `client.test.ts`'s fake transport and the in-process fake router
(§ Fake router), which asserts the exact field set
and path per action. See `AGENTS.md` § Safety for the one place a live action
is ever allowed to run (`netgear/live-actions.ts`, gated, manual, with the
user's explicit go-ahead).

## SIM PIN auto-unlock

`extension/src/netgear/pin-store.ts`'s `KeychainSimPinStore` stores a PIN in
macOS Keychain per SIM, keyed by ICCID (`netgear-sim-pin:<iccid>`, service
`tinycast-extensions` — same service as every other secret this extension
caches, see § Secrets in `AGENTS.md`) so a SIM swap never reuses another
SIM's saved PIN.

The router reports an **empty `sim.iccid` while the SIM is Locked**
(verified live 2026-09-27), so `flows.ts`'s `resolveAutoUnlockPin()` finds
the SIM's identity in this order: the status itself → an ICCID the caller
knows is the same physical SIM (`rebootAndReconnect()` captures it before
rebooting) → the last SIM seen unlocked (`netgear-sim-last-iccid`, written
on every load), which is only a *fallback* guess. Guards on every automatic
attempt:

- `sim.status` must be `"Locked"` — `"Blocked"` needs a PUK and is never
  auto-attempted.
- `sim.pin.retry >= 2` for a confirmed SIM, `== 3` (all tries left) for a
  fallback guess — an automatic attempt never spends the last try, and a
  swapped SIM costs at most one.
- **One automatic attempt per saved PIN, ever**: any automatic attempt that
  doesn't end Ready (rejected, timed out, unclear) deletes the saved PIN.
  Only a human entering the PIN can spend a further try. Manual entry
  forgets a saved PIN only on a proven rejection (retry counter dropped).
- Concurrency: an automatic attempt first **takes** the PIN
  (`SimPinStore.take()` = read + Keychain delete; only the caller whose
  delete succeeds gets it) and only a Ready SIM writes it back — so the
  watchdog tick and the command's on-open auto-unlock can never both enter
  it.

The router may not answer the `sim.pin.entry` POST before curl's 8s timeout
(the web UI's own request shows no status either), so the POST's result is
ignored — the SIM state (Ready within 60s, or a dropped retry counter)
decides.

On the `netgear` command's mount and after `Restart & Reconnect`, a
successful unlock is followed by `ensureConnected()` (wait for the router's
own autoconnect, then `connect()`; never disconnects first). When no PIN is
usable, `rebootAndReconnect()` throws `SimPinRequiredError` and the UI pushes
`EnterPinForm`.

`general.shutdown` casing is **not** a proven cause of refusals — the
refusals below match the login toggle (§ Session and auth, item 3). The router's
own web UI (`script.js`) uses both: the Restart button sends
`submit({"general.shutdown":"restart"})`, the automatic restart after saving
settings (`case "full"`) sends `"Restart"`. This extension's `"Restart"` was
accepted on 2026-09-27 and 2026-10-03 15:32 but refused (`/error.json` body
`{"errno": 1, "errdetail": "general.shutdown"}`) on 2026-10-03 15:02 and
2026-10-04 16:01/16:04, so `client.reboot()` sends `restart` first, retries
once with `Restart` if the router refuses it (not if it is unreachable), and
if both are refused throws `Router rejected the reboot request (tried both
variants, …)`, which `describeNetgearError` turns into "Router refused the
restart (tried both variants) — restart it from the router's website or power
button." Shutdown (power off) is `Shutdown` — never sent by this extension. The
fake router accepts only `restart` by default and answers anything else with
that errno 1 body (`state.acceptedShutdownValues` changes that).

## Reboot: the Mac has to rejoin the Wi-Fi

After a reboot macOS did not auto-rejoin the router's Wi-Fi within 4 minutes
(verified live 2026-09-27), and without the LAN link nothing can enter the
PIN. `rebootAndReconnect()` therefore reads `wifi.SSID` + `wifi.passPhrase`
from model.json (Admin role) **before** rebooting — macOS redacts the current
SSID from unprivileged processes — and, after 30s of unreachability, runs
`networksetup -setairportnetwork <wifi device> <ssid> <passphrase>` every
20s (`netgear/wifi.ts`; no sudo; without the passphrase it fails with -3900
even for a saved network; exits 0 on failure, so the output is checked).
Live run: reboot → back on the LAN after 2 rejoins → PIN → Connected, 97s.
Every post-reboot status poll rides out transient transport errors until
its deadline.

The UI no longer runs this poll inside the view: `rebootAndReconnect()` (still
used by `live-actions.ts`) needs the view's JS alive for minutes, and
Tinycast kills it on close — 2026-10-03 15:32 a Restart & Reconnect logged
"Rebooting router…" and never an outcome, leaving the UI action lock held
until its TTL. **Restart & Reconnect** now only sends the reboot and records a
**reboot marker** `{ at, source, iccid }` in the watchdog's `LocalStorage`
state (`WatchdogState.reboot`), releases the lock and toasts "Router
restarting — reconnects automatically (~2 min)". The watchdog recovers from
the marker (see § Watchdog: reboot marker and last-resort reboot) and the
open view renders the restart banner from it.

## Freshness and self-heal when the Mac is off the router's Wi-Fi

Real-world evidence (2 days of `make status`'s watchdog log, 2026-09):
`netgear.tsx`'s `useCachedPromise` painted stale "Connected" status while the
router was actually unreachable (the Mac had drifted off its Wi-Fi), and a
manual "Reconnect" failed with a raw `curl exited 7`/`28` error instead of an
explanation. Two fixes:

- **Freshness**: `loadStatus()` is wrapped in `lib/freshness.ts`'s `stamped()`
  → `Stamped<{ status, internet }>` (router status plus the real internet probe). `netgear.tsx` renders `freshnessBanner()` as the
  first markdown block whenever the latest refresh failed (cached data is
  shown with its age), and `updatingLine()` as the last line while a refresh
  is in flight — replacing the old unconditional `_Updating…_`. With no
  cached data at all it shows a plain "Router not reachable" empty view. The
  default `useCachedPromise` failure toast is suppressed (`onError: () => {}`)
  since the banner already covers it, and the on-open SIM auto-unlock effect
  is gated on `!isLoading && !error` so it never acts on a status that this
  mount's own fetch didn't actually confirm.
- **Self-heal**: `netgear/wifi-creds-store.ts`'s `KeychainWifiCredsStore`
  persists the router's own Wi-Fi SSID/passphrase in Keychain (account
  `netgear-wifi`, same pattern as pin-store.ts) whenever an Admin session
  reads them (`session.ts`'s `withAdmin`, `netgear.tsx`'s `loadStatus`) — not
  just right before a planned reboot. `flows.ts`'s `ensureRouterReachable()`
  uses those stored creds to rejoin the Mac to the router's Wi-Fi (single
  attempt, then poll up to 20s) whenever the router doesn't answer.
  `withAdmin({ selfHeal: true })` runs it before login for Reconnect,
  Restart & Reconnect, and Enter/Unblock SIM PIN; `netgear.tsx` also exposes
  it directly as a "Rejoin Router Wi-Fi" action (primary when the router is
  unreachable). Every other admin action (roaming, APN, SMS, PIN lock,
  Connected Devices) is hidden from the ActionPanel while unreachable instead
  of self-healing, since none of them are safe/useful to retry blind.
- **Friendly errors**: `netgear/errors.ts`'s `describeNetgearError()` maps
  curl exit 7/28 and common connect-errno strings to "Router not reachable —
  is this Mac on the router's Wi-Fi?", and a `NetgearClient.action()`
  rejection to "Router rejected the <label> request" (`action()` takes a short
  label: disconnect, connect, reboot, SIM PIN, …) — used by `withAdmin`'s failure
  toasts, `watchdog.ts`'s event messages, and `live-actions.ts`'s console
  output, so the same failure never reads differently in three places. Router
  JSON-parse failures, connect/disconnect timeouts, other curl exit codes and
  internal `TypeError`s each get their own "what happened / what to do"
  sentence; anything unmatched keeps the raw message.
- **Action log**: every admin action, auto-unlock, Wi-Fi rejoin, lock wait and
  non-routine watchdog event is also appended — with the raw error and first
  stack frames — to `netgear.log` in the extension's support dir
  (`lib/action-log.ts`; `make logs`, `make status`, or "Show Netgear Log" in
  the command). The friendly text is what the toast shows; the log is where to
  find out what actually happened.

## Watchdog: Tinycast's 60s kill, the tick budget, and the Wi-Fi rejoin rule

Live evidence (`make status`'s watchdog log, 2 days, 2026-09):
`extension-commands.json` showed `consecutiveFailures: 9, lastError: "Timed
out."` — Tinycast kills a background run after
`min(max(interval, 15), 120)`s, which is **60s** for this command's 1-minute
interval (`ExtensionRefreshPolicy.swift:64`, `ExtensionManager.swift:616`
records `"Timed out."`). A killed tick writes no event and loses state
silently. The log also showed frequent `idle: Router not reachable`
interleaved with `probe-failed` and raw `reconnect-failed: curl exited
7`/`28` — the Mac repeatedly drops off the router's Wi-Fi.

- **Hard budget**: `runWatchdogTick`'s `budgetMs` option (default
  `DEFAULT_WATCHDOG_BUDGET_MS = 45_000`) scales a shortened set of
  `flows.ts` timeouts (`FlowTimeouts`: `unlockMs`, `checkMs`, `connectMs`,
  `disconnectMs`, `dataOffMs`) via `scaledTimeouts()`, passed into every `unlockSim` /
  `autoUnlockIfPossible` / `ensureConnected` / `reconnect` call the tick
  makes — interactive callers (netgear.tsx, sim-forms.tsx) never set this and
  keep the original, much longer defaults. A tick only ever takes **one** of
  the three long actions (unlock+connect ≤40s, connect ≤20s, or reconnect
  ≤27s at the default budget), so every path finishes well under the 60s
  kill, verified in `watchdog.test.ts` with `fakeClock` against a
  never-succeeds script for each branch.
- **In-tick internet confirm** (2026-10-05 evidence: "Connected but no
  internet" outages at 15:17 and 18:59, each detected only on the 2nd tick
  ~75s after the 1st failed probe, then fixed by one reconnect). When the probe
  fails on a Connected router and nothing would act yet (first failure, no
  reconnect backoff running), the tick sleeps `CONFIRM_DELAY_MS` (10s,
  injected `sleep`) and probes once more. Still failing counts as the 2nd
  consecutive failure at once, so the normal reconnect / backoff / data-toggle
  logic runs in this tick; succeeding is a transient blip and a plain `ok`
  (nothing extra logged). Budget arithmetic: the confirm costs at most
  `CONFIRM_COST_MS` = 10s sleep + 8s probe timeout (`PROBE_TIMEOUT_MS`,
  mirrors `internet-probe.ts`'s curl `-m 8`) = 18s, so when it ran the action
  timeouts are `scaledTimeouts(budgetMs - 18s)` — 27s at the default, i.e.
  reconnect 7s + 9s (was 12s + 15s), data toggle 6s + 9s. Worst case before
  the 60s kill: first probe 8s + confirm 18s + status/login ~4s + action ≤16s
  = ~46s (unit-tested with sleep and probe time added to the fake clock). The
  confirm is skipped — and failed probes are counted across ticks as before —
  when `budgetMs - 18s` would leave under 25s for the action, or while a
  reconnect backoff is running (it would only delay a tick that cannot act).
- **Incident context in the log**: every non-routine event (`probe-failed`,
  `reconnected`, `reconnect-failed`, `connect-failed`, `data-toggled`,
  `data-toggle-failed`, `rebooted`, `recovered`) appends
  `band=<curBand> radio=<radioQuality>% operator=<registerNetworkDisplay>
  rat=<connectionText> rsrp=<dBm> rsrq=<dB> sinr=<dB>` (`incidentContext()`,
  `n/a` for an empty text field or a missing signal reading) to
  its log detail, from the status the tick already read — no extra request —
  ahead of the `wwan.*` diagnostics. Meant for correlating carrier-side drops
  with radio conditions.
- **Breadcrumb before every long action**: `onAction(kind)` (kinds:
  `"unlocking" | "connecting" | "reconnecting" | "rejoining"`) is awaited
  right before the tick starts one of those calls. `netgear-watchdog.tsx`
  wires it to persist an `in-progress` event (`breadcrumbMessage(kind)`) to
  `LocalStorage` immediately, so a kill mid-flight still leaves a trace in
  the log instead of silence, ahead of the final outcome event the tick
  itself returns.
- **Wi-Fi rejoin rule**: on the tick's initial `getStatus()` failure (router
  unreachable), it now checks `probeInternet()` — if the Mac has **zero
  internet at all** (not just "off the router's LAN"; a normal home Wi-Fi
  with real internet never triggers this) **and** `wifi`/`credsStore` were
  passed **and** stored creds exist **and** the last rejoin attempt was ≥5
  minutes ago (`WatchdogState.lastRejoinAttemptAt`), it rejoins the router's
  Wi-Fi once. Otherwise it reports `idle` exactly as before — the watchdog
  still never touches Wi-Fi while the Mac is legitimately elsewhere with its
  own working internet.
- **A rejoin only counts if the router answers** (live evidence 2026-10-06:
  the router's battery died overnight and the watchdog logged `rejoined` eight
  times between 01:56 and 08:11 while it was off — `networksetup
  -setairportnetwork` prints `Could not find network <ssid>.` for an SSID that
  is not on air, and exits 0). Two guards: `wifi.ts`'s pure `joinSucceeded()`
  treats `failed|error|could not find|not find|unable|timed out` in
  stdout+stderr as a failed join, and after a successful join the tick polls
  `client.getModel()` (every 2s, up to `REJOIN_REACHABLE_WAIT_MS` = 10s). Only
  a reachable router gives `rejoined`; otherwise `rejoin-failed` ("Router not
  found on Wi-Fi — off or out of battery?"). The post-reboot recovery rejoin
  goes through the same function, so it has the same check.
- **Battery awareness**: every tick that read a status (Admin or Guest)
  persists `WatchdogState.lastBattery = { level, charging, at }`. State
  persisted by an older version loads with the new fields defaulted
  (`migrateWatchdogState`, used by `watchdog-storage.ts`).
  - `battery-low` ("Router battery 18% — plug it in"): notice only, no action.
    Announced once per crossing, at ≤20% and again at ≤10% (a router first seen
    below 10% gets the 10% step only), while not charging
    (`WatchdogState.lowBatteryNoticeLevel` = last announced step). Re-armed when
    the level climbs above 25% (the 20-25% band is hysteresis) or the router
    starts charging. It replaces a plain `ok` tick only — any other event keeps
    its own row and the notice waits for the next `ok`. While the battery is
    low and not charging, events carry `batteryLow` and `formatSubtitle` adds
    ` · 🔋18%` to the launcher subtitle ("OK · 4G+ · 🔋18% · 14:02").
  - `battery-empty` ("Router off — battery was 4% at 00:45. Plug it in."): the
    router is unreachable and `lastBattery` is not charging, ≤10% and younger
    than 12h (and no reboot marker is active). Replaces `idle`; consecutive
    identical ticks collapse in the log like `idle`, and the Netgear file log
    only gets the first of a streak. No Wi-Fi rejoin in this state, except one
    attempt per 30 min (`BATTERY_EMPTY_REJOIN_BACKOFF_MS`, through the normal
    zero-internet rule) in case it was plugged in; a reachable result is
    `rejoined`, anything else stays `battery-empty`.
    `WatchdogState.batteryEmptyAt` is set on the first one.
  - `power-restored` ("Router back on power (battery 5%, charging)"): the first
    tick that reads a status while `batteryEmptyAt` is set; clears it. It stands
    in for an informational event (`ok`, `connected`, `unlocked`, `needs-pin`,
    `no-password`, `roaming-enabled`, `probe-failed`; the replaced one lands in
    `detail`); a failed connect/reconnect or a reboot keeps its own event and
    `power-restored` follows on a later tick. Boot steps (SIM unlock, connect)
    continue as usual on the following ticks.
  - **View**: a fresh (not cached) status that is ≤20% and not charging adds
    `> 🔋 **Router battery 18%** — not charging.` under the headline. When the
    router is unreachable and the watchdog's newest (non-`in-progress`) event is
    `battery-empty`, the offline banner shows that event's message instead of
    "Router not reachable". Battery kinds get a 🔋 glyph in the status
    section.
- **Escalating reconnect backoff**: `WatchdogState.reconnectStreak` counts
  reconnects (successful or not) since the last successful internet probe.
  The next reconnect waits `reconnectBackoffMs(streak)`: 2 min after the 1st,
  5 min after the 2nd, 10 min from the 3rd on; a successful probe resets the
  streak to 0 (a fresh outage then only needs the usual 2 failed probes).
  Persisted state from before the field existed loads with streak 0
  (`watchdog-storage.ts`).
- **Action lock** (`netgear/action-lock.ts`): live evidence (2026-10) was a
  manual Reconnect failing with "Router rejected the request" because the
  watchdog was mid-connect at the same moment (and `reconnect()` used to
  disconnect unconditionally). `netgear-action.lock` in `supportPath` is a
  JSON `{owner, label, at, expiresAt}` file created with `open(path, "wx")`;
  an expired or unparseable lock counts as free. The watchdog tick holds it
  (`owner: "watchdog"`, TTL 90s); if a `ui` lock is held the tick does not run
  and logs a `deferred` event ("Manual action in progress — skipped",
  collapsed like `ok`/`idle`). A watchdog-owned lock found by a tick is a
  previous tick Tinycast killed, so it is taken over. UI actions
  (`withAdmin`, auto-unlock, Rejoin Wi-Fi) hold it as `ui` (TTL 2 min — no UI
  action runs long since Restart & Reconnect detached), wait up to 60s for a foreign lock ("Waiting for the watchdog
  to finish…"), then take over — an explicit user action wins.
- **Data-roaming rule**: roaming is meant to be always on. As Admin, when
  `wwan.autoconnect` is readable (non-empty) and not `Always`, and the last
  attempt was ≥10 minutes ago (`WatchdogState.lastRoamingAttemptAt`, set on
  success *and* failure so a router that ignores the write isn't hit every
  minute), the tick calls `setRoaming(true)` and returns a `roaming-enabled`
  event ("Data roaming re-enabled (was HomeNetwork)"). It runs after the
  SIM-Ready check and before the connection checks, but returns immediately —
  the next tick continues with connect/probe. A rejected write is an `error`
  event and the tick still proceeds normally on later ticks.
- **State-aware `reconnect()`**: reads `getStatus()` first. Connected →
  disconnect; Disconnecting → just wait; Connecting → wait up to the connect
  timeout for Connected (returned as-is if it gets there), else cycle it;
  Disconnected → skip the disconnect. A "rejected" disconnect/connect is
  tolerated when a re-read shows the router already moving the right way
  (`ensureConnected()`'s connect likewise).

### Watchdog: escalation ladder, data toggle, and last-resort reboot

The ladder depends on what the router reports:

- **Router not Connected** (`connect-failed`, stuck `Disconnected`): connect →
  **reboot on the 2nd consecutive `connect-failed` tick**
  (`STUCK_DISCONNECTED_REBOOT_THRESHOLD = 2`). **No data toggle** — it failed
  2/2 live on a router stuck Disconnected (2026-10-05 10:43 and 13:35: connect
  accepted, nothing happens, `inactivityCause` 307); only a reboot cleared
  both, within ~3 min (§ Soft-reset levers).
- **Router Connected but the internet probe fails** (`probe-failed` /
  `reconnect-failed`): **connect/reconnect → data off/on → reboot** at 3
  (`STUCK_REBOOT_THRESHOLD`; a `reconnect-failed` tick keeps threshold 3).

The data off/on soft reset (`flows.ts` `toggleData`, lever measured in
§ Soft-reset levers) is step 2 of the second path only:

- **Trigger**: a Connected tick with a failing probe that would run reconnect
  (internet still down; or a failed probe already counting as stuck)
  while `stuckStreak === 1` (so this is the second stuck tick) and
  `WatchdogState.dataToggledAt === null` runs `toggleData` **instead of** that
  reconnect — one long action per tick, so the 45s budget holds
  (`dataOffMs` 10s + `connectMs` 15s at the default budget). Never with a
  non-Ready SIM (Locked/Blocked return before it), never on a healthy tick,
  never on a router that is not Connected.
- **`toggleData`**: `wwan.autoconnect=Never` → poll Disconnected → **always**
  `Always` in a `finally` (even if the request or the off-poll throws, so data
  roaming can never be left off) → poll Connected; throws a clear error if the
  router doesn't come back Connected.
- **Outcome**: event `data-toggled` ("Mobile data switched off/on to reset the
  connection") or `data-toggle-failed`; both count as a stuck tick
  (`stuckStreak` 2) and set `dataToggledAt`, so there is **one toggle per stuck
  episode** (`dataToggledAt` clears whenever the streak resets). Breadcrumb
  `toggling-data`; the log detail carries `wwan.connection` /
  `inactivityCause`. If the next tick is `ok`, the streak resets as usual; if
  it is stuck again the reboot below fires at streak 3.

### Watchdog: no mobile network (limited service)

Evidence 2026-10-06 11:39–12:37: the router lost network registration —
`wwan.currentNWserviceType = "LimitedService"`, `wwan.registerNetworkDisplay =
""`, `wwan.connection = "Disconnected"`, bands hopping B8/B3/B20 for 8+ minutes,
sometimes with strong readings (B3 RSRP −83, SINR 18) yet never registered
(likely cells of an operator the SIM may not use; the permitted ones are weak
there). Connect attempts, the watchdog's restart and two manual restarts all
came back `LimitedService`, and the watchdog's "Router did not connect … check
the SIM has data and the APN" plus its reboot escalation were pointless.

- **`RouterStatus.registered`**: `serviceType` (`wwan.currentNWserviceType`,
  "" when absent) is not `""`/`LimitedService`/`NoService` **and** the operator
  name is non-empty. A firmware that omits the field therefore reads as not
  registered.
- **Rule** (`runTick`): router reachable, SIM `Ready`, `!registered` → no
  connect, data toggle or reboot. Event `no-service` ("No mobile network —
  limited service (operator not available here). Waiting for coverage."),
  collapsible like `idle`, with the radio context (`incidentContext`) in the
  detail; `stuckStreak`, `reconnectStreak` and `internetFailures` reset to 0 so
  the normal ladder starts fresh once it registers; the battery is still
  recorded. A reboot marker is dropped as soon as the router answers with an
  uptime that shows it restarted (it came back, just without a network).
- **Escalating restart**: `WatchdogState.noServiceSince` is set on the first
  `no-service` tick. The first restart is allowed after
  `NO_SERVICE_FIRST_REBOOT_AFTER_MS` (5 min) of continuous no-service (event
  `rebooted`, "Router stuck — restarted it (no service for N min)", N from the
  actual duration). If service is still missing, the next ones come after
  `NO_SERVICE_REBOOT_GAPS_MS` = 30 min, 2 h, then every 6 h since
  `lastNoServiceRebootAt`, indexed by `noServiceRebootCount` (`gaps[min(count -
  1, 2)]`). Both are set by a refused attempt too, and `noServiceSince` is kept
  across the restart so the reason and `service-restored` see the whole outage.
  A registered tick resets the count to 0, so the next outage starts at 5 min
  again. Guards stay: Ready SIM, no active reboot marker, the general 30-min
  `REBOOT_COOLDOWN_MS`. Interplay: a no-service restart sets `lastRebootAt` and
  `lastNoServiceRebootAt` to the same time and both gaps are compared with `>=`,
  so the 30-min cooldown never delays the 2nd no-service restart; it does hold
  back the 1st if any other restart ran less than 30 min ago.
- **Why early, then back off** — 2026-10-07 11:33–12:08 the router sat in
  `LimitedService` camped on a bad cell (B3, RSRP −115, SINR −7) at a spot where
  good coverage normally exists; the old rule waited 60 min. The manual restart
  at 12:08 fixed it within ~1 min (vodafone P, B1, RSRP −88). 2026-10-06
  restarts did **not** help because there was genuinely no usable coverage
  there — hence one quick try, then increasing gaps.
- **Fail-fast manual actions**: `flows.ts` `reconnect()` throws
  `NO_SERVICE_ERROR_MESSAGE` ("No mobile network (limited service) —
  reconnecting can't help; try Restart & Reconnect.") right after its first
  status read when a Ready SIM is not registered, and `ensureConnected()` does
  the same after its short "already connected?" check (so a SIM that was just
  unlocked still gets that window to register — three of its four callers run
  right after an unlock). Before this, 2026-10-07 12:05 a manual Reconnect
  polled for a connect that cannot happen without registration, held the UI
  lock, and died with the view without logging an outcome. The watchdog never
  reaches either call while unregistered (the `no-service` branch comes first).
  The main view makes Restart & Reconnect the primary action in that state.
- **`service-restored`** ("Mobile network back (<operator>, <band>)"): the first
  tick that sees a registered status after a `no-service` stretch. The normal
  flow runs in the same tick; the event stands in for an informational result
  (`ok`, `connected`, `recovered`, `unlocked`, `roaming-enabled`,
  `probe-failed`; the replaced one lands in `detail`), any other event keeps its
  own and carries the notice as detail.
- **Surfaces**: launcher subtitle "No service · 12:40"; 📵 (restored: ↻) in the
  status view's watchdog table; with a Ready SIM and `!registered` the status
  view headlines `# No service` with a 📵 warning; the Signal Meter headlines
  "Not registered (limited service)"; the Netgear file log gets only the first
  `no-service` of a streak.

### Watchdog: reboot marker and last-resort reboot

Evidence 2026-10-04 15:57–16:00: the router sat `Disconnected` while
`wwan.connect` was accepted but did nothing; the watchdog logged
`connect-failed` every tick and — because it never rebooted — could not
recover. Only a reboot (done by hand on the router's website) fixed it. The
watchdog therefore reboots **only as a last resort**:

- **`stuckStreak`** (`WatchdogState`): +1 per tick ending in `connect-failed` or
  `reconnect-failed`, or in `probe-failed` while `reconnectStreak >= 2`
  (reconnects didn't help); reset by `ok`, `connected`, `recovered` and by the
  reboot itself. `reconnected` leaves it alone (no probe has confirmed it).
- **Guards**: streak ≥ 3 (`STUCK_REBOOT_THRESHOLD`; ≥ 2,
  `STUCK_DISCONNECTED_REBOOT_THRESHOLD`, when the tick itself is
  `connect-failed`), no reboot in the last 30
  min (`lastRebootAt`, set by any reboot — UI or watchdog — and also by a
  *refused* attempt so a router that rejects it isn't hit every minute), the SIM
  `Ready` (a Locked/Blocked SIM is never rebooted: it can't help and could
  re-lock), and no reboot marker still inside its recovery window.
- **Fire-and-forget**: `client.reboot()` (the POST returns immediately), the
  Wi-Fi credentials are captured first, `onAction("rebooting")` leaves the
  breadcrumb, then the tick returns event `rebooted` ("Router stuck —
  restarted it (could not connect | reconnects failed | no internet after
  reconnects)") with streaks reset. It runs in the same tick as the third
  failure, inside the usual budget (the reboot POST is a single fast request).
- **Reboot marker** (`WatchdogState.reboot = { at, source: "ui" | "watchdog",
  iccid }`; the ICCID is captured while the SIM is Ready because a Locked SIM
  hides it): for `REBOOT_RECOVERY_WINDOW_MS` (5 min) an unreachable router is
  *expected*. The tick then rejoins the router's Wi-Fi immediately — no "Mac has
  zero internet" condition, no 5-min backoff, at most one attempt per 30s
  (counted as `rejoined` only if the router then answers, see the rejoin
  guard above, else `rejoin-failed`);
  otherwise it logs `rebooting` ("Router restarting — waiting for it to come
  back"). Once reachable it follows the normal flow (login, auto-unlock with
  the marker's ICCID as `knownIccid`, connect). **Connected + probe OK + router
  uptime shorter than the time since the reboot** (the router can answer for a
  few seconds after the POST) → event `recovered` ("Back online after
  restart") and the marker is cleared. A marker past 5 min is ignored for
  recovery but kept — cleared by the next healthy tick, or dropped after 30 min
  — so the view's "did not come back" warning has something to show.
- **View**: while the marker is < 5 min old and the router isn't back (a fetch
  newer than the marker, Connected, internet OK, uptime reset), the view shows
  `> 🔄 Router restarting… (1:20 elapsed)` and suppresses the "Router not
  reachable" banner; after 5 min unrecovered,
  `> ⚠️ Router did not come back after the restart` with a Rejoin Router Wi-Fi
  hint.
- **Diagnostic**: `RouterStatus.inactivityCause` is the raw
  `wwan.inactivityCause` (the web UI parses it as an int; "" when absent).
  Every watchdog `connect-failed` event and the `rebooted` event append
  `wwan.connection=<…>, wwan.inactivityCause=<…>` (read fresh) to their log
  detail, so the next stuck state says why the data session was down.

## APN profiles and data roaming

`wwan.profileList` (padded with a trailing `{}`, filtered on `id`) and
`wwan.profile.default` (the active profile's id) drive
`RouterStatus.profiles` / `activeProfileId`. Guest sessions don't see either
field — Admin is required to list profiles. A list entry carries `id, index,
name, apn` (or `APN`), `username, password, type, pdproamingtype` (or
`roamingtype` on some firmware), `authtype, access_control`.

- **Password**: the model includes the profile `password`; the parser reduces
  it to `RouterProfile.hasPassword` and never exposes it (same rule as the
  Wi-Fi passphrase — not in `RouterStatus`, UI state or logs). An edit sends
  `profile.password` only when the user typed one; a blank field keeps the
  existing password. A duplicate can't copy it for the same reason.
- **`access_control`** is a bitmask the web UI reads as a number: `2` =
  write-deny, `4` = delete-deny, `6` = both (`""` = unrestricted). `editable` =
  no write-deny bit; `deletable` = no delete-deny bit **and** not the active
  profile (the router never deletes the active one). A locked profile is
  "edited" by duplicating it into a new one.
- **Enums**: `authtype` ∈ `None`/`PAP`/`CHAP`/`PAPCHAP` (username/password are
  irrelevant for `None`); `type` ∈ `IPV4`/`IPV6`/`IPV4V6`; `pdproamingtype` ∈
  `None`/`IPV4`/`IPV6`/`IPV4V6` — **`None` means the profile carries no data
  while roaming** (shown as a "No roaming data" warning, fixed by "Fix Roaming
  Data": update with `pdproamingtype = type`). The web UI validates only that
  name and APN are non-empty after trimming; there are no length limits.
- **Create → activate**: the router assigns the new profile's id. Like the web
  UI, the app diffs `profileList` against the ids that existed before the
  create and activates the new one, falling back to the highest-index
  name+apn match (`apn-model.ts`'s `findCreatedProfile`).

Operations (see § Actions): set active (`setActiveProfile` + `flows.reconnect()`),
create, update, delete. `netgear/apn.tsx` is the UI (list with Active / 🔒 /
auth / IP type / no-roaming accessories and a network header — operator,
`wwanadv.MCC`/`MNC`, `wwanadv.country`, "Roaming now" / "Home network" — and one
shared add/edit/duplicate form); `netgear/apn-model.ts` holds the pure logic.

**Roaming.** `wwan.autoconnect` encodes data + roaming, not just "auto-connect
on boot": `Never` = data off; `Always` = data on + roaming on; `HomeNetwork` =
data on, roaming off; `RoamNetwork` = data off, roaming on. The web UI can
write all four, so none is read-only. `RouterStatus.roamingAllowed` is
`autoconnect === "Always"`; this extension only ever writes `Always` (the
watchdog's roaming rule, the "Enable Data Roaming" action) — there is no
toggle back to home-only. `wwan.roaming` (bool) = registered on a roaming
network right now → `RouterStatus.currentlyRoaming`; trust it, `roamingMode` /
`roamingType` are unreliable. Read-only extras: `wwanadv.MCC`, `wwanadv.MNC`,
`wwanadv.country`, `wwan.registerNetworkDisplay`.

## SMS

`sms.msgs` (padded with a trailing `{}`, filtered on `id`) exposes the actual
message list — `{id, rxTime, text, sender, read}` — unlike the
unread-count-only model this extension shipped with initially. The "Sms"
sub-view is a real inbox: open a message, mark as read (`sms.readId`), delete
(`sms.deleteId`), copy text. `sms.msgCount` is the total count if needed
later; not currently surfaced in the UI beyond `smsUnread`.

## Fields read from `model.json`

| Path | Used for |
|-|-|
| `session.userRole` | Guest/Admin |
| `session.secToken` | CSRF token required on every `POST /Forms/config` |
| `wwan.connection` | raw connection state (Connected/Disconnected/Connecting/Disconnecting; anything else treated as transitional) |
| `wwan.connectionText` | e.g. `"4G+"` |
| `wwan.registerNetworkDisplay` | operator name (`""` when not registered) |
| `wwan.currentNWserviceType` | network registration state (`serviceType`; `registered` derives from it). Seen: `LteService` (registered), `LimitedService` (cells seen, not allowed to register); `NoService` is treated the same |
| `wwan.roaming` | registered on a roaming network right now (`currentlyRoaming`) |
| `wwan.dataUsage.generic.dataTransferred` | bytes this billing cycle → GB |
| `wwan.profile.default` | active APN profile id |
| `wwan.profileList` | APN profiles (padded with a trailing `{}`) |
| `wwan.autoconnect` | `Never`/`Always`/`HomeNetwork`/`RoamNetwork` |
| `wwanadv.curBand` | e.g. `"LTE B7"` |
| `wwanadv.MCC` / `wwanadv.MNC` / `wwanadv.country` | network identity, shown in the APN view header |
| `wwanadv.radioQuality` | signal, 0-100% |
| `wwanadv.rxLevel` / `wwanadv.txLevel` | dBm |
| `wwan.signalStrength.{sinr,rsrp,rsrq,rssi,bars}` | live LTE radio measurements (`rscp`/`ecio` are 3G-only and read 0 on LTE) — `null` in `RouterStatus` when absent |
| `wwanadv.cellId` | serving cell id, shown as reported |
| `wwan.ca.SCCcount` | carrier-aggregation secondary cells bonded to the primary |
| `power.battChargeLevel` | 0-100% |
| `power.charging` | bool |
| `power.batteryState` | e.g. `"Normal"` |
| `sim.status` | `Ready`/`Locked`/`Blocked`/`NotPresent`/`InvalidCard`/`Failure`/`Rejected`/`MepLocked` |
| `sim.pin.mode`, `sim.pin.retry` | PIN state + retries left (3 when full) |
| `sim.puk.retry` | PUK retries left (10 when full) |
| `sim.iccid` | SIM identifier — used as the PIN-store key |
| `sim.SPN` | SIM operator name, e.g. `"Orange"` |
| `router.clientList.count` | connected LAN/WiFi clients, when present |
| `sms.msgs` | SMS message list (padded with a trailing `{}`) |
| `sms.msgCount`, `sms.unreadMsgs` | SMS counts |

`extension/src/netgear/fixtures/*.fixture.json` are hand-trimmed to exactly
these fields, with fake values substituted for anything identifying (operator
name, fake ICCID, fake sender numbers — the repo is public).

## Transport

Tinycast's `fetch`/`http` bridge has cookies disabled and unconfirmed
redirect + plain-HTTP/LAN behaviour (`.claude/skills/tinycast/SKILL.md`), so
`extension/src/netgear/transport.ts` shells out to the system `/usr/bin/curl`
instead, behind the `NetgearHttp` port interface:

- `-s -m 8 -L -c <jar> -b <jar>` — silent, 8s timeout, follow redirects,
  persistent cookie jar (`environment.supportPath`).
- Every secret value (admin password, SIM PIN, PUK, new PIN, APN password) is
  **never on the curl argv** (visible via `ps`): `postForm()`'s
  `secretFields` option writes a curl config to stdin (`-K -`), one
  `data-urlencode = "name=value"` line per secret field, with `\` and `"`
  backslash-escaped and newlines in a value rejected outright (they'd break
  the one-line-per-field format).

## Fake router

`extension/src/netgear/fake-router.ts` is an in-process `node:http` server that
mimics this API closely enough for the real `CurlNetgearHttp`: the
`/api/model.json` → 302 `/sess_cd_tmp` cookie dance, per-session `secToken` and
role (Guest hides `profileList`, `profile.default` and the Wi-Fi passphrase;
the Locked SIM hides `sim.iccid`), login (`session.password` → 204), the
`/Forms/profile` create/update/delete rules above (`access_control`, active
profile undeletable), `/Forms/config` connect/disconnect with timed
Connecting/Disconnecting (`wwan.connect=0` when not Connected and a connect
when not Disconnected are rejected), `wwan.autoconnect`,
`wwan.profile.default`, reboot (every request but the `/success.json`
redirect target drops the connection for the configured time; sessions are
cleared and a PIN-protected SIM comes back Locked), `sim.pin.entry`. Success →
302 `/success.json`; wrong token or a refused action → 302 `/error.json`
with the real non-JSON body. `/Forms/pinChange` and the PUK/PIN-lock/SMS
actions are not faked.

`fake-router.integration.test.ts` drives it with real curl in `make check`;
`make fake-router` serves it on `127.0.0.1:8188` (password `fake`) for
click-testing by pointing the `netgearHost` preference at it — the watchdog
reads the same preference, so it targets the fake too while that is set. See
AGENTS.md § Fake router.

## Signal: ratings and the Signal Meter

`netgear/signal.ts` (`rateSignal`) rates each LTE metric against the usual
rule-of-thumb bands (lower bound of each rating; below the last is poor):

| Metric | Excellent | Good | Fair | Poor |
|-|-|-|-|-|
| SINR (dB) | ≥ 20 | 13 – 20 | 0 – 13 | < 0 |
| RSRP (dBm) | ≥ −80 | −80 … −90 | −90 … −100 | < −100 |
| RSRQ (dB) | ≥ −10 | −10 … −15 | −15 … −20 | < −20 |

The **overall** verdict is the worst of SINR and RSRP. SINR is the decisive
metric — throughput and packet loss follow it, so it leads the headline
(`# Fair — SINR 4 dB`), carries the verdict alone when RSRP is missing, and is
what "best this session" ranks on — but a signal too weak to hold the link
(RSRP) never reads better than it is. RSRQ is rated and shown but never moves
the verdict (a ratio of the other two that swings with cell load). A missing
reading rates nothing; with neither SINR nor RSRP the view says "No LTE signal
reading".

The live 2026-10-06 reading (SINR −1 dB, RSRP −102 dBm, RSRQ −13 dB, tx 22 dBm,
LTE B1, ping 320 ms avg / 7.5 % loss) rates **poor**.

The **Signal Meter** (`signal-meter.tsx`) only ever reads: a guest `GET
/api/model.json` plus `/sbin/ping -c 4 -i 0.25 -t 3 1.1.1.1` through callback
`execFile` (ping exits non-zero on loss, the summary on stdout is parsed anyway,
`parsePingSummary`). Ticks every 2 s, skipped while the previous one runs;
history (last 60 samples, best SINR and when) lives in component state and is
gone on close.

## Unconfirmed / not attempted

- Whether re-logging in in a fresh session mid-way through a stale cookie
  jar behaves differently from a first login — not tested across restarts.
- Concurrent access (Tinycast + the device's own web UI open at once) —
  not tested. Watchdog vs. Tinycast UI is serialised by the action lock
  (above), but the lock is unit-tested against a tmp dir only, not across two
  real Tinycast processes; the device's own web UI is outside it.
- Firmware/model differences on a non-MR2100 Nighthawk — this reference is
  MR2100-specific (`general.model` in the fixture).
- Whether `wwan.connection` ever reports a value outside
  Connected/Disconnected/Connecting/Disconnecting — `flows.ts` treats
  anything else as transitional but this hasn't been observed live.
- `ensureRouterReachable()`'s single-rejoin-then-poll-20s shape and the
  watchdog's shortened per-tick timeouts (`scaledTimeouts()`) are unit-tested
  against a fake transport/clock only — not yet verified against the real
  router dropping off and rejoining Wi-Fi live, unlike the reboot-time rejoin
  loop above (verified 2026-09-27).

## Soft-reset levers (measured live 2026-10-04, healthy connection)

User-approved one-off test (`wwan.connection` polled every 1s). None of these
was tried on a *stuck* router in this test — only on a healthy one, to measure
the outage and confirm the request shape. **Later live evidence on a stuck
router (2026-10-05):** the data off → on toggle failed 2/2 on a router stuck
`Disconnected` (10:43 and 13:35; connect accepted, nothing happens,
`inactivityCause` 307); the reboot fixed both within ~3 min.

| Lever | Request (`/Forms/config`) | Observed |
|-|-|-|
| Re-apply active APN | `wwan.profile.default=<id>&wwan.profile.promptForApnSelection=false` | Accepted, **no effect** — stayed Connected, no redial. Not a reset. |
| Data off → on | `wwan.autoconnect=Never`, then `Always` | Disconnecting → Disconnected in ~4s (`inactivityCause` 307), Connecting → Connected ~4s after `Always`; internet back. **~9s outage.** Restore value must be `Always` (roaming). |
| Band region LTE All → Auto | `wwan.bandRegion.setIndex=2`, then `=0` (indices from `wwan.bandRegion[]`, padded with a trailing `{}`) | LTE All: stayed Connected. Back to Auto: re-registered, then **Connected with no internet for ~30s** before recovering on its own. Disruptive — not used automatically. |

The data toggle is the watchdog's **automatic step-2 lever** only for a router
that is Connected but has no internet (see § Watchdog: escalation ladder), run
once per stuck episode before the reboot; a router stuck Disconnected skips it
and reboots on the 2nd failed connect. The other two rows stay manual/unused.

`wwan.inactivityCause` stays at the last value after reconnecting (307 after
data off; 30456 seen after the band change) — log it, don't treat it as live
state.
