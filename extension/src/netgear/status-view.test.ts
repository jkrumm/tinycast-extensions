import { describe, it, expect } from "vitest";
import {
  statusMarkdown,
  formatUptime,
  roamingRow,
  countDrops,
  watchdogSection,
  watchdogActivity,
  rebootBanner,
  offlineLabel,
} from "./status-view";
import { BASE_STATUS } from "./test-helpers";
import type { RebootMarker, WatchdogEvent } from "./watchdog";
import type { WatchdogStorage } from "./watchdog-storage";
import { INITIAL_WATCHDOG_STATE } from "./watchdog";

const NOW = Date.UTC(2026, 0, 1, 14, 0);

// The decoded SVG of the stat-card image (`![Metrics](data:…)`).
function statsSvg(markdown: string): string {
  const match = markdown.match(
    /!\[Metrics\]\(data:image\/svg\+xml;base64,([^?)]+)/,
  );
  if (!match) throw new Error("no Metrics image in the markdown");
  return Buffer.from(match[1], "base64").toString("utf8");
}

function storage(events: WatchdogEvent[], enabled = true): WatchdogStorage {
  return {
    enabled,
    state: INITIAL_WATCHDOG_STATE,
    events,
    counts: {},
    since: null,
  };
}

function ev(
  kind: WatchdogEvent["kind"],
  message: string,
  agoMs = 0,
): WatchdogEvent {
  return { at: NOW - agoMs, kind, message };
}

describe("formatUptime", () => {
  it("formats days and hours", () => {
    expect(formatUptime(null)).toBe("—");
    expect(formatUptime(720)).toBe("12 min");
    expect(formatUptime(3600)).toBe("1h");
    expect(formatUptime(90000)).toBe("1d 1h");
  });
});

describe("statusMarkdown — PIN row folding", () => {
  it("folds lock mode, retries, and saved state into one row", () => {
    const md = statusMarkdown(
      { ...BASE_STATUS, simPinMode: "Enabled", simPinRetry: 3 },
      true,
      undefined,
    );
    expect(md).toContain("| PIN | Lock on · 3 tries · saved |");
  });

  it("uses singular 'try' at 1 retry left and omits 'saved' when unsaved", () => {
    const md = statusMarkdown(
      { ...BASE_STATUS, simPinMode: "Enabled", simPinRetry: 1 },
      false,
      undefined,
    );
    expect(md).toContain("| PIN | Lock on · 1 try |");
  });

  it("omits the retry count when the lock is disabled", () => {
    const md = statusMarkdown(
      { ...BASE_STATUS, simPinMode: "Disabled", simPinRetry: 3 },
      false,
      undefined,
    );
    expect(md).toContain("| PIN | Lock off |");
  });
});

describe("statusMarkdown — rows hidden when redundant", () => {
  it("drops Role, Connection, and SIM status rows entirely", () => {
    const md = statusMarkdown(BASE_STATUS, false, undefined);
    expect(md).not.toContain("| Role |");
    expect(md).not.toContain("| Connection |");
    expect(md).not.toContain("| SIM status |");
  });

  it("drops the battery temperature row entirely", () => {
    const md = statusMarkdown(
      { ...BASE_STATUS, batteryTemperature: 30 },
      false,
      undefined,
    );
    expect(md).not.toContain("Battery temp");
  });

  it("hides the SIM operator row when it matches the network operator", () => {
    const md = statusMarkdown(
      { ...BASE_STATUS, operator: "Fakecom", simOperator: "Fakecom" },
      false,
      undefined,
    );
    expect(md).not.toContain("| SIM operator |");
  });

  it("shows the SIM operator row only when it differs from the network operator", () => {
    const md = statusMarkdown(
      { ...BASE_STATUS, operator: "Fakecom", simOperator: "OtherSim" },
      false,
      undefined,
    );
    expect(md).toContain("| SIM operator | OtherSim |");
  });

  it("hides the SMS row when there are no unread messages", () => {
    const md = statusMarkdown(
      { ...BASE_STATUS, smsUnread: 0 },
      false,
      undefined,
    );
    expect(md).not.toContain("| SMS |");
  });

  it("shows the SMS row only when there are unread messages", () => {
    const md = statusMarkdown(
      { ...BASE_STATUS, smsUnread: 2 },
      false,
      undefined,
    );
    expect(md).toContain("| SMS | 2 unread |");
  });

  it("hides the clients row when connectedClients is null", () => {
    const md = statusMarkdown(
      { ...BASE_STATUS, connectedClients: null },
      false,
      undefined,
    );
    expect(statsSvg(md)).not.toContain(">CLIENTS<");
  });

  it("shows the clients row when connectedClients is known", () => {
    const md = statusMarkdown(
      { ...BASE_STATUS, connectedClients: 4 },
      false,
      undefined,
    );
    expect(statsSvg(md)).toContain(">CLIENTS<");
    expect(statsSvg(md)).toContain(">4<");
  });
});

