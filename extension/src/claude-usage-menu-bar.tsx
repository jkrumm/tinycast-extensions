import {
  MenuBarExtra,
  Icon,
  Color,
  launchCommand,
  LaunchType,
  showHUD,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useMemo, useRef } from "react";
import { getQuota, isStaleHint } from "./usage/quota";
import {
  getTimeseries,
  aggregateSpend,
  topLanesWithOther,
} from "./usage/spend";
import {
  formatPace,
  formatPercent,
  formatRelativeReset,
  formatSpend,
  formatWeekdayTime,
  menuBarTitleWithFreshness,
  modelLimitLabel,
  spendErrorText,
} from "./usage/format";
import { laneLines, missingSideNote } from "./usage/routing-text";
import { divergences } from "./usage/routing";
import {
  AccountSummary,
  UsageSummary,
  accountProblem,
  laneLabel,
  menuBarTitle,
  paceWords,
  summarize,
} from "./usage/summary";
import { QuotaWindow, quotaLimits, weeklyPace } from "./usage/limits";
import {
  hasMultipleAccounts,
  isQuotaError,
  UsageQuota,
  UsageQuotaOk,
  SpendAggregate,
} from "./usage/types";
import {
  IuBudgetReading,
  IuBudgetView,
  ageLine,
  canSpendLine,
  freesLine,
  iuBudgetView,
  loadIuBudget,
  titleMark,
  unavailableText,
  usageLine,
  usd0,
} from "./usage/iu-budget";
import {
  HealthRow,
  HealthState,
  StampedHealth,
  healthMark,
  parseFixCommand,
  problemRows,
  rowTitle,
} from "./usage/health";
import { launchRelogin, loadHealth } from "./usage/health-local";
import { menuBarRing, toDataUri } from "./lib/svg";
import { RoutingView } from "./usage/routing";

// Matches the detail view's cap (5 lanes + "other") — argo tracks ~60 lanes,
// almost all zero on a given day.
const SPEND_LANE_LIMIT = 5;

