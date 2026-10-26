# IU API budget in Tinycast — the rolling 30-day $500 window, at a glance
**Goal:** The Claude usage menu bar, the Claude usage Detail and the hub tile show IU API spend over the
rolling 30-day window against the $500 cap. Each shows what can still be spent today and how fresh the
number is. The data is IU's own portal figure, not our estimate.
**Gate:** `make check` green; then deploy on the MacBook (`ssh iumac 'cd ~/SourceRoot/tinycast-extensions &&
git pull --ff-only && make deploy'`) and `make status` there shows deployed == built. This repo runs only on
the MacBook; the mini checkout is for editing and committing only.

## Established — do not re-derive

- **Why:** the IU employee cap is **$500 over a rolling 30-day window**, judged on IU's self-service portal
  (cost-overview), not on our own cost estimates. On 2026-10-26 the last 30 days were $577.93, already over the cap.
- **Data source = a local file on the MacBook**, written by usage-tracker's portal scraper (another wave, in
  progress: `~/SourceRoot/usage-tracker/docs/waves/PLAN.md`). The scraper runs headless Chrome on the
  MacBook, triggered from the mini about every 4 h. Read `~/.local/share/iu-portal/latest.json` (fs read,
  like `usage/quota.ts` does). Contract, schema 1:
  ```json
  { "schema": 1, "fetched_at": "ISO", "limit_usd": 500, "window_days": 30,
    "rolling30_usd": 577.93, "can_spend_today_usd": -60.1,
    "daily": [{ "day": "YYYY-MM-DD", "usd": 12.3 }],
    "top_models": [{ "label": "Deepseek V4.1 Flash", "usd": 274.85 }],
    "dropoff_next7": [{ "day": "YYYY-MM-DD", "frees_usd": 8.2 }] }
  ```
  `daily` holds the last 31 days, ascending; `top_models` is the top 10 over the window, descending. An expired
  portal session leaves the old file in place, so **age is the failure signal**. Missing file → show "IU
  budget: no data — run `make iu-portal-login` in usage-tracker". A `schema` other than 1 → show "unknown
  format", never guess.
- Build against a fixture until the real file exists. If it exists when you reach the live step, use it.

## Wave 1 — IU budget surfaces            <!-- status: active -->
- [ ] `extension/src/usage/iu-budget.ts`: read + validate (zod or the repo's existing validation idiom) +
      pure derivations: percent of limit, a state (`ok` < 80 %, `warn` 80–100 %, `over` > 100 %), freshness
      (`stale` > 8 h, `dead` > 48 h), and the "frees up" summary from `dropoff_next7`. Tests with
      fixtures for ok/warn/over/stale/missing/bad-schema.
- [ ] Menu bar (`claude-usage-menu-bar.tsx`): an "IU API · 30 days" section with `$578 / $500 (116 %)`,
      "can spend today", "frees $X over the next 7 days", top 3 models and the age. Change the menu-bar title
      only in `warn`/`over` (one short mark, repo's colour/ring idiom). The existing title stays primary.
      The file read must stay well inside the 60 s Tinycast budget; it is a local read.
- [ ] Detail (`claude-usage.tsx`): an IU budget block with a 31-day daily bar chart, the 30-day window
      marked, a $500/30 ≈ $16.7/day reference line in the repo's chart idiom, and the top-10 models table.
      Hub tile (`hub.tsx`): the percent plus state colour.
- [ ] AGENTS.md "Data sources per feature" entry: file path, contract, producer repo, staleness meaning.
- [ ] `make check`, commit, push, deploy on the MacBook (Gate), and confirm in `make status`. If
      `latest.json` exists by then, put the rendered numbers into Left behind.
**Left behind:**
