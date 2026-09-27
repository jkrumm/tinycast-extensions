# tinycast-extensions

Personal [Tinycast](https://tinycast.dev) extension — one Raycast-format
extension (`extension/`, manifest `jkrumm`) covering TickTick tasks, Claude
usage, a Netgear Nighthawk M2 mobile router, MacBook battery, and network
speed. MacBook-only.

## Commands

| Command | Mode | Description |
|-|-|-|
| Tasks | view | TickTick tasks, grouped by due date, full actions, toggleable detail pane |
| Add Task | view | Natural-language quick add |
| TickTick | menu-bar | Overdue + today count |
| Claude Usage | view | Quota rings + spend charts, detail |
| Claude Usage | menu-bar, 5m | Quota + spend summary |
| Netgear Nighthawk | view | MR2100 status, connected devices, SMS, connection/SIM/reboot actions |
| Battery | view | Charge, health, charge-limit control |
| Speed Test | view | networkQuality download/upload, latency, data used, history |
| Dashboard | view | Grid overview tile per command |

## Setup

```bash
make install   # bun install --frozen-lockfile
make build     # ray build -e dist -o extension/build
make secrets   # pre-seed Keychain from 1Password (one biometric pass)
```

First install only: Tinycast → **Settings → Extensions → Install → Add from folder** →
`extension/build`. After that, every change is `make deploy` (re-adding the
folder does not update the installed copy).

Preferences (Settings → Extensions → jkrumm): `baseUrl` (argo proxy),
optionally `defaultProjectId`, `netgearHost`. `apiToken`/`netgearPassword`
are **overrides only** — leave them blank and the extension resolves both
from macOS Keychain, then 1Password (`apiTokenRef`/`netgearPasswordRef`),
caching the result so 1Password is only ever asked once. See
`AGENTS.md` § Secrets.

## Development

```bash
make check   # tsc --noEmit + eslint + prettier + vitest
make test    # vitest only
make icons   # regenerate command icon PNGs from assets/src/*.svg
```

See `AGENTS.md` for the full layout, data sources, secrets flow, and safety
notes (never trigger a Netgear action from a test or script).