// Tinycast only stores a menu-bar render once nothing is loading, and kills a
// run after 60 s — a hanging argo request (flaky mobile internet) would
// otherwise keep the quota title from ever updating. Runs in parallel with
// the quota fetch (20 s cap), so this fits the deadline with room to spare.
const SPEND_TIMEOUT_MS = 25_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms / 1000}s`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// Same split as claude-usage.tsx: getQuota() never rejects, getTimeseries()
// can — spend keeps its last-good value + a spendError line so a failing
// spend fetch doesn't blank out a working quota reading. The error is kept
// as text: the result is persisted as JSON, an Error would come back as {}.
function useUsage() {
  const lastSpendRef = useRef<SpendAggregate | undefined>(undefined);

  return useCachedPromise(
    async () => {
      // A local file read that never rejects — it cannot hold up the run.
      // The health reading is slow (ssh to the peer) and cached for 5 min,
      // so most 2 m runs return it from LocalStorage. It never rejects.
      const [[quotaResult, spendResult], iu, health] = await Promise.all([
        Promise.allSettled([
          getQuota(),
          withTimeout(getTimeseries("7d"), SPEND_TIMEOUT_MS),
        ]),
        loadIuBudget(),
        loadHealth(),
      ]);
      const quota: UsageQuota =
        quotaResult.status === "fulfilled"
          ? quotaResult.value
          : { error: "Failed to load quota", fetched_at: 0 };

      if (spendResult.status === "fulfilled") {
        lastSpendRef.current = aggregateSpend(spendResult.value);
        return {
          quota,
          spend: lastSpendRef.current,
          spendError: null,
          iu,
          health,
        };
      }
      return {
        quota,
        spend: lastSpendRef.current ?? null,
        spendError: spendErrorText(spendResult.reason),
        iu,
        health,
      };
    },
    [],
    { keepPreviousData: true },
  );
}

// A live ring reflecting the pool's weekly use (the one account's weekly when
// there is only one) — the limit that binds on a Max plan. Native menu-bar rendering (beta) fits this into an 18×18pt
// NSStatusItem glyph, so no text: the ring's fill is the whole signal.
function menuBarIcon(quota: UsageQuota, summary: UsageSummary | null): string {
  const percent =
    summary?.pool?.usedPct ??
    (isQuotaError(quota) ? 0 : (quotaLimits(quota).weekly.percent ?? 0));
  return toDataUri(menuBarRing({ percent }));
}

function windowItem(label: string, window: QuotaWindow, reset: string) {
  return (
    <MenuBarExtra.Item
      key={label}
      icon={{ source: Icon.Circle, tintColor: dotColor(window.percent) }}
      title={`${label}: ${formatPercent(window.percent)} — ${reset}`}
    />
  );
}

function formatClock(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function resetText(window: QuotaWindow): string {
  return `resets in ${formatRelativeReset(window.resetsAt)}`;
}

// UI (Color enum) counterpart of lib/svg's thresholdColor — same
// thresholds, different colour space.
function dotColor(percent: number | null): Color {
  if (percent === null) return Color.SecondaryText;
  if (percent < 50) return Color.Green;
  if (percent < 80) return Color.Orange;
  return Color.Red;
}

function summaryOf(quota: UsageQuota): UsageSummary | null {
  return hasMultipleAccounts(quota)
    ? summarize(quota.accounts, quota.routing)
    : null;
}

export default function ClaudeUsageMenuBar() {
  const { data, isLoading, revalidate } = useUsage();

  const summary = useMemo(() => (data ? summaryOf(data.quota) : null), [data]);
  const icon = useMemo(
    () => (data ? menuBarIcon(data.quota, summary) : Icon.LineChart),
    [data, summary],
  );

  const quotaStale =
    !!data && !isQuotaError(data.quota) && isStaleHint(data.quota.fetched_at);

  const iuView = data?.iu.kind === "ok" ? iuBudgetView(data.iu.data) : null;
  const mark = iuView ? titleMark(iuView) : "";
  const quotaTitle = summary
    ? menuBarTitle(summary)
    : data && !isQuotaError(data.quota)
      ? menuBarTitleWithFreshness(data.quota, quotaStale)
      : undefined;
  // A session problem adds its own mark; routing's marks are untouched.
  const sessionMark = data?.health ? healthMark(data.health.report.state) : "";
  const title =
    mark || sessionMark
      ? [quotaTitle, mark, sessionMark].filter(Boolean).join(" · ")
      : quotaTitle;

  return (
    <MenuBarExtra
      icon={icon}
      // Several accounts: the account work goes to + its weekly use, with a
      // mark when something needs attention. One account: the bare weekly %.
      title={title}
      isLoading={isLoading}
      tooltip={summary ? summary.headline : "Claude Usage"}
    >
      {data && summary && hasMultipleAccounts(data.quota) && (
        <>
          <MenuBarExtra.Section>
            <MenuBarExtra.Item
              icon={severityIcon(summary)}
              title={summary.headline}
            />
          </MenuBarExtra.Section>
          <AccountsSection accounts={summary.accounts} />
          <RoutingSection routing={data.quota.routing} />
        </>
      )}

      {data && !summary && !isQuotaError(data.quota) && (
        <QuotaSection quota={data.quota} />
      )}

      {data && isQuotaError(data.quota) && (
        <MenuBarExtra.Section>
          <MenuBarExtra.Item title={`⚠ ${data.quota.error}`} />
        </MenuBarExtra.Section>
      )}

      {data && <SessionsSection health={data.health} />}

      {data && <IuBudgetSection reading={data.iu} view={iuView} />}

      {data && data.spend && (
        <MenuBarExtra.Section>
          <MenuBarExtra.Submenu
            icon={Icon.Coins}
            title={`Spend ${formatSpend(data.spend.todayTotal)} today · ${formatSpend(data.spend.sevenDayTotal)} 7d${data.spendError ? " (last known)" : ""}`}
          >
            {topLanesWithOther(data.spend.today, SPEND_LANE_LIMIT).map(
              ({ label, value }) => (
                <MenuBarExtra.Item
                  key={label}
                  title={`${label}: ${formatSpend(value)}`}
                />
              ),
            )}
          </MenuBarExtra.Submenu>
        </MenuBarExtra.Section>
      )}

      {data && data.spendError && (
        <MenuBarExtra.Section>
          <MenuBarExtra.Item title={data.spendError} />
        </MenuBarExtra.Section>
      )}

      <MenuBarExtra.Section>
        {data && !isQuotaError(data.quota) && (
          <MenuBarExtra.Item
            title={`Updated ${formatClock(data.quota.fetched_at)}${quotaStale ? " (stale)" : ""}`}
          />
        )}
        <MenuBarExtra.Item
          title="Open Details"
          icon={Icon.Sidebar}
          onAction={() =>
            launchCommand({
              name: "claude-usage",
              type: LaunchType.UserInitiated,
            })
          }
        />
        <MenuBarExtra.Item
          title="Refresh"
          icon={Icon.ArrowClockwise}
          onAction={revalidate}
        />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}

function severityIcon(summary: UsageSummary) {
  const tint =
    summary.severity === "ok"
      ? Color.Green
      : summary.severity === "low"
        ? Color.Orange
        : Color.Red;
  return { source: Icon.Circle, tintColor: tint };
}

// One line per account: where its week stands and is heading, then its 5h
// window; a flag or the reason this Mac would not pick it comes last.
function accountLine(a: AccountSummary): string {
  const plan = a.plan ? ` ${a.plan}` : "";
  const week = `${formatPercent(a.weeklyPct)} week (${paceWords(a.pace, formatWeekdayTime)})`;
  const session = `5h ${formatPercent(a.fiveHourPct)} · ${formatRelativeReset(a.fiveHourResetsAt)}`;
  const problem =
    accountProblem(a) ??
    (a.eligibility.eligible ? null : `not pickable: ${a.eligibility.reason}`);
  return `${a.id}${plan} — ${week} · ${session}${problem ? ` — ${problem}` : ""}`;
}

function AccountsSection({ accounts }: { accounts: AccountSummary[] }) {
  return (
    <MenuBarExtra.Section title="Accounts">
      {accounts.map((a) => (
        <MenuBarExtra.Item
          key={a.id}
          icon={{
            source: Icon.Circle,
            tintColor:
              a.flags.length > 0 || !a.eligibility.eligible
                ? Color.SecondaryText
                : dotColor(a.weeklyPct),
          }}
          title={accountLine(a)}
        />
      ))}
    </MenuBarExtra.Section>
  );
}

// Where each kind of work goes and why, and where this Mac and the mini
// disagree.
function RoutingSection({ routing }: { routing: RoutingView | undefined }) {
  if (!routing) return null;
  const note = missingSideNote(routing);
  const diverging = divergences(routing, Date.now() / 1000, laneLabel);
  return (
    <MenuBarExtra.Section title="Routing">
      {laneLines(routing.picks).map((line) => (
        <MenuBarExtra.Item key={line} title={line} />
      ))}
      {diverging.map((d) => (
        <MenuBarExtra.Item key={d} title={`⚠ ${d}`} />
      ))}
      {routing.picks && routing.argoPicks && diverging.length === 0 && (
        <MenuBarExtra.Item title="Mini picks the same" />
      )}
      {note && <MenuBarExtra.Item title={note} />}
    </MenuBarExtra.Section>
  );
}

function QuotaSection({ quota }: { quota: UsageQuotaOk }) {
  const { weekly, session, models } = quotaLimits(quota);
  const pace = weeklyPace(weekly, Date.now() / 1000);
  return (
    <MenuBarExtra.Section title="Quota">
      {windowItem(
        "Weekly",
        weekly,
        weekly.resetsAt === null
          ? "no reset time"
          : `resets ${formatWeekdayTime(weekly.resetsAt)} (${formatRelativeReset(weekly.resetsAt)})`,
      )}
      {pace && <MenuBarExtra.Item title={`Pace: ${formatPace(pace)}`} />}
      {windowItem("5h session", session, resetText(session))}
      {models.map((model) =>
        windowItem(modelLimitLabel(model), model, resetText(model)),
      )}
    </MenuBarExtra.Section>
  );
}

// The IU API cap over the rolling 30 days, from IU's own portal figure.
function IuBudgetSection({
  reading,
  view,
}: {
  reading: IuBudgetReading;
  view: IuBudgetView | null;
}) {
  const unavailable = unavailableText(reading);
  if (!view)
    return (
      <MenuBarExtra.Section title="IU API · 30 days">
        <MenuBarExtra.Item title={unavailable ?? ""} />
      </MenuBarExtra.Section>
    );
  const tint =
    view.state === "ok"
      ? Color.Green
      : view.state === "warn"
        ? Color.Orange
        : Color.Red;
  const frees = freesLine(view);
  return (
    <MenuBarExtra.Section title="IU API · 30 days">
      <MenuBarExtra.Item
        icon={{ source: Icon.Circle, tintColor: tint }}
        title={usageLine(view)}
      />
      <MenuBarExtra.Item title={canSpendLine(view)} />
      {frees && <MenuBarExtra.Item title={frees} />}
      {view.data.topModels.slice(0, 3).map((m, i) => (
        <MenuBarExtra.Item key={i} title={`${m.label}: ${usd0(m.usd)}`} />
      ))}
      <MenuBarExtra.Item
        icon={view.freshness === "fresh" ? undefined : Icon.Warning}
        title={ageLine(view)}
      />
    </MenuBarExtra.Section>
  );
}

function healthTint(state: HealthState): Color {
  return state === "ok"
    ? Color.Green
    : state === "warn"
      ? Color.Orange
      : Color.Red;
}

async function startRelogin(row: HealthRow) {
  if (!launchRelogin(row.fix)) return;
  await showHUD("Login started, approve in the browser");
}

// Logins and quota samples on both machines: only what needs attention. A row
// with a re-login command is clickable; anything else is rejected before it
// could reach a process (usage/health.ts parseFixCommand).
function SessionsSection({ health }: { health: StampedHealth | null }) {
  if (!health)
    return (
      <MenuBarExtra.Section title="Sessions">
        <MenuBarExtra.Item title="Session health unavailable" />
      </MenuBarExtra.Section>
    );
  const problems = problemRows(health.report);
  return (
    <MenuBarExtra.Section title="Sessions">
      {problems.length === 0 && (
        <MenuBarExtra.Item
          icon={{ source: Icon.Circle, tintColor: Color.Green }}
          title="All sessions healthy"
        />
      )}
      {problems.map((row) => (
        <MenuBarExtra.Item
          key={`${row.machine}-${row.id}-${row.check}`}
          icon={{ source: Icon.Circle, tintColor: healthTint(row.state) }}
          title={rowTitle(row)}
          subtitle={parseFixCommand(row.fix) ? "Re-login" : undefined}
          onAction={
            parseFixCommand(row.fix) ? () => startRelogin(row) : undefined
          }
        />
      ))}
    </MenuBarExtra.Section>
  );
}
