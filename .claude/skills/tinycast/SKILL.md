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

Sourced from `tinycast.dev` docs + the project's engineering spec
(`docs/features/extensions.md`), compiled 2026-09-27. **UNCONFIRMED** items
are flagged; check them again before relying on them for anything load-bearing.

## Install route used by this repo: "Add from folder"

Settings → Extensions → Install → **Add from folder** — points at an
already-built `ray build` output directory, never source. Tinycast does not
build it: `package.json`, the compiled `<command>.js` files, and `assets/`
are copied; **`node_modules` and source maps are never copied.**

```
make build   # ray build -e dist -o extension/build
```

then point "Add from folder" at `extension/build`.

**No dev mode, no hot reload, no watch.** Starting a command stops the
previous one and throws its JS engine away. Re-run `make build` after every
change. Whether re-running "Add from folder" on the same path updates the
extension in place, or needs an uninstall first, is **UNCONFIRMED** — if a
change doesn't seem to take, uninstall and re-add.

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