describe("roamingRow", () => {
  it("describes allowed roaming on a roaming network, with the operator", () => {
    expect(
      roamingRow({
        ...BASE_STATUS,
        roamingAllowed: true,
        currentlyRoaming: true,
        operator: "vodafone P",
      }),
    ).toBe("Allowed · roaming now (vodafone P)");
  });

  it("describes allowed roaming on the home network", () => {
    expect(roamingRow({ ...BASE_STATUS, roamingAllowed: true })).toBe(
      "Allowed · home network",
    );
  });

  it("says the watchdog re-enables roaming when it is off", () => {
    expect(roamingRow({ ...BASE_STATUS, roamingAllowed: false })).toBe(
      "Off — watchdog re-enables",
    );
  });

  it("is the Roaming row of the status table", () => {
    const md = statusMarkdown(
      { ...BASE_STATUS, roamingAllowed: true, currentlyRoaming: true },
      false,
      undefined,
      { internet: true, now: NOW },
    );
    expect(md).toContain("| Roaming | Allowed · roaming now (Fakecom) |");
  });
});

describe("countDrops", () => {
  it("counts connected + reconnected events from the last hour only", () => {
    const events = [
      ev("connected", "Connected · 4G+", 5 * 60_000),
      ev(
        "reconnected",
        "Reconnected after failed internet checks",
        30 * 60_000,
      ),
      ev("ok", "OK · 4G+", 10 * 60_000),
      ev("probe-failed", "Internet check failed (1/2)", 31 * 60_000),
      ev(
        "reconnected",
        "Reconnected after failed internet checks",
        61 * 60_000,
      ),
      ev("reconnect-failed", "x", 2 * 60_000),
    ];
    expect(countDrops(events, NOW)).toBe(2);
  });

  it("is 0 for an empty log", () => {
    expect(countDrops([], NOW)).toBe(0);
  });
});

describe("watchdogActivity", () => {
  it("shows a fresh in-progress breadcrumb without its prefix", () => {
    const wd = storage([
      ev("in-progress", "In progress: reconnecting…", 20_000),
    ]);
    expect(watchdogActivity({ watchdog: wd, now: NOW })).toBe("reconnecting…");
  });

  it("ignores a stale in-progress breadcrumb", () => {
    const wd = storage([
      ev("in-progress", "In progress: reconnecting…", 90_000),
    ]);
    expect(watchdogActivity({ watchdog: wd, now: NOW })).toBeNull();
  });

  it("shows a running check when the watchdog holds the lock", () => {
    const lockHolder = {
      owner: "watchdog" as const,
      label: "tick",
      at: NOW - 5000,
      expiresAt: NOW + 85_000,
    };
    expect(
      watchdogActivity({ watchdog: storage([]), lockHolder, now: NOW }),
    ).toBe("running a check…");
  });

  it("ignores a UI-held or expired lock", () => {
    const base = { label: "x", at: NOW - 5000 };
    expect(
      watchdogActivity({
        watchdog: storage([]),
        lockHolder: { ...base, owner: "ui", expiresAt: NOW + 1000 },
        now: NOW,
      }),
    ).toBeNull();
    expect(
      watchdogActivity({
        watchdog: storage([]),
        lockHolder: { ...base, owner: "watchdog", expiresAt: NOW - 1 },
        now: NOW,
      }),
    ).toBeNull();
  });
});

