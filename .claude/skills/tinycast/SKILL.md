---
name: tinycast
description: How to build, install, update and debug a Raycast-format extension for Tinycast (macOS launcher, com.tinycast.app) — what its JS runtime supports and doesn't, install routes, menu-bar semantics, and troubleshooting. Use for any work in this repo's extension/ directory or general Tinycast/Raycast-extension questions.
agent: general-purpose
---

# Building for Tinycast

Tinycast (`https://tinycast.dev`, bundle `com.tinycast.app` stable /
`com.tinycast.app.beta` beta) runs Raycast extensions natively: same
`package.json` manifest, same `ray build` output, JS executed in
JavaScriptCore, UI drawn in SwiftUI. **There is no separate Tinycast SDK** —
you write a normal Raycast extension and install the built output.

**This repo targets the beta channel** (`com.tinycast.app.beta`,
`0.11.x-beta.N` = upstream `main`; installed 0.11.12-beta.109, latest
0.11.13-beta.111 as of 2026-10-05) — see § Designing for Tinycast beta. The
Homebrew cask lags (`brew info` still said 0.11.11-beta.107) because the app
self-updates; trust the app's `Info.plist`, not brew.
Sourced from `tinycast.dev` docs + the project's engineering spec
(`docs/features/extensions.md`) for general Raycast-format behaviour, and
directly from Tinycast's `main`-branch Swift source (via `gh api
repos/abue-ammar/tinycast/contents/<path>?ref=main`) for anything
render-size/layout-specific, compiled 2026-09-27, re-checked against commits
through 2026-10-05 (§ Changes since 0.11.10). **UNCONFIRMED** items are
flagged; check them again before relying on them for anything load-bearing.

## Install route used by this repo: "Add from folder"

Settings → Extensions → Install → **Add from folder** — points at an
already-built `ray build` output directory, never source. Tinycast does not
build it: `package.json`, the compiled `<command>.js` files, and `assets/`
are copied; **`node_modules` and source maps are never copied.**

```
make build   # ray build -e dist -o extension/build
```

then point "Add from folder" at `extension/build` — **once**.

**No dev mode, no hot reload, no watch.** Starting a command stops the
previous one and throws its JS engine away, and the command's JS is read from
the installed copy on every run. **Re-adding the folder does NOT update that
copy** (verified 2026-09-27), so updates go through `make deploy`: build, then
rsync `extension/build/` (minus source maps) straight into the installed
extension dir below. That is exactly what "Add from folder" copies.
New or renamed **commands** only appear after a Tinycast restart — the
manifest is scanned at launch (`ExtensionManager.refresh()` in
`Tinycast/Features/Extensions/Service/ExtensionManager.swift`), not per run
(verified 2026-10-05: `van-power` was deployed but absent until restart;
re-verified on `main` the same day: `refresh()` only runs at startup and after
install/uninstall/update actions, there is no file watcher, so `make deploy`'s
restart-on-manifest-change is still required).

Storage: extension code → `~/Library/Application Support/<bundle
id>/extensions/<name>/`; preferences/cache → `extension-data/<safe
name>.json`; `environment.supportPath` → `extension-support/<safe name>/`.
`<bundle id>` is `com.tinycast.app` (stable) or `com.tinycast.app.beta` (beta)
— separate apps, separate installs, never share settings.

## What works

- **Components**: `List`/`Grid`, `Detail` (+ `Metadata`), `Form` (all field
  types), `ActionPanel` (+ `Section`/`Submenu`), every `Action.*` convenience
  variant, `MenuBarExtra` (+ `.Item`/`.Section`/`.Submenu`).
- **Top-level APIs**: `Clipboard`, `LocalStorage`, `Cache`, `environment`,
  `getPreferenceValues`, `showToast`, `showHUD`, `confirmAlert`,
  `closeMainWindow`, `popToRoot`, `open`, `trash`, `showInFinder`,
  `getApplications`/`getDefaultApplication`/`getFrontmostApplication`,
  `getSelectedText`, `getSelectedFinderItems`, `launchCommand`,
  `updateCommandMetadata`, `openExtensionPreferences`, `useNavigation`,
  `OAuth` (Keychain-backed, own service `com.tinycast.extensions.oauth`),
  `Icon`, `Color`, `Image.Mask`.
- **`@raycast/utils` hooks** (`useFetch`, `usePromise`, `useCachedPromise`,
  `useLocalStorage`, …): **UNCONFIRMED** by name in any doc, but they're
  plain React built on `useState`/`useEffect`/`fetch`/`AbortController` —
  those primitives work, so the hooks work too. This extension already
  relies on them (`my-tasks.tsx`, `quick-add.tsx`).
- **Node built-ins**: `path`, `fs` (+ promises), `os`, `child_process`
  (`exec`, `execFile`, `execFileSync`, `spawn` with a real streaming child and
  pid), `crypto`, `zlib`, `http`/`https`, `stream`, `util`, `events`,
  `buffer`, `url`, `querystring`, `assert`, `timers`, `diagnostics_channel`.
`zlib` has `createGzip`/`createGunzip`/`createDeflate`/… as **buffered**
Transforms (compress on flush, not streaming; `ce7535c5`). `WebAssembly.compile`/
`instantiate` work (routed through the sync constructors, `ab9d0edf`).
`net`/`tls` load but
  throw on use. Every other built-in stubs-and-throws-on-use rather than
  failing to load.
- **Spawning a native helper with stdin** (verified against
  `Scripts/raycast-runtime/src/node-shims.js` on `main`, 2026-10-05): only
  `spawn` returns a child with a usable `stdin` — writes are buffered and the
  child starts on `stdin.end()` (or a microtask), then `stdout`/`stderr`
  deliver the whole output at exit followed by `close`. The callback-style
  `execFile`/`exec` handle has **no `stdin`** (it takes an `input` option
  instead, which real Node ignores), so code that must run under both vitest
  and Tinycast uses `spawn` + `stdin.end(data)`. `van/run.ts` does this to pass
  the Victron key without putting it in argv. A binary shipped in `assets/` is
  reachable at `path.join(environment.assetsPath, "<name>")`; `van-ble`
  is a bare binary, not an `.app`, on the premise that Tinycast Beta is the
  TCC-responsible process for Bluetooth (UNCONFIRMED until the first in-app run).
- **Menu-bar commands**: full lifecycle — activation on first manual run or
  "Show in menu bar", `interval` (10s floor for menu-bar, 60s for `no-view`),
  own transient JS engine per session, `updateCommandMetadata` for launcher
  subtitle updates. See *Menu-bar: stable vs. beta* below — this repo's two
  menu-bar commands need the **beta** channel until Tinycast's native
  rendering ships to stable.

## What doesn't work

| Gap | Detail |
|-|-|
| `AI`, `BrowserExtension`, `WindowManagement` | Import works, calling throws |
| Raycast's OAuth proxy (`oauth.raycast.com`) | `OAuth.PKCEClient` itself works |
| Cancelling an in-flight `fetch` | Caller gets `AbortError`; the request runs to completion server-side anyway |
| Streaming HTTP (SSE, download progress, backpressure) | Bridge delivers the whole body at once |
| `net` / `tls` | Resolve, throw on use |
| A WebSocket to a cert macOS distrusts | `rejectUnauthorized:false` is ignored — the chain is always validated |

### `fetch` — the parts that matter for this repo

- **Cookies: disabled** on the `fetch`/`http` bridge — this is why
  `netgear/transport.ts` shells out to the system `curl` instead: the Netgear
  MR2100's session auth is cookie-based (see `docs/netgear-m2.md`).
- **Redirect handling and plain `http://`/LAN requests: UNCONFIRMED.** No
  fetched doc states whether ATS blocks non-TLS traffic, or how `fetch`
  handles a 302. Don't assume either way — this is the other reason the
  Netgear client uses `curl -L` rather than `fetch`.
