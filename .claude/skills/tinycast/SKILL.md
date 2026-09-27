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
`0.11.10-beta.x` = upstream `main`) — see § Designing for Tinycast beta.
Sourced from `tinycast.dev` docs + the project's engineering spec
(`docs/features/extensions.md`) for general Raycast-format behaviour, and
directly from Tinycast's `main`-branch Swift source (via `gh api
repos/abue-ammar/tinycast/contents/<path>?ref=main`) for anything
render-size/layout-specific, compiled 2026-09-27. **UNCONFIRMED** items are
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
  `buffer`, `url`, `querystring`, `assert`, `timers`. `net`/`tls` load but
  throw on use. Every other built-in stubs-and-throws-on-use rather than
  failing to load.
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
  `extension/src/lib/svg.ts`'s `HERO_COL_WIDTH` (680) is the conservative
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
  on its own markdown line, nothing else sharing it.
- **`data:image/svg+xml;base64,…` is the only adaptive image path.**
  Tinycast decodes it via `NSImage` after a whole-word text substitution of
  `raycast-*` colour names to the live theme's CSS colour — literally
  `fill="raycast-primary-text"` in the SVG source becomes
  `fill="rgba(255,255,255,1)"` (or the dark/light equivalent) before
  decoding. The nine names it rewrites: `raycast-primary-text`,
  `raycast-secondary-text`, `raycast-red`, `raycast-orange`,
  `raycast-yellow`, `raycast-green`, `raycast-blue`, `raycast-purple`,
  `raycast-magenta`. Use only these as fill/stroke values in any inline SVG
  you build (`extension/src/lib/svg.ts` does this everywhere) — a raw hex
  value never adapts to light/dark. A per-command **icon PNG asset**
  (`package.json`'s `icon`, `assets/*.png`) is a different code path (loaded
  as a file, not inline `data:`) and does **not** get this substitution — use
  plain hex there, since the icon is a static badge, not theme-adaptive
  chrome.
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

## Debugging

**No documented end-user log viewer.** For a shipped Tinycast.app running an
installed extension, where `console.log`/`console.error` output lands is
**UNCONFIRMED** — no Console.app subsystem name or log file path is
documented anywhere public. The only confirmed surface is Settings →
Extensions → command → last refresh time + last error (background refresh
only), and the launcher row's warning icon/tooltip on a failed background
run.

Practical loop for this repo: run the pure logic under `vitest` first
(`make test`) — everything under `ticktick/`, `usage/`, and `netgear/` that
doesn't import `@raycast/api` is unit-tested outside Tinycast entirely. Only
the six command entry files (`src/*.tsx`) need a real install to exercise.

**`@raycast/api` and `@raycast/utils` are types-only packages** — their
`package.json` declares no `main`/`module`/`exports`, only `types`. Anything
that imports them (even transitively) cannot be resolved by vitest/vite —
this is why `usage/aggregate.ts` exists separately from `usage/spend.ts`: the
pure aggregation logic must not import `../lib/argo` (which imports
`@raycast/api`) or its tests break with "Failed to resolve entry for package
@raycast/api". Keep this split when adding new testable logic.

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
