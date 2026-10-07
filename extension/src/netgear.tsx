import { useEffect, useMemo, useRef } from "react";
import {
  Detail,
  ActionPanel,
  Action,
  Icon,
  confirmAlert,
  Alert,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { usePromise, useCachedPromise } from "@raycast/utils";
import { prefs } from "./lib/argo";
import {
  Stamped,
  stamped,
  freshnessBanner,
  updatingLine,
} from "./lib/freshness";
import { RouterStatus } from "./netgear/types";
import {
  actionLockPath,
  DEFAULT_HOST,
  getClient,
  getPassword,
  logNetgear,
  pinStore,
  waitMessage,
  wifiCredsStore,
  wifiRejoiner,
  withAdmin,
  withUiActionLock,
} from "./netgear/session";
import { readActionLock } from "./netgear/action-lock";
import {
  shouldRunViewTick,
  startViewTicker,
} from "./netgear/watchdog-schedule";
import { runWatchdogOnce } from "./netgear/watchdog-runner";
import { probeInternet } from "./netgear/internet-probe";
import {
  reconnect as reconnectFlow,
  autoUnlockIfPossible,
  ensureConnected,
  ensureRouterReachable,
  resolveAutoUnlockPin,
} from "./netgear/flows";
import { describeErrorDetail, describeNetgearError } from "./netgear/errors";
import {
  WatchdogStorage,
  loadWatchdogStorage,
  recordReboot,
  saveWatchdogStorage,
} from "./netgear/watchdog-storage";
import {
  noService,
  offlineLabel,
  rebootBanner,
  statusMarkdown,
} from "./netgear/status-view";
import {
  EnterPinForm,
  UnblockPukForm,
  ChangePinForm,
  SimPinLockForm,
} from "./netgear/sim-forms";
import { ApnProfiles } from "./netgear/apn";
import { SmsInbox } from "./netgear/sms";
import { ConnectedDevices } from "./netgear/devices";
import { WatchdogLog } from "./netgear/watchdog-view";
import { NetgearLog } from "./netgear/log-view";
import { SignalMeter } from "./netgear/signal-meter";
import { captureWifiCredentials } from "./netgear/wifi-creds-store";

// How often the open view re-reads the router, the internet probe, the
// watchdog's log and the action lock — the view is a live monitor, not a
// snapshot taken at open.
const POLL_INTERVAL_MS = 10_000;
// A background poll over fresh data shouldn't flash "Updating…" every cycle.
const UPDATING_LINE_AFTER_MS = 20_000;

interface LoadedStatus {
  status: RouterStatus;
  // null: the probe itself failed to run — unknown, not "down".
  internet: boolean | null;
}

async function readStatus(): Promise<RouterStatus> {
  const client = await getClient();
  let status = await client.getStatus();
  if (status.userRole !== "Admin") {
    const password = await getPassword({ toast: false });
    if (password) {
      status = await client.login(password);
      // Best-effort, every time this command elevates to Admin — so the Mac
      // learns the router's own Wi-Fi well before it's ever needed to
      // self-heal (see netgear/wifi-creds-store.ts).
      await captureWifiCredentials({ client, store: wifiCredsStore });
    }
  }
  // A Locked SIM hides its ICCID — remember the last one seen so a cold
  // boot can still find that SIM's saved PIN.
  if (status.iccid) await pinStore.setLastIccid(status.iccid);
  return status;
}

// `connection === "Connected"` only proves the radio link, so the real
// internet probe runs in parallel with the router read.
async function loadStatus(): Promise<LoadedStatus> {
  const internet = probeInternet().catch(() => null);
  const status = await readStatus();
  return { status, internet: await internet };
}

function loadStatusStamped(): Promise<Stamped<LoadedStatus>> {
  return stamped(loadStatus);
}

async function handleToggleWatchdog(
  storage: WatchdogStorage,
  revalidate: () => void,
) {
  // Re-read rather than saving the view's snapshot: the watchdog (or a
  // Restart's reboot marker) may have written state since it was loaded.
  const current = await loadWatchdogStorage();
  await saveWatchdogStorage({ ...current, enabled: !storage.enabled });
  await showToast({
    style: Toast.Style.Success,
    title: storage.enabled ? "Watchdog paused" : "Watchdog resumed",
  });
  revalidate();
}

export default function Netgear() {
  const {
    data: statusStamped,
    isLoading,
    error,
    revalidate,
  } = useCachedPromise(loadStatusStamped, [], {
    keepPreviousData: true,
    // The freshness banner below already covers a failed refresh — a second,
    // generic failure toast on top of it would be redundant noise.
    onError: () => {},
  });
  const status = statusStamped?.data.status;
  const internet = statusStamped?.data.internet ?? null;
  const fetchedAt = statusStamped?.fetchedAt;
  const unreachable = !!error;
  const { data: hasSavedPin, revalidate: revalidateSavedPin } = usePromise(
    async (iccid: string) =>
      iccid ? (await pinStore.get(iccid)) !== null : false,
    [status?.iccid ?? ""],
  );
  const { data: watchdog, revalidate: revalidateWatchdog } = useCachedPromise(
    loadWatchdogStorage,
    [],
    { keepPreviousData: true },
  );
  const { data: lockHolder, revalidate: revalidateLock } = usePromise(() =>
    readActionLock(actionLockPath()),
  );
  const { push } = useNavigation();
  const autoUnlockRan = useRef(false);

  // Tinycast has ONE JS runtime: while this view is open no background tick
  // runs, so the view drives the watchdog itself — first tick shortly after
  // mount, then every minute (see watchdog-schedule.ts). Skipped while a tick
  // is in flight, the watchdog is paused or a manual action holds the lock;
  // refs keep the effect to once per mount.
  const watchdogRef = useRef(watchdog);
  watchdogRef.current = watchdog;
  const afterTickRef = useRef(() => {});
  afterTickRef.current = () => {
    revalidate();
    revalidateWatchdog();
    revalidateLock();
  };
  useEffect(
    () =>
      startViewTicker({
        shouldRun: async () =>
          shouldRunViewTick({
            enabled: watchdogRef.current?.enabled,
            lockHolder: await readActionLock(actionLockPath()),
          }),
        run: async () => {
          try {
            await runWatchdogOnce({ source: "view" });
          } finally {
            afterTickRef.current();
          }
        },
      }),
    [],
  );

  // Live view: re-read everything every POLL_INTERVAL_MS while mounted,
  // skipping a tick while the previous load is still in flight. A ref holds
  // the latest closure so the interval is created exactly once per mount.
  const pollRef = useRef(() => {});
  pollRef.current = () => {
    if (isLoading) return;
    revalidate();
    revalidateWatchdog();
    revalidateLock();
  };
  useEffect(() => {
    const id = setInterval(() => pollRef.current(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  // Runs once per mount, and only against a FRESH, successful status: a
  // cached "Locked" status from an earlier open must never trigger a PIN
  // attempt before the real fetch has come back (`isLoading` gates that),
  // and a failed refresh (`error` set) must never act on stale cached data
  // either — the SIM/connection state it describes may no longer hold. If
  // the SIM is locked and a PIN is saved for it, unlock and reconnect
  // automatically instead of leaving the router dead until someone opens
  // this command and notices. Resolves the password and the saved PIN first
  // — only once both check out does the toast appear, so the common
  // "nothing to auto-unlock" case never flashes one.
  useEffect(() => {
    if (!status || isLoading || error || autoUnlockRan.current) return;
    autoUnlockRan.current = true;
    if (status.simStatus !== "Locked") return;

    (async () => {
      if (!(await resolveAutoUnlockPin({ status, pinStore }))) return;
      const password = await getPassword({ toast: false });
      if (!password) return;

      const toast = await showToast({
        style: Toast.Style.Animated,
        title: "Unlocking SIM with saved PIN…",
      });
      const logAuto = (outcome: string, message: string, detail?: string) =>
        logNetgear({
          source: "ui",
          action: "Auto-unlock",
          outcome,
          message,
          detail,
        });
      logAuto("start", "");
      try {
        await withUiActionLock(
          {
            label: "Auto-unlock",
            onWait: (holder) => {
              toast.message = waitMessage(holder);
            },
          },
          async () => {
            const client = await getClient();
            await client.login(password);
            const onProgress = (m: string) => {
              toast.message = m;
              logAuto("step", m);
            };
            const unlocked = await autoUnlockIfPossible({
              client,
              pinStore,
              status: await client.getStatus(),
              onProgress,
            });
            if (!unlocked) {
              toast.hide();
              logAuto("ok", "Nothing to unlock");
              return;
            }
            await ensureConnected({ client, onProgress });
            toast.style = Toast.Style.Success;
            toast.title = "SIM unlocked";
            logAuto("ok", "SIM unlocked");
            revalidate();
          },
        );
      } catch (e) {
        toast.style = Toast.Style.Failure;
        toast.title = "Auto-unlock failed";
        toast.message = describeNetgearError(e);
        logAuto("failed", toast.message, describeErrorDetail(e));
      }
    })();
  }, [status, isLoading, error, revalidate]);

  async function handleReconnect() {
    await withAdmin(
      "Reconnect",
      async (client, onProgress) => {
        await reconnectFlow({ client, onProgress });
        revalidate();
      },
      { successTitle: "Reconnected", selfHeal: true },
    );
  }

  async function handleRestartAndReconnect() {
    const confirmed = await confirmAlert({
      title: "Restart and reconnect the router?",
      message:
        "The mobile connection drops for a few minutes while it restarts.",
      primaryAction: { title: "Restart", style: Alert.ActionStyle.Destructive },
    });
    if (!confirmed) return;
    // Send-and-detach: Tinycast kills the view's JS when it closes, so a
    // multi-minute in-view flow would die with it. The reboot marker hands
    // the recovery (rejoin Wi-Fi, unlock, connect) to the watchdog, and the
    // live view shows a banner from it. withAdmin has already captured the
    // router's Wi-Fi credentials on login, and the lock is released before
    // the success toast.
    await withAdmin(
      "Restart & Reconnect",
      async (client, onProgress) => {
        // A Locked SIM hides its ICCID once the router is down.
        const status = await client.getStatus();
        const iccid = status.iccid || (await pinStore.getLastIccid()) || "";
        onProgress("Rebooting router…");
        await client.reboot();
        await recordReboot({ at: Date.now(), source: "ui", iccid });
        revalidateWatchdog();
        revalidate();
      },
      {
        successTitle: "Router restarting — reconnects automatically (~2 min)",
        selfHeal: true,
      },
    );
  }

  async function handleRejoinWifi() {
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Rejoining Wi-Fi…",
    });
    const logRejoin = (outcome: string, message: string, detail?: string) =>
      logNetgear({
        source: "ui",
        action: "Rejoin Wi-Fi",
        outcome,
        message,
        detail,
      });
    logRejoin("start", "");
    try {
      await withUiActionLock(
        {
          label: "Rejoin Wi-Fi",
          onWait: (holder) => {
            toast.message = waitMessage(holder);
          },
        },
        async () => {
          const client = await getClient();
          await ensureRouterReachable({
            client,
            wifi: wifiRejoiner,
            credsStore: wifiCredsStore,
            onProgress: (m) => {
              toast.message = m;
              logRejoin("step", m);
            },
          });
        },
      );
      toast.style = Toast.Style.Success;
      toast.title = "Router reachable";
      logRejoin("ok", toast.title);
      revalidate();
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Rejoin failed";
      toast.message = describeNetgearError(e);
      logRejoin("failed", toast.message, describeErrorDetail(e));
    }
  }

  // Roaming is meant to stay on; the watchdog re-enables it within a minute,
  // this is the same write without waiting for the next tick.
  async function handleEnableRoaming() {
    await withAdmin(
      "Enable Data Roaming",
      async (client) => {
        await client.setRoaming(true);
        revalidate();
      },
      { successTitle: "Data roaming enabled" },
    );
  }

  async function handleDisableSimPinLock() {
    const confirmed = await confirmAlert({
      title: "Disable SIM PIN lock?",
      message: "The SIM will no longer require a PIN after a power cycle.",
      primaryAction: { title: "Disable", style: Alert.ActionStyle.Destructive },
    });
    if (!confirmed) return;
    push(<SimPinLockForm enable={false} onDone={revalidate} />);
  }

  // Enter PIN and Unblock PUK self-heal (withAdmin's `selfHeal: true`, see
  // sim-forms.tsx), so they stay primary regardless of reachability. With
  // neither SIM state, "Rejoin Router Wi-Fi" takes over as primary while
  // unreachable — Reconnect (also self-healing) stays one tap away in the
  // Connection section below either way.
  const restartIsPrimary = !!status && !unreachable && noService(status);

  function primaryAction(current: RouterStatus) {
    if (current.simStatus === "Locked") {
      return (
        <Action
          // eslint-disable-next-line @raycast/prefer-title-case
          title="Enter SIM PIN"
          icon={Icon.Lock}
          onAction={() => push(<EnterPinForm onDone={revalidate} />)}
        />
      );
    }
    if (current.simStatus === "Blocked") {
      return (
        <Action
          // eslint-disable-next-line @raycast/prefer-title-case
          title="Unblock SIM with PUK"
          icon={Icon.LockUnlocked}
          onAction={() => push(<UnblockPukForm onDone={revalidate} />)}
        />
      );
    }
    if (unreachable) {
      return (
        <Action
          // eslint-disable-next-line @raycast/prefer-title-case
          title="Rejoin Router Wi-Fi"
          icon={Icon.Wifi}
          onAction={handleRejoinWifi}
        />
      );
    }
    // Without mobile network Reconnect fails at once — a restart is what
    // usually clears a router camped on a bad cell (2026-10-07).
    if (restartIsPrimary) {
      return (
        <Action
          // eslint-disable-next-line @raycast/prefer-title-case
          title="Restart & Reconnect"
          icon={Icon.Power}
          style={Action.Style.Destructive}
          onAction={handleRestartAndReconnect}
        />
      );
    }
    return (
      <Action title="Reconnect" icon={Icon.Repeat} onAction={handleReconnect} />
    );
  }

  const markdown = useMemo(() => {
    if (!status) {
      const restart = rebootBanner({
        marker: watchdog?.state.reboot,
        status,
        internet,
        fetchedAt,
        error,
      });
      if (restart?.restarting) {
        return `# Router restarting…\n\n${restart.markdown}`;
      }
      return error
        ? `# ${offlineLabel(watchdog)}\n\n_No status yet — make sure this Mac is on the router's Wi-Fi, then Rejoin or Refresh._`
        : "Loading…";
    }
    const restart = rebootBanner({
      marker: watchdog?.state.reboot,
      status,
      internet,
      fetchedAt,
      error,
    });
    // While restarting, being unreachable is expected — not the scary banner.
    const banner = restart?.restarting
      ? null
      : freshnessBanner({
          fetchedAt,
          error,
          offlineLabel: offlineLabel(watchdog),
        });
    const base = statusMarkdown(status, hasSavedPin ?? false, watchdog, {
      internet,
      lockHolder,
      stale: !!error,
      watchdogInView: true,
    });
    const updating = updatingLine({
      fetchedAt,
      isLoading:
        isLoading &&
        fetchedAt !== undefined &&
        Date.now() - fetchedAt > UPDATING_LINE_AFTER_MS,
    });
    return [restart?.markdown, banner, base, updating]
      .filter(Boolean)
      .join("\n\n");
  }, [
    status,
    internet,
    hasSavedPin,
    watchdog,
    lockHolder,
    isLoading,
    error,
    fetchedAt,
  ]);

  return (
    <Detail
      isLoading={isLoading}
      markdown={markdown}
      actions={
        <ActionPanel>
          <ActionPanel.Section>
            {status ? (
              primaryAction(status)
            ) : (
              <Action
                // eslint-disable-next-line @raycast/prefer-title-case
                title="Rejoin Router Wi-Fi"
                icon={Icon.Wifi}
                onAction={handleRejoinWifi}
              />
            )}
            <Action
              title="Refresh"
              icon={Icon.ArrowClockwise}
              shortcut={{ modifiers: ["cmd"], key: "r" }}
              onAction={revalidate}
            />
          </ActionPanel.Section>
          {status && (
            <ActionPanel.Section title="Connection">
              {(status.simStatus === "Locked" ||
                status.simStatus === "Blocked") && (
                <Action
                  title="Reconnect"
                  icon={Icon.Repeat}
                  onAction={handleReconnect}
                />
              )}
              {unreachable && (
                <Action
                  // eslint-disable-next-line @raycast/prefer-title-case
                  title="Rejoin Router Wi-Fi"
                  icon={Icon.Wifi}
                  onAction={handleRejoinWifi}
                />
              )}
              {!restartIsPrimary && (
                <Action
                  title="Restart & Reconnect"
                  icon={Icon.Power}
                  style={Action.Style.Destructive}
                  onAction={handleRestartAndReconnect}
                />
              )}
            </ActionPanel.Section>
          )}
          {status && !unreachable && status.userRole === "Admin" && (
            <ActionPanel.Section title="SIM & APN">
              {hasSavedPin && (
                <Action
                  // eslint-disable-next-line @raycast/prefer-title-case
                  title="Forget Saved PIN"
                  icon={Icon.Trash}
                  onAction={async () => {
                    await pinStore.delete(status.iccid);
                    await showToast({
                      style: Toast.Style.Success,
                      title: "Saved PIN forgotten",
                    });
                    revalidateSavedPin();
                  }}
                />
              )}
              <Action
                // eslint-disable-next-line @raycast/prefer-title-case
                title="Change SIM PIN"
                icon={Icon.Key}
                onAction={() =>
                  push(
                    <ChangePinForm
                      iccid={status.iccid}
                      onDone={revalidateSavedPin}
                    />,
                  )
                }
              />
              {status.simPinMode === "Enabled" ? (
                <Action
                  // eslint-disable-next-line @raycast/prefer-title-case
                  title="Disable SIM PIN Lock"
                  icon={Icon.LockUnlocked}
                  style={Action.Style.Destructive}
                  onAction={handleDisableSimPinLock}
                />
              ) : (
                <Action
                  // eslint-disable-next-line @raycast/prefer-title-case
                  title="Enable SIM PIN Lock"
                  icon={Icon.Lock}
                  onAction={() =>
                    push(<SimPinLockForm enable={true} onDone={revalidate} />)
                  }
                />
              )}
              <Action
                // eslint-disable-next-line @raycast/prefer-title-case
                title="APN Profiles"
                icon={Icon.CreditCard}
                onAction={() =>
                  push(<ApnProfiles status={status} onDone={revalidate} />)
                }
              />
              {!status.roamingAllowed && (
                <Action
                  // eslint-disable-next-line @raycast/prefer-title-case
                  title="Enable Data Roaming"
                  icon={Icon.Globe}
                  onAction={handleEnableRoaming}
                />
              )}
            </ActionPanel.Section>
          )}
          {status && (
            <ActionPanel.Section title="View">
              {!unreachable &&
                status.userRole === "Admin" &&
                status.smsReady && (
                  <Action
                    // eslint-disable-next-line @raycast/prefer-title-case
                    title="SMS"
                    icon={Icon.SpeechBubble}
                    onAction={() =>
                      push(<SmsInbox status={status} onDone={revalidate} />)
                    }
                  />
                )}
              {!unreachable && status.userRole === "Admin" && (
                <Action
                  title="Connected Devices"
                  icon={Icon.Devices}
                  shortcut={{ modifiers: ["cmd"], key: "d" }}
                  onAction={() => push(<ConnectedDevices status={status} />)}
                />
              )}
              <Action
                title="Signal Meter"
                icon={Icon.LevelMeter}
                shortcut={{ modifiers: ["cmd", "shift"], key: "s" }}
                onAction={() => push(<SignalMeter />)}
              />
              {watchdog && (
                <Action
                  title="Watchdog Log"
                  icon={Icon.List}
                  shortcut={{ modifiers: ["cmd"], key: "l" }}
                  onAction={() => push(<WatchdogLog storage={watchdog} />)}
                />
              )}
              <Action
                title="Show Netgear Log"
                icon={Icon.Document}
                shortcut={{ modifiers: ["cmd", "shift"], key: "l" }}
                onAction={() => push(<NetgearLog />)}
              />
              {watchdog && (
                <Action
                  title={
                    watchdog.enabled ? "Pause Watchdog" : "Resume Watchdog"
                  }
                  icon={watchdog.enabled ? Icon.Pause : Icon.Play}
                  onAction={() =>
                    handleToggleWatchdog(watchdog, revalidateWatchdog)
                  }
                />
              )}
            </ActionPanel.Section>
          )}
          <ActionPanel.Section>
            <Action.OpenInBrowser
              // eslint-disable-next-line @raycast/prefer-title-case
              title="Open Web UI"
              shortcut={{ modifiers: ["cmd"], key: "o" }}
              url={prefs().netgearHost || DEFAULT_HOST}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}