describe("statusMarkdown — live internet state", () => {
  it("keeps the plain headline and shows Reachable when internet is up", () => {
    const md = statusMarkdown(BASE_STATUS, false, undefined, {
      internet: true,
      now: NOW,
    });
    expect(md.startsWith("# 4G+\n")).toBe(true);
    const cards = statsSvg(md);
    expect(cards).toContain(">INTERNET<");
    expect(cards).toContain(">Online<");
    expect(md).not.toContain("| Internet |");
    expect(md).not.toContain("No internet");
  });

  it("flags Connected-but-no-internet in the headline and a warning", () => {
    const wd = storage([
      ev("probe-failed", "Internet still down — next reconnect after 14:02"),
    ]);
    const md = statusMarkdown(BASE_STATUS, false, wd, {
      internet: false,
      now: NOW,
    });
    expect(md.startsWith("# 4G+ · No internet\n")).toBe(true);
    expect(statsSvg(md)).toContain(">Offline<");
    expect(md).toContain("the router reports Connected");
    expect(md).toContain("next reconnect after 14:02.");
  });

  it("says the watchdog reconnects after the next failed check on a first failure", () => {
    const wd = storage([ev("probe-failed", "Internet check failed (1/2)")]);
    const md = statusMarkdown(BASE_STATUS, false, wd, {
      internet: false,
      now: NOW,
    });
    expect(md).toContain("reconnects after the next failed check");
  });

  it("mentions a paused watchdog in the no-internet warning", () => {
    const md = statusMarkdown(BASE_STATUS, false, storage([], false), {
      internet: false,
      now: NOW,
    });
    expect(md).toContain("The watchdog is paused.");
  });

  it("shows the radio state as the headline when not Connected, even with internet false", () => {
    const md = statusMarkdown(
      { ...BASE_STATUS, connection: "Connecting" },
      false,
      undefined,
      { internet: false, now: NOW },
    );
    expect(md.startsWith("# Connecting\n")).toBe(true);
    expect(md).not.toContain("No internet");
  });

  it("shows — for Internet when the probe could not run", () => {
    const md = statusMarkdown(BASE_STATUS, false, undefined);
    expect(statsSvg(md)).not.toContain(">Online<");
    expect(statsSvg(md)).not.toContain(">Offline<");
    expect(md).toContain("### Watchdog · —");
  });

  it("shows the watchdog activity line near the top and the drops count", () => {
    const wd = storage([
      ev("in-progress", "In progress: reconnecting…", 10_000),
      ev(
        "reconnected",
        "Reconnected after failed internet checks",
        20 * 60_000,
      ),
    ]);
    const md = statusMarkdown(BASE_STATUS, false, wd, {
      internet: true,
      now: NOW,
    });
    const lines = md.split("\n");
    expect(lines.indexOf("> 🔄 Watchdog: reconnecting…")).toBeGreaterThan(0);
    expect(lines.indexOf("> 🔄 Watchdog: reconnecting…")).toBeLessThan(
      lines.findIndex((l) => l.startsWith("![Status]")),
    );
    expect(md).toContain("### Watchdog · On · 1 drop in the last hour");
    // The breadcrumb is the 🔄 line, never a row in the event table.
    expect(md).not.toContain("| In progress: reconnecting… |");
    expect(md).toContain("| ↻ | Reconnected after failed internet checks |");
  });

  it("lays the fields out two pairs per row", () => {
    const md = statusMarkdown(BASE_STATUS, false, undefined, {
      internet: true,
      now: NOW,
    });
    expect(md).toContain("| | | | |\n|-|-|-|-|");
    expect(md).toMatch(/^\| Roaming \| .+ \| APN \| .+ \|$/m);
  });

  it("adds the compact Signal verdict next to the PIN row", () => {
    const md = statusMarkdown(BASE_STATUS, false, undefined, {
      internet: true,
      now: NOW,
    });
    expect(md).toMatch(
      /^\| PIN \| .+ \| Signal \| Fair · SINR 4 dB · RSRP −98 \|$/m,
    );
  });

  it("leaves the Signal row out when the router reports no signal", () => {
    const md = statusMarkdown(
      { ...BASE_STATUS, sinr: null, rsrp: null, rsrq: null },
      false,
      undefined,
      { internet: true, now: NOW },
    );
    expect(md).not.toContain("| Signal |");
  });
});