- `.local`/mDNS names resolve.

## Designing for Tinycast beta (target renderer)

**This repo targets the beta channel** (`0.11.10-beta.x`, tracks upstream
`main`) — install `abue-ammar/tinycast/tinycast@beta`
(`com.tinycast.app.beta`), not stable. Verified by reading Tinycast source
straight off `main` (`gh api repos/abue-ammar/tinycast/contents/<path>?ref=main`):
`Tinycast/DesignSystem/Theme.swift`, `InterfaceMetrics.swift`,
`Features/Extensions/UI/{ExtensionDetailView,ExtensionListView,
ExtensionMenuBarImage}.swift`, `Features/Extensions/Model/ExtensionImageSize.swift`,
`Features/Settings/InterfaceSize.swift`, 2026-09-27.

- **Window is 750×475 at `interfaceSize: standard`** (`Theme.Size.panelWidth/
  panelHeight`) — every extension in this repo is designed for that, not
  `larger`. `interfaceSize` is a uniform `scale` factor (`standard`=1,
  `large`=1.1, `larger`=1.2) applied to nearly every UI constant via
  `metrics.scaled()`, so the window and every sidebar/list-column width grow
  together — but a markdown image's `?raycast-width=`/`raycast-height=`
  hint is **not** scaled (`ExtensionImageSize` parses it as a raw point
  value), so a hero sized for `standard` renders too small at `larger`.
  Design for `standard`.
