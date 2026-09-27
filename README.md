# tinycast-extensions

Personal [Tinycast](https://tinycast.dev) extension — one Raycast-format
extension (`extension/`, manifest `jkrumm`) covering TickTick tasks, Claude
usage, and a Netgear Nighthawk M2 mobile router. MacBook-only.

## Commands

| Command | Mode | Description |
|-|-|-|
| Tasks | view | TickTick tasks, grouped by due date, full actions |
| Add Task | view | Natural-language quick add |
| TickTick | menu-bar | Overdue + today count |
| Claude Usage | view | Quota utilization + argo spend detail |
| Claude Usage | menu-bar, 5m | Quota + spend summary |
| Netgear Nighthawk | view | MR2100 status + connection/SIM/reboot actions |

## Setup

```bash
make install   # bun install --frozen-lockfile
make build     # ray build -e dist -o extension/build
```

Then in Tinycast: **Settings → Extensions → Install → Add from folder** →
`extension/build`. No hot reload — re-run `make build` and re-add after every
change. The two menu-bar commands need the **beta** Tinycast channel until
native menu-bar rendering ships to stable (`AGENTS.md` has the version and
cask).

Set preferences in Tinycast (Settings → Extensions → jkrumm): `apiToken` and
`baseUrl` (argo proxy, used by TickTick + Claude usage), optionally
`defaultProjectId`, `netgearHost`, `netgearPassword`.

## Development

```bash
make check   # tsc --noEmit + eslint + prettier + vitest
make test    # vitest only
```

See `AGENTS.md` for the full layout, data sources, and safety notes (never
trigger a Netgear action from a test or script).