describe("watchdogSection", () => {
  it("shows a collapsed run as a time span with its count", () => {
    const first = NOW - 30 * 60_000;
    const md = watchdogSection(
      storage([
        {
          at: NOW - 60_000,
          firstAt: first,
          count: 16,
          kind: "ok",
          message: "OK · 4G+",
        },
      ]),
      NOW,
    ).join("\n");
    expect(md).toMatch(/\| \d\d:\d\d–\d\d:\d\d \| ✓ \| OK · 4G\+ ×16 \|/);
  });

  it("caps the table at the 6 newest events", () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      ev("probe-failed", `fail ${i}`, (i + 1) * 60_000),
    );
    const rows = watchdogSection(storage(events), NOW).filter((l) =>
      l.includes("| ⚠︎ |"),
    );
    expect(rows).toHaveLength(6);
  });

  it("notes that ticks run in the open view, unless paused", () => {
    const heading = (enabled: boolean) =>
      watchdogSection({ ...storage([]), enabled }, NOW, true)[0];
    expect(heading(true)).toContain("running here while this view is open");
    expect(heading(false)).not.toContain("running here");
    expect(watchdogSection(storage([]), NOW)[0]).not.toContain("running here");
  });

  it("points at Background Refresh when it never ran", () => {
    expect(watchdogSection(storage([]), NOW).join("\n")).toContain(
      "Background Refresh",
    );
  });
});

describe("watchdogSection — reboot events", () => {
  it("gives the reboot lifecycle its own glyph", () => {
    const md = watchdogSection(
      storage([
        ev("recovered", "Back online after restart"),
        ev("rebooting", "Router restarting — waiting for it to come back"),
        ev("rebooted", "Router stuck — restarted it (could not connect)"),
      ]),
      NOW,
    ).join("\n");
    expect(md.match(/\| ⏻ \|/g)).toHaveLength(3);
  });
});

describe("rebootBanner", () => {
  const marker: RebootMarker = { at: NOW, source: "ui", iccid: "x" };
  const base = {
    marker,
    status: BASE_STATUS,
    internet: true as boolean | null,
    fetchedAt: NOW + 200_000,
    error: undefined as unknown,
  };

  it("shows the elapsed time while restarting, even when unreachable", () => {
    const banner = rebootBanner({
      ...base,
      status: undefined,
      fetchedAt: undefined,
      error: new Error("curl exited 7"),
      now: NOW + 80_000,
    });
    expect(banner).toEqual({
      markdown: "> 🔄 Router restarting… (1:20 elapsed)",
      restarting: true,
    });
  });

  it("does not take a cached pre-reboot status for 'back'", () => {
    const banner = rebootBanner({
      ...base,
      fetchedAt: NOW - 5_000,
      now: NOW + 30_000,
    });
    expect(banner?.restarting).toBe(true);
  });

  it("does not take a still-old router uptime for 'back'", () => {
    const banner = rebootBanner({
      ...base,
      status: { ...BASE_STATUS, uptimeSeconds: 86_400 },
      fetchedAt: NOW + 5_000,
      now: NOW + 10_000,
    });
    expect(banner?.restarting).toBe(true);
  });

  it("disappears once Connected + online after the restart", () => {
    expect(
      rebootBanner({
        ...base,
        status: { ...BASE_STATUS, uptimeSeconds: 40 },
        now: NOW + 200_000,
      }),
    ).toBeNull();
  });

  it("stays while Connected but the internet check fails", () => {
    expect(
      rebootBanner({ ...base, internet: false, now: NOW + 200_000 })
        ?.restarting,
    ).toBe(true);
  });

  it("warns after 5 minutes without recovery, and drops out after 30", () => {
    const unreachable = {
      ...base,
      status: undefined,
      fetchedAt: undefined,
      error: new Error("curl exited 7"),
    };
    const warning = rebootBanner({ ...unreachable, now: NOW + 5 * 60_000 });
    expect(warning?.restarting).toBe(false);
    expect(warning?.markdown).toContain(
      "Router did not come back after the restart",
    );
    expect(warning?.markdown).toContain("Rejoin Router Wi-Fi");
    expect(rebootBanner({ ...unreachable, now: NOW + 31 * 60_000 })).toBeNull();
  });

  it("is null without a marker", () => {
    expect(rebootBanner({ ...base, marker: null, now: NOW })).toBeNull();
  });
});

