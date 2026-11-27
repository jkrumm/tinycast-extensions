import {
  Action,
  ActionPanel,
  Alert,
  Color,
  Icon,
  Keyboard,
  List,
  Toast,
  confirmAlert,
  showToast,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { ReactNode, useEffect, useRef } from "react";
import { PrintJob, PrinterView } from "./print/parse";
import {
  cancelAllConfirmation,
  jobSubtitle,
  jobTitle,
  pollInterval,
  printerTitle,
  tonerText,
} from "./print/view";
import {
  cancelAll,
  cancelJob,
  loadPrinter,
  loadSelection,
  printSelection,
} from "./print/view-run";

const NOOP = (): void => undefined;

// One toast that starts as "sending" and ends with the CLI's message.
async function runWithToast(
  title: string,
  action: () => Promise<{ ok: boolean; message: string }>,
): Promise<void> {
  const toast = await showToast({ style: Toast.Style.Animated, title });
  const result = await action();
  toast.style = result.ok ? Toast.Style.Success : Toast.Style.Failure;
  toast.title = result.message;
}

export default function Printer() {
  const options = { keepPreviousData: true, onError: NOOP };
  const {
    data: view,
    isLoading,
    revalidate,
  } = useCachedPromise(loadPrinter, [], options);
  // Read once when the view opens (see loadSelection): never revalidated.
  const { data: selection } = useCachedPromise(loadSelection, [], options);

  const busy = useRef(false);
  busy.current = isLoading;
  const interval = pollInterval(view);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!busy.current) revalidate();
    }, interval);
    return () => clearInterval(timer);
  }, [interval, revalidate]);

  const finderPaths = selection ?? [];
  const jobs = view?.ok ? view.jobs : [];

  const print = (sides: "two-sided" | "one-sided") => async () => {
    await runWithToast("Sending to the printer", () =>
      printSelection(sides, finderPaths),
    );
    revalidate();
  };

  const cancelOne = (job: PrintJob) => async () => {
    await runWithToast("Cancelling", () => cancelJob(job.id));
    revalidate();
  };

  const cancelEverything = async () => {
    const confirmed = await confirmAlert({
      ...cancelAllConfirmation(jobs.length),
      primaryAction: {
        title: "Cancel Jobs",
        style: Alert.ActionStyle.Destructive,
      },
    });
    if (!confirmed) return;
    await runWithToast("Cancelling jobs", cancelAll);
    revalidate();
  };

  const printActions: ReactNode[] = [
    <Action
      key="print"
      title="Print Selected Finder File"
      icon={Icon.Print}
      onAction={print("two-sided")}
    />,
    <Action
      key="print-simplex"
      title="Print Selected Finder File One-Sided"
      icon={Icon.Print}
      onAction={print("one-sided")}
    />,
  ];

  const actionsFor = (job?: PrintJob) => (
    <ActionPanel>
      <ActionPanel.Section title="Print">{printActions}</ActionPanel.Section>
      <ActionPanel.Section title="Jobs">
        {job ? (
          <Action
            title="Cancel Job"
            icon={Icon.XMarkCircle}
            style={Action.Style.Destructive}
            onAction={cancelOne(job)}
          />
        ) : null}
        {jobs.length > 0 ? (
          <Action
            title="Cancel All Jobs"
            icon={Icon.Trash}
            style={Action.Style.Destructive}
            shortcut={{ modifiers: ["cmd"], key: "backspace" }}
            onAction={cancelEverything}
          />
        ) : null}
        <Action
          title="Refresh"
          icon={Icon.ArrowClockwise}
          shortcut={Keyboard.Shortcut.Common.Refresh}
          onAction={() => revalidate()}
        />
      </ActionPanel.Section>
    </ActionPanel>
  );

  return (
    <List
      isLoading={isLoading && view === undefined}
      navigationTitle="Printer"
      searchBarPlaceholder="Printer and jobs"
    >
      {view === undefined ? null : (
        <>
          <List.Section title="Printer">
            <List.Item
              title={printerTitle(view)}
              subtitle={view.ok ? view.printer : view.message}
              icon={Icon.Print}
              accessories={printerAccessories(view)}
              actions={actionsFor()}
            />
          </List.Section>
          <List.Section title="Jobs">
            {jobs.map((job) => (
              <List.Item
                key={job.id}
                title={jobTitle(job)}
                subtitle={jobSubtitle(job)}
                icon={Icon.Document}
                actions={actionsFor(job)}
              />
            ))}
            {view.ok && jobs.length === 0 ? (
              <List.Item
                title="No jobs"
                subtitle="Nothing waiting on the printer"
                icon={Icon.CheckCircle}
                actions={actionsFor()}
              />
            ) : null}
          </List.Section>
        </>
      )}
    </List>
  );
}

// Toner is a quiet text unless it is low: then an orange warning tag.
function printerAccessories(view: PrinterView): List.Item.Accessory[] {
  if (!view.ok) return [];
  if (view.tonerLow) {
    return [
      {
        tag: { value: tonerText(view.tonerPercent), color: Color.Orange },
        icon: Icon.Warning,
      },
    ];
  }
  return [{ text: tonerText(view.tonerPercent) }];
}