- **List column is 290pt** wide when a `List` has `isShowingDetail`
  (`ExtensionListView.detailListWidth`). Its detail pane **stacks
  `Detail.Metadata` below the markdown**, not beside it
  (`ExtensionDetailBody(stacksMetadata: true)`) — the opposite of a plain
  `Detail`.
- **A plain `Detail`'s `Detail.Metadata` sidebar is still 240pt** fixed
  (`ExtensionDetailView.metadataWidth` — unchanged from stable). With no
  metadata, the markdown pane is the full content width minus
  `2×Spacing.lg` (10pt each side) ≈ 730pt at 750-wide `standard`; with
  metadata it's ≈ 489pt. **This repo drops the sidebar on every Detail
  command** once its hero images carry the numbers a sidebar used to (see
  `docs/architecture.md` § Metadata) — full width is the point.
  `extension/src/lib/svg.ts`'s `HERO_COL_WIDTH` (720) is the conservative
  design width every hero targets.
- **No 220pt image height cap** (unlike stable 0.11.3). A markdown image
  draws at its own intrinsic size (the SVG's `width`/`height` attributes) —
  or, if the URL carries a `?raycast-width=&raycast-height=` hint, is fit
  (shrunk or grown, `.aspectRatio(.fit)`) into that box
  (`ExtensionMarkdownImage` in `ExtensionDetailView.swift`,
  `ExtensionImageSize.swift`). `lib/svg.ts`'s `toDataUri()` always appends a
  hint matching the SVG's own declared size — a defensive pin, not strictly
  required, but it means the render size is never ambiguous. **Design every
  hero's SVG canvas width ≤ `HERO_COL_WIDTH` so it never needs to shrink**
  (`computeImageScale`/`assertLegible` in `lib/svg.ts`, enforced by
  svg.test.ts's "Hero image legibility" block).
- **Markdown tables render as a real `Grid`**, header row shaded, borders
  drawn (`ExtensionMarkdownView.Block.table` in `ExtensionDetailView.swift`)
  — the opposite of stable 0.11.3 (plain text). Use a table wherever it
  beats a bullet list: this repo's battery/netgear/speed-test "extra
  fields" tables and speed-test's history table.
  - **Zero-width columns are how this repo fakes a "no header" table**:
    `| | |` / `|-|-|` then `| Label | Value |` rows — the parser (
    `ExtensionMarkdownView.parse`) treats row 0 as the header (bold,
    shaded) regardless of content, so an empty header row keeps every
    row plain.
- **Images render only when alone on their own line**, with an `http(s)` or
  `data:` URI — a local path or `file://` is silently dropped. `![alt](url)`
  on its own markdown line, nothing else sharing it. Since `48feadab`
  (0.11.13-beta.111) a standalone `<img src="…">` tag line works too
  (`standaloneImageURL`, same scheme rule); other HTML is still not rendered.
- **`data:image/svg+xml;base64,…` is the only adaptive image path.**
  Tinycast decodes it via `NSImage` after a whole-word text substitution of
  `raycast-*` colour names to the live theme's CSS colour — literally
  `fill="raycast-primary-text"` in the SVG source becomes
  `fill="rgba(255,255,255,1)"` (or the dark/light equivalent) before
  decoding. The nine names it rewrites: `raycast-primary-text`,
  `raycast-secondary-text`, `raycast-red`, `raycast-orange`,
  `raycast-yellow`, `raycast-green`, `raycast-blue`, `raycast-purple`,
  `raycast-magenta`. Use only these as fill/stroke values in any inline SVG
  you build (`extension/src/lib/svg.ts` and `lib/chart/` do this everywhere) — a raw hex
  value never adapts to light/dark. A per-command **icon PNG asset**
  (`package.json`'s `icon`, `assets/*.png`) is a different code path (loaded
  as a file, not inline `data:`) and does **not** get this substitution — use
  plain hex there, since the icon is a static badge, not theme-adaptive
  chrome.
- **Gradients and opacity survive the rewrite** (verified 2026-10-05 against
  `ExtensionIconCache.rewritingNames` on `main` and by decoding real SVGs through
  `NSImage(data:)`): the substitution is a whole-word text replace over the
  **entire SVG source**, not only `fill`/`stroke`, so `<linearGradient>` stops with
  `stop-color="raycast-blue"` (attribute or `style="stop-color:…"`), `stop-opacity`,
  `fill-opacity` and `stroke-opacity` all render, in dark and light. Each token
  becomes `rgba(r,g,b,a)` and carries its own alpha (`raycast-primary-text` 0.847,
  `raycast-secondary-text` 0.6, system colours 1.0), which the opacity attributes
  multiply — keep opacity a separate attribute. `fill/stroke="transparent"` becomes
  `none`. CoreSVG quirk: strokes and circles whose colour reads `rgba(…,1)` (integer
  alpha) are silently not drawn; Tinycast prints `1.0`, so any preview palette must
  too. `lib/svg.ts`'s gradients (`fadeGradient`) rely on this; the preview loop
  (`make previews ARGS="--coresvg"`) renders through the same decoder. See
  `.claude/skills/svg-charts/SKILL.md`.
- **Appearance flips re-render an image that is already on screen** (verified
  2026-10-05 against `ExtensionMarkdownImage` in `ExtensionDetailView.swift` and
  `docs/features/extensions.md` § Appearance on `main`): the image's `.task` is
  keyed on `ExtensionImage.LoadKey(source:isDark:)` with `isDark` from
  `\.isDarkAppearance`, and the `raycast-*` palette is resolved *at decode*, so
  switching macOS light/dark re-decodes every inline SVG with the other palette
  without any JS. Nothing to wire — **just never branch on
  `environment.appearance` in JS**: it is injected at boot ("a running command keeps
  the appearance it booted with"), so a hex or a JS-side pick would stay stale; the
  tokens are the only thing that follows the surface. Also from that file: a
  markdown image is clipped to a rounded rect (`metrics.radius.menu`) and its
  placeholder is `ExtensionColors.detailCardFill` (white/black at 4–5 %) — the
  translucent card look the hairline panels are designed against.
- **`Detail.Metadata`**: `Label` (+icon), `TagList` (coloured tags),
  `Link`, `Separator` all render as documented. **List accessories**: icon,
  coloured tag/text, date, tooltip. **`Grid`**: `columns` 1–8, `aspectRatio`,
  and tile content scales — including a `data:` SVG, which is how
  `hub.tsx`'s dashboard tiles work (a Grid tile's sizing is unrelated to the
  Detail column-width rule above — `Grid.Item.content` scales to the grid
  cell, not a markdown column).
- **`Icon.*` maps to SF Symbols** — a bare SF Symbol string (`"gauge"`) does
  not work as an icon value, only the `Icon` enum. A per-command `icon` in
  `package.json` must be an asset file under `assets/`.
- **`MenuBarExtra` renders natively** on beta (`NSStatusItem`, confirmed via
  `ExtensionMenuBarImage.swift`) — an `icon` fits into an 18×18pt glyph
  (`.aspectRatio(.fit)`, rendered at 2x for Retina internally, so any SVG
  canvas works — nothing reads as text at that size, keep menu-bar icons to
  a simple shape). `claude-usage-menu-bar.tsx` uses `lib/svg.ts`'s
  `menuBarRing()` — a small filled-arc gauge, no text — for a live
  quota-reflecting icon, and keeps `title` to just the 5h number now that a
  status-item title costs real menu-bar space.

### Stable 0.11.3 differences (if this repo is ever reinstalled there)

- **220pt image height cap**, and images always fill the column width —
  neither `HERO_COL_WIDTH` sizing nor `?raycast-width=` hints apply the same
  way; every hero would need re-tuning.
- **Markdown tables render as plain text**, not a grid — every `| |` table
  in this repo would need to fall back to a bullet list.
- **`MenuBarExtra` doesn't render at all** — `ticktick-menu-bar` and
  `claude-usage-menu-bar` need `0.11.4-beta.100`+ (see § Menu-bar below);
  their ring/dot icons and compact titles are simply invisible on stable.
- **List detail pane width is 220pt**, not 290pt; `Detail.Metadata` sidebar
  is 240pt on both channels (unchanged).

## Changes since 0.11.10 (verified against `main` commits, 2026-10-05)

- **Menu-bar items stay off until the user enables them** (`5d357d49`): only a
  `UserInitiated` launch of a menu-bar command activates it; a background
  `launchCommand`/`?launchType=background` only refreshes one already shown. A
  render settling after a host call also gets +50 ms to commit, so a final `null`
  render hides the item.
- **Extension toasts are a glass pill in the footer** (`0b7e5684`), not rows; a new
  toast **replaces** the current one (`toasts = [stamped]`, `ce7535c5`) so a finished
  task's success clears its animated spinner; a long title truncates (`9e3dc701`).
  Failure toasts get a Copy button. Only one toast is visible at a time.
- **`List`/`Grid` `throttle`** now debounces `onSearchTextChange` by 300 ms
  (`b9fd2703`).
- **Child-process hang fixed** (`6fc6aa1b`, in 0.11.10-beta.106): ~3% of `execFile`
  calls never settled (`waitUntilExit` on a GCD thread missed the exit). Our
  `curl`/`batt`/`ioreg`/`networkQuality` calls benefit; stuck-forever symptoms
  before beta.106 may have been this.
- Runtime: `diagnostics_channel`, `Event`/`EventTarget`/`MessageChannel`,
  `crypto.getHashes` (`0f253d57`); a title given as `{ value, tooltip }` reads
  (`be5cba91`). Launcher result-row icons use a new `resultRowIcon` size
  (`f507b4ac`) — our command icons render slightly differently, no action.
- TCC: `Info.plist` still declares `NSBluetoothAlwaysUsageDescription` (installed
  beta.109 checked; wording says "only when you run the Toggle Bluetooth action"
  — Tinycast's own text, harmless for the prompt) and gained
  `NSRemindersFullAccessUsageDescription` (`3bd70383`). Nothing removed.
- Settings: opt-in `settings.json` mirror of preferences (`1d7d2266`, beta.106),
  "Install from GitHub" (builds a repo link, `4935e937`), option to disable
  automatic update checks (`2c9b4459`, beta.111 — useful to pin a beta).
- **Unchanged** (no commits touching them since 2026-09-27): `ExtensionIconCache`
  (`raycast-*` rewrite), `ExtensionMenuBarImage`, Detail metadata/width rules,
  image sizing, deeplink handling (`ExtensionLink`), background refresh policy.

## Fast access: deeplinks, hotkeys, aliases, favorites

- **Deeplinks**: `tinycast://extensions/<owner>/<ext>/<cmd>` — `<owner>` is
  optional for a locally-installed extension. Query params:
  `?arguments=<json>` (pre-fills a command's declared arguments),
  `?launchType=background` (runs a `no-view`/menu-bar command without
  opening the launcher).
- **Per-command hotkeys** are stored in Tinycast's own preferences as
  `hotkey.extensionCommand.extension:<ext>/<cmd>`, and the command must also
  be listed in `boundExtensionCommandEntryIDs` for the binding to take
  effect — setting only the hotkey key is not enough.
- **Aliases**: `launcherAliases`, a map of `{"extension:<ext>/<cmd>":
  "<alias>"}` — typing the alias in the launcher jumps straight to that
  command.
- **Favorites**: `favoriteApps` — up to 10 entries, bound to `⌘1`…`⌘0` when
  the launcher's query is empty (no typing yet).
- **`interfaceSize`**: `standard` | `large` | `larger` — a Tinycast-level
  setting (not per-extension) that changes the window size described above.

For this repo, `<ext>` is `jkrumm` and `<owner>` is the local install (can be
omitted); e.g. `tinycast://extensions/jkrumm/hub` or
`extension:jkrumm/claude-usage` as the key for hotkeys/aliases/favorites.

## Menu-bar: stable vs. beta

Public docs and the engineering spec describe menu-bar commands as fully
shipped, but the exact version that added **native SwiftUI rendering** of a
menu-bar command is `0.11.4-beta.100` (PR #963) — **stable 0.11.3 ships the
JS shims only.** Until 0.11.4 reaches stable (stable self-updates daily —
check the installed version before assuming), you need:

```bash
brew install --cask abue-ammar/tinycast/tinycast@beta
```

This installs `Tinycast Beta.app` (`com.tinycast.app.beta`) — a fully
separate app, its own settings, side-by-side with stable. Channels never
cross; `brew upgrade` never touches either (both self-update via GitHub
Releases polling).

## Preferences, arguments, interval

- Preference types: checkbox, dropdown, textfield, password, file/folder
  picker, app picker — declared in `package.json`, native controls in
  Tinycast's UI, cleared on uninstall.
- **Every declared argument is sent as `""` when left blank — never
  `undefined`.** `Number(args.x)` is `0` for `""` but `NaN` for `undefined`;
  don't rely on `undefined`-check patterns for arguments.
- `interval` on a `no-view`/`menu-bar` command: off by default until run once
  or toggled on in Settings → Extensions → command → Background refresh.
  Floor is 60s (`no-view`) / 10s (`menu-bar`). No toasts/HUD during a
  background run — only `updateCommandMetadata` can surface state.
- **One JS runtime — background ticks never run beside a foreground command**
  (verified against `main`, 2026-10-07; all `Features/Extensions/Service/
  ExtensionManager.swift`): `runDueBackgroundCommands` bails on
  `running == nil` (`:639-640`, again per command at `:655`, `:662`,
  `runInBackground` at `:681`), and launching a foreground command first calls
  `abortBackgroundRun()` (`:430`, defined `:764` — "a background tick in flight
  yields to the manual run", ended as a success so the schedule survives). A
  foreground session ends only on Escape (`UI/ExtensionCoordinator.swift`
  `exitExtensionScreen` `:219` / `popExtensionToRoot` `:228`) or when the
  palette switches mode (`Palette/RootPaletteView.swift` `onChange`) — merely
  hiding the Tinycast window leaves it running. Consequence: an interval
  command goes silent for as long as any command view stays open (seen
  2026-10-07: Netgear view open, `netgear-watchdog` quiet for hours). Anything
  that must keep ticking must also run from the open view — this repo's
  `netgear.tsx` does (`netgear/watchdog-runner.ts` + `startViewTicker`).

## Debugging

**`console.log`/`console.error` are dead in the shipped app** — they're
`#if DEBUG` print statements, compiled out of the release build
(`ExtensionManager.swift:785-789`). `log show` shows nothing; there is no
end-user log viewer. Confirmed state surfaces instead:

- **Background command metadata** (subtitle, `backgroundEnabled`, `lastRun`
  — seconds since the Apple reference date 2001-01-01, `lastError`,
  `consecutiveFailures`, `menuBarSnapshot`) lives in
  `~/Library/Application Support/com.tinycast.app.beta/extension-commands.json`,
  keyed by extension then command (`ExtensionCommandMetadataStore.swift`).
  **Failures back off exponentially**: next run = `interval × 2^consecutiveFailures`,
  capped at 24 h (`ExtensionRefreshPolicy.effectiveInterval`) — 10 failed
  1-minute ticks park a command for ~17 h, and fixing + deploying the code
  does not wake it. A manual/deeplink run (`?launchType=background`) does
  **not** reset the counter; only a successful scheduled run or toggling
  Background Refresh off/on (`clearBackgroundError`) does. Fastest reset:
  quit Tinycast Beta, set `consecutiveFailures` to 0 in that JSON, relaunch
  (seen 2026-10-02 after the `fs/promises.open` crash).
- **`LocalStorage`/`Cache`** are real, persisted (debounced 250ms writes) to
  `extension-data/<safe-name>.json` under the same app-support dir, as
  `localStorage`/`caches` (sha1-keyed)/`preferences`/`accessoryValues`
  (`Service/ExtensionStorage.swift`). A `localStorage` value is sometimes a
  raw string and sometimes wrapped as a Swift enum's JSON encoding,
  `{"string":{"_0":"<json>"}}` — handle both.
- The launcher row's warning icon/tooltip on a failed background run, and
  Settings → Extensions → command → last refresh time + last error.

**Real screenshots are the verification loop for anything visual** (previews are
rsvg, not Tinycast; the window is translucent and only ~420 pt of content is above
the fold). After `make deploy`:

```bash
scripts/screenshot.sh <command> [wait-seconds] [out-name]   # → /tmp/shots/<out-name>.png
# = open "tinycast://extensions/jkrumm/jkrumm/<command>"; sleep; screencapture -x;
#   sips crop to the (horizontally centred) Tinycast window; sips -Z 1600
```

then `Read` the PNG. Use ~6 s of wait (van-power ~10 s: the live BLE read plus the
hourly Victron history). It judges the **above-the-fold** composition, in whatever
appearance the Mac is in (don't toggle it — check the other one with `make previews`
and `--coresvg`); the window can't be scrolled without accessibility permission, so
judge below the fold on the full-page mocks (`/tmp/tinycast-previews/page-*.png`).
A command that talks to hardware on open (netgear: the router, with its auto-unlock)
is not screenshotted by script — use `make e2e` and the previews there. Take the
"before" shot first and keep it (`out-name` it `…-before`).

**`make status`** (`scripts/tinycast-status.py`, stdlib-only) reads all of
the above for the `jkrumm` extension: every command's metadata, the
`netgear-watchdog` LocalStorage event log (last 20, local time), LocalStorage
key sizes, the speed-test history count, and a sha1 deployed-vs-built check
against `extensions/jkrumm/` — the same drift `make deploy` is supposed to
prevent. It never prints `preferences` (may hold secrets). `make status`
reads the *real, installed* extension's state; `make e2e`/`make e2e-live`
(next section) instead prove a command *renders* correctly before it's ever
installed — run the failing command through `make e2e` first, `make status`
second, to tell "it never rendered right" apart from "it rendered right but
drifted after deploy".

**The breadcrumb pattern this repo uses for a background command**:
`updateCommandMetadata({ subtitle })` after every run for a one-line status
visible in the launcher, plus an append-only event log in `LocalStorage`
(newest-first, capped) for a real history — `netgear-watchdog.tsx` +
`netgear/watchdog-storage.ts` are the reference implementation, and
`netgear.tsx`'s "Watchdog Log" action reads that same log back into a
`Detail`. Follow this pattern for any new `no-view`/background command
for the *routine* history. For anything an agent or the user must be able
to read afterwards (what an action actually did, the raw error), also append
to the extension's own log file — `lib/action-log.ts` →
`netgear.log` (below).

**The extension's own log file is the log surface** since `console.log` is
dead. `lib/action-log.ts` (`appendLogLine`/`readLogTail`, pure sync `fs`,
swallows its own errors, rotates to `.1` at 512 KB) writes one line per event to
`<environment.supportPath>/netgear.log`, i.e.
`~/Library/Application Support/com.tinycast.app.beta/extension-support/jkrumm/netgear.log`.
`make logs` tails it, `make status` prints its last 25 lines, and the
Netgear command's "Show Netgear Log" action (cmd+shift+L) renders the last 80.
New background/long-running code should log through `session.ts`'s
`logNetgear()` (or call `appendLogLine` with its own path) rather than invent
another surface.

**Only the fs functions Tinycast's node shim implements exist** (verified
against `Scripts/raycast-runtime/src/node-shims.js` on Tinycast's `main`).
`fs`: `openSync closeSync readSync writeSync readFileSync writeFileSync
appendFileSync existsSync statSync lstatSync readdirSync mkdirSync rmSync
rmdirSync unlinkSync renameSync copyFileSync realpathSync accessSync
mkdtempSync chmodSync`; `fs/promises`: `readFile writeFile appendFile stat
lstat readdir mkdir rm rmdir unlink rename copyFile realpath access mkdtemp
chmod`. Anything else (e.g. `fs/promises.open`) passes vitest on real Node and
throws "x is not a function" only once deployed — that took down every
watchdog tick and admin action on 2026-10-01. `src/lib/tinycast-runtime.test.ts`
pins every non-test named `fs`/`fs/promises` import to that list; keep it
green and never dodge it with `import * as fs` or a default import.

Practical loop: run the pure logic under `vitest` first (`make test`) —
everything under `ticktick/`, `usage/`, and `netgear/` that doesn't import
`@raycast/api` is unit-tested outside Tinycast entirely. Then `make e2e`
(below) mounts the command entry files themselves — the one thing a real
install used to be the only way to exercise. A real install/`make deploy` is
now only for the Swift-renderer layer neither `make test` nor `make e2e`
touches (does it *look* right on screen).

**`@raycast/api` and `@raycast/utils` are types-only packages** — their
`package.json` declares no `main`/`module`/`exports`, only `types`. An import
of either (even transitive) can't be resolved by plain Node/vitest — this is
still why `usage/aggregate.ts` exists separately from `usage/spend.ts` (the
pure aggregation logic must not import `../lib/argo`, which imports
`@raycast/api`): keep that split for new pure logic even though it's no
longer strictly required for vitest to run. Both `vitest.config.ts` (unit)
and `vitest.e2e.config.ts` (e2e) now alias both packages to fakes under
`src/e2e/` (`raycast-fake.tsx`, `raycast-utils-fake.tsx`) precisely so a
command entry file — which *does* need `@raycast/api` — can be mounted and
its hooks/effects actually run (via `react-test-renderer` + `act()`, not
jsdom). See AGENTS.md § End-to-end render harness for the full picture and
`make e2e`/`E2E_LIVE=1 make e2e-live`.

## Rendering capabilities & limits

Verified against `gh api repos/abue-ammar/tinycast/contents/<path>?ref=main`,
2026-09-27.

- **Markdown is a hand-rolled parser**, not a full renderer: headings
  `#`-`####`, lists, a single-level blockquote, rules, fenced code blocks (no
  syntax highlighting), pipe tables, and inline bold/italic/links. **No
  HTML.** A standalone image (`http(s)`/`data:` only) must be alone on its
  own line — see § Designing for Tinycast beta above for the table/image
  specifics.
- **Every component open is a cold `JSContext`** — no state, no module
  cache, no closures survive between opens (`ExtensionRuntime.swift:333-347`).
- **Detail/List/Grid have no loading chrome of their own**: `Detail` shows
  the literal text "Loading…" only when `markdown` is an empty string
  (`ExtensionDetailView.swift:29-31`); `List`/`Grid` only change their
  empty-state text while `isLoading` (`ExtensionListView.swift:37-41`).
  There is no spinner overlay — see § Loading & performance below.
- **Inline `data:` images are never cached** and re-decode (off-main) every
  time the data-URI string changes (`ExtensionIconCache.swift:57-66`); an
  unchanged string is a no-op re-render, not a re-decode
  (`ExtensionDetailView.swift:492`).
- **SVG is rendered via `NSImage`/ImageIO** — no SMIL or CSS animation.
  Filter support (`<feGaussianBlur>` etc.) is unconfirmed; assume none.
- **`Detail.Metadata`**: `Label` (+icon), `TagList` (coloured tags), `Link`,
  `Separator` all render as documented. **List accessories**: icon, coloured
  tag/text, date, tooltip. **`Grid`**: `columns` 1-8, `aspectRatio`, `fit`,
  `inset` all apply, tile content (including a `data:` SVG) scales to the
  cell.
- **Menu-bar commands repaint a persisted snapshot before their JS runs** —
  the icon/title from the last successful render shows immediately on
  reopen, not a blank state (`ExtensionMenuBarManager.swift:86-87, 368`).

## Loading & performance

No component shows a spinner while a promise resolves (see above), so a bare
`usePromise` paints a blank Detail/List/Grid on every cold open — every
command that loads data uses `useCachedPromise` (`@raycast/utils`) instead:
the last successful result is persisted (see § Debugging) and paints
instantly, then a background revalidation runs. Pattern used throughout this
repo:

```ts
const { data, isLoading, revalidate } = useCachedPromise(loadThing, [], {
  keepPreviousData: true,
});
```

- **The loaded value must be JSON-serialisable** (no class instances, no
  `Error` — an error is surfaced separately, not cached) and must not carry
  secrets.
- **Any effect that reacts to the data must gate on `!isLoading`**, not just
  "data is present" — cached data renders before the real fetch returns, so
  an effect keyed only on `data` fires against stale state first.
  `netgear.tsx`'s SIM auto-unlock effect is the reference: it no-ops while
  `isLoading` is still true, and only arms its once-per-mount ref once a
  fresh, non-loading status has been seen.
- **On a `Detail` command, show a `_Updating…_` markdown line** while
  `isLoading && data` (a stale-but-present result is revalidating) — keep it
  as the very last line so it never reshuffles the hero images above it (see
  the data-URI re-decode cost above; unrelated block reordering would change
  nothing about the images themselves, but a moving text block still causes
  a visible reflow). `List`/`Grid` need no equivalent — their `isLoading`
  flag already does the right thing.
- **Memoize hero SVG/markdown construction with `useMemo` keyed on the
  loaded data** (and `isLoading` for the trailing line above) so an
  unchanged number produces a byte-identical data URI and Tinycast's
  no-op-on-unchanged-string path applies — never bake a timestamp into a
  hero SVG.

## `ray lint` and the Store checks

`ray lint`'s package.json validation always calls the live
`https://www.raycast.com/api/v1/users/<author>` endpoint to verify the
`author` field is a real raycast.com account — **`--relaxed` does not skip
this** (confirmed in `@raycast/api`'s bundled CLI: `skipOwner` is hardcoded
`false` in the `lint` command; only the separate `ray validate --skip-owner`
command exposes a bypass). For a personal extension never published to the
Store it fails permanently, so `make lint` runs eslint + prettier directly
instead — the rest of what `ray lint` does. Icon must be a real 512×512 PNG regardless of
`--relaxed` unless it's set.

## Sources

- `https://tinycast.dev` public docs (`website/content/docs/extensions/*.md`)
- `docs/features/extensions.md` (Tinycast's own engineering spec — more
  detail than the public site, used where the two disagree, e.g. the
  WebSocket compatibility-page-vs-engineering-doc mismatch)
- `gh api repos/abue-ammar/tinycast/releases` for channel/version facts