describe("statusMarkdown — low battery warning", () => {
  const low = { ...BASE_STATUS, battChargeLevel: 18, charging: false };

  it("adds a warning line under the headline when low and not charging", () => {
    const lines = statusMarkdown(low, false, undefined, {
      internet: true,
      now: NOW,
    }).split("\n");
    expect(lines[0]).toMatch(/^# /);
    expect(lines[2]).toBe("> 🔋 **Router battery 18%** — not charging.");
  });

  it("is shown at exactly 20% and hidden above it", () => {
    const at20 = statusMarkdown(
      { ...low, battChargeLevel: 20 },
      false,
      undefined,
    );
    expect(at20).toContain("**Router battery 20%**");
    const at21 = statusMarkdown(
      { ...low, battChargeLevel: 21 },
      false,
      undefined,
    );
    expect(at21).not.toContain("Router battery");
  });

  it("is hidden while charging", () => {
    const md = statusMarkdown({ ...low, charging: true }, false, undefined);
    expect(md).not.toContain("Router battery");
  });

  it("is hidden for a stale (cached) status", () => {
    const md = statusMarkdown(low, false, undefined, {
      internet: null,
      stale: true,
    });
    expect(md).not.toContain("Router battery");
  });
});

describe("offlineLabel", () => {
  const empty = ev(
    "battery-empty",
    "Router off — battery was 4% at 00:45. Plug it in.",
  );

  it("says the router ran out of battery when the watchdog's last event is battery-empty", () => {
    expect(offlineLabel(storage([empty]))).toBe(empty.message);
  });

  it("looks past in-progress breadcrumbs", () => {
    expect(
      offlineLabel(storage([ev("in-progress", "In progress: x"), empty])),
    ).toBe(empty.message);
  });

  it("falls back to the generic label otherwise", () => {
    expect(offlineLabel(undefined)).toBe("Router not reachable");
    expect(offlineLabel(storage([]))).toBe("Router not reachable");
    expect(
      offlineLabel(storage([ev("idle", "Router not reachable"), empty])),
    ).toBe("Router not reachable");
  });
});

describe("watchdogSection — battery events", () => {
  it("gives the battery kinds the battery glyph", () => {
    const md = watchdogSection(
      storage([
        ev("power-restored", "Router back on power (battery 5%, charging)", 1),
        ev(
          "battery-empty",
          "Router off — battery was 4% at 00:45. Plug it in.",
          2,
        ),
        ev("battery-low", "Router battery 18% — plug it in", 3),
      ]),
      NOW,
    ).join("\n");
    expect(md.match(/🔋/g)).toHaveLength(3);
  });
});

describe("statusMarkdown — no mobile network", () => {
  const LIMITED = {
    ...BASE_STATUS,
    connection: "Disconnected",
    connectionText: "Disconnected",
    operator: "",
    serviceType: "LimitedService",
    registered: false,
  };

  it("leads with 'No service' and explains the limited service", () => {
    const md = statusMarkdown(LIMITED, false, undefined);
    expect(md.startsWith("# No service\n")).toBe(true);
    expect(md).toContain(
      "> 📵 **No mobile network** — the router sees cells but isn't allowed to register (limited service). **Restart & Reconnect** usually fixes this if coverage is good here.",
    );
  });

  it("keeps the normal headline and no warning when registered", () => {
    const md = statusMarkdown(BASE_STATUS, false, undefined);
    expect(md.startsWith("# 4G+\n")).toBe(true);
    expect(md).not.toContain("No mobile network");
  });

  it("does not blame the network while the SIM is locked", () => {
    const md = statusMarkdown(
      { ...LIMITED, simStatus: "Locked" },
      false,
      undefined,
    );
    expect(md.startsWith("# Disconnected\n")).toBe(true);
    expect(md).not.toContain("No mobile network");
  });

  it("marks no-service watchdog events with 📵 and the service-restored ones with ↻", () => {
    const rows = watchdogSection(
      storage([
        ev("service-restored", "Mobile network back (Fakecom, LTE B7)", 0),
        ev("no-service", "No mobile network — limited service", 60_000),
      ]),
      NOW,
    ).join("\n");
    expect(rows).toContain("| 📵 | No mobile network — limited service |");
    expect(rows).toContain("| ↻ | Mobile network back (Fakecom, LTE B7) |");
  });
});
