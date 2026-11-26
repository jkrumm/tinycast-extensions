import {
  Action,
  ActionPanel,
  Alert,
  Detail,
  Grid,
  Icon,
  Keyboard,
  Toast,
  confirmAlert,
  open,
  showToast,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { ReactNode, useEffect, useRef } from "react";
import { ScanMode } from "./scan/escl";
import {
  POLL_AFTER_ACTION_MS,
  DocTile,
  FlowAction,
  FlowActionId,
  SCAN_MODE_OF,
  attentionTile,
  documentSignature,
  filedDetailMarkdown,
  filedSectionTitle,
  filedTile,
  pageTitle,
  partTitle,
  pollInterval,
  reviewDetailMarkdown,
  resultToToast,
  reviewTile,
  scannerActions,
  scanningTitle,
  submitConfirmation,
  thumbMap,
  waitingDetailMarkdown,
  waitingTile,
  isScanning,
} from "./scan/view";
import {
  ActionResult,
  discardScan,
  loadDocThumbs,
  loadDocuments,
  loadStatus,
  releaseDocument,
  scanLogPath,
  startScan,
  submitScan,
} from "./scan/view-run";

const DOCUMENTS_POLL_MS = 30_000;
const NOOP = (): void => undefined;

// What an action in the flow looks like; `run` below does it.
const FLOW: Record<
  FlowActionId,
  {
    title: string;
    icon: Icon;
    shortcut?: Keyboard.Shortcut;
    destructive?: boolean;
  }
> = {
  "scan-document": { title: "Scan Document", icon: Icon.Document },
  "scan-fronts": { title: "Scan Fronts", icon: Icon.Document },
  "scan-flatbed": { title: "Scan Flatbed", icon: Icon.Image },
  "scan-backs": {
    title: "Scan Backs",
    icon: Icon.ArrowLeft,
    shortcut: { modifiers: ["cmd"], key: "b" },
  },
  "scan-more": {
    title: "Scan More",
    icon: Icon.Plus,
    shortcut: { modifiers: ["cmd"], key: "m" },
  },
  submit: {
    title: "Submit Scan",
    icon: Icon.Check,
    shortcut: { modifiers: ["cmd"], key: "s" },
  },
  "submit-fronts": {
    title: "Submit Fronts Only",
    icon: Icon.Check,
    shortcut: { modifiers: ["cmd"], key: "s" },
  },
  discard: {
    title: "Discard Scan",
    icon: Icon.Trash,
    shortcut: { modifiers: ["cmd"], key: "backspace" },
    destructive: true,
  },
  "open-log": { title: "Open Scan Log", icon: Icon.Text },
  refresh: {
    title: "Refresh",
    icon: Icon.ArrowClockwise,
    shortcut: Keyboard.Shortcut.Common.Refresh,
  },
};

async function toast(result: ActionResult): Promise<void> {
  await showToast({
    style: result.ok ? Toast.Style.Success : Toast.Style.Failure,
    title: result.message,
  });
}

export default function Scanner() {
  const options = { keepPreviousData: true, onError: NOOP };
  const {
    data: status,
    error,
    isLoading: statusLoading,
    revalidate: revalidateStatus,
  } = useCachedPromise(loadStatus, [], options);
  const {
    data: docs,
    isLoading: docsLoading,
    revalidate: revalidateDocs,
  } = useCachedPromise(loadDocuments, [], options);
  // Document thumbnails load after the first paint and are fetched again only
  // when the list of documents changed.
  const signature = documentSignature(docs);
  // The signature argument is only the cache key: a new one runs the loader.
  const { data: docThumbs } = useCachedPromise(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    (_signature: string) => loadDocThumbs(),
    [signature],
    { ...options, execute: signature !== "" },
  );
  const thumbs = thumbMap(docThumbs);

  // The newest answer wins: a tick is skipped while the previous read runs.
  const statusBusy = useRef(false);
  statusBusy.current = statusLoading;
  const docsBusy = useRef(false);
  docsBusy.current = docsLoading;
  const fastUntil = useRef(0);

  // How a scan ended, as a toast: only a result that appears after the view
  // opened (the first live answer is the baseline).
  const seenResultAt = useRef<number | null>(null);
  useEffect(() => {
    if (!status || statusLoading) return;
    const next = resultToToast(status.lastResult, seenResultAt.current);
    seenResultAt.current = next.seenAt;
    if (next.toast) void toast(next.toast);
  }, [status, statusLoading]);

  const interval = pollInterval({
    status,
    fastUntil: fastUntil.current,
    now: Date.now(),
  });
  useEffect(() => {
    const timer = setInterval(() => {
      if (!statusBusy.current) revalidateStatus();
    }, interval);
    return () => clearInterval(timer);
  }, [interval, revalidateStatus]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!docsBusy.current) revalidateDocs();
    }, DOCUMENTS_POLL_MS);
    return () => clearInterval(timer);
  }, [revalidateDocs]);

  const refresh = (): void => {
    revalidateStatus();
    revalidateDocs();
  };

  const run = (id: FlowActionId) => async (): Promise<void> => {
    if (id === "refresh") return refresh();
    if (id === "open-log") return open(scanLogPath());
    const mode = SCAN_MODE_OF[id];
    if (mode) {
      await toast(await startScan(mode as ScanMode));
      // the scan process needs a moment to take the lock: look often for a while
      fastUntil.current = Date.now() + POLL_AFTER_ACTION_MS;
      return refresh();
    }
    if (id === "discard") {
      const sure = await confirmAlert({
        title: "Discard the scan?",
        message: "The pages are dropped and nothing is filed.",
        primaryAction: {
          title: "Discard",
          style: Alert.ActionStyle.Destructive,
        },
      });
      if (!sure) return;
      await toast(await discardScan());
      return refresh();
    }
    // After a failed Scan More the pending scan lacks sheets: ask first.
    const ask = submitConfirmation(status);
    if (ask) {
      const sure = await confirmAlert({
        title: ask.title,
        message: ask.message,
        primaryAction: { title: "File Anyway" },
      });
      if (!sure) return;
    }
    await toast(await submitScan(ask !== null));
    refresh();
  };

  const entries = scannerActions(status);
  const flowAction = (entry: FlowAction): ReactNode => {
    const def = FLOW[entry.id];
    return (
      <Action
        key={entry.id}
        title={def.title}
        icon={def.icon}
        shortcut={def.shortcut}
        style={def.destructive ? Action.Style.Destructive : undefined}
        onAction={run(entry.id)}
      />
    );
  };
  const flow = (group: FlowAction["group"]): FlowAction[] =>
    entries.filter((e) => e.group === group);
  const flowSections = {
    main: (
      <ActionPanel.Section key="flow" title="Scanner">
        {flow("main").map(flowAction)}
      </ActionPanel.Section>
    ),
    newScan: (
      <ActionPanel.Section
        key="new-scan"
        title="New scan (files this one first)"
      >
        {flow("new-scan").map(flowAction)}
      </ActionPanel.Section>
    ),
    footer: (
      <ActionPanel.Section key="footer">
        {flow("footer").map(flowAction)}
      </ActionPanel.Section>
    ),
  };
  // The flow alone: what Enter does on an empty grid or a page tile.
  const flowPanel = (extra?: ReactNode) => (
    <ActionPanel>
      {flowSections.main}
      {flowSections.newScan}
      {extra}
      {flowSections.footer}
    </ActionPanel>
  );

  const parts = status?.pending?.parts ?? [];
  const warning = attentionTile(status);
  const scanning = isScanning(status);
  const headline = scanningTitle(status);

  const documentTile = (
    key: string,
    tile: DocTile,
    path: string,
    actions: ReactNode,
  ) => (
    <Grid.Item
      key={key}
      content={thumbs[path] ?? Icon.Document}
      title={tile.title}
      subtitle={tile.subtitle}
      keywords={tile.keywords}
      actions={
        <ActionPanel>
          {actions}
          {flowSections.main}
          {flowSections.newScan}
          {flowSections.footer}
        </ActionPanel>
      }
    />
  );

  const finderAndPath = (path: string, openable: boolean): ReactNode => (
    <>
      {openable ? <Action.ShowInFinder path={path} /> : null}
      <Action.CopyToClipboard title="Copy Path" content={path} />
    </>
  );

  const detailActions = (path: string, openable: boolean): ReactNode => (
    <ActionPanel>
      {openable ? <Action.Open title="Open" target={path} /> : null}
      <Action.CopyToClipboard title="Copy Path" content={path} />
    </ActionPanel>
  );

  const release = async (name: string): Promise<void> => {
    const sure = await confirmAlert({
      title: "File as one document?",
      message: `${name} is accepted as a single document and filed.`,
      primaryAction: { title: "File as One Document" },
    });
    if (!sure) return;
    await toast(await releaseDocument(name));
    refresh();
  };

  const review = docs?.ok ? docs.review : [];
  const waiting = docs?.ok ? docs.waiting : [];
  const filed = docs?.ok ? docs.filed : [];

  return (
    <Grid
      columns={5}
      aspectRatio="3/4"
      fit={Grid.Fit.Contain}
      isLoading={status === undefined || docs === undefined}
      navigationTitle={headline ?? "Scanner"}
      searchBarPlaceholder={headline ?? "Search documents"}
      actions={flowPanel()}
    >
      <Grid.EmptyView
        icon={Icon.Document}
        title={
          error && !status
            ? "Scanner unavailable"
            : (headline ?? "Nothing scanned yet")
        }
        description={
          error && !status
            ? error.message
            : scanning
              ? "Keep the stack in the feeder"
              : "Put the stack in the feeder and press Enter to scan"
        }
        actions={flowPanel()}
      />

      {parts.map((part, partIndex) => (
        <Grid.Section
          key={`part-${partIndex}`}
          title={partTitle(parts, partIndex, warning !== null)}
        >
          {partIndex === 0 && warning ? (
            <Grid.Item
              key="attention"
              content={Icon.Warning}
              title={warning.title}
              subtitle={warning.subtitle}
              actions={flowPanel()}
            />
          ) : null}
          {part.pagePaths.map((pagePath, i) => (
            <Grid.Item
              key={`part-${partIndex}-page-${i}`}
              content={part.thumbPaths[i] ?? Icon.Document}
              title={pageTitle(i)}
              actions={flowPanel(
                <ActionPanel.Section title="Page">
                  <Action.Open title="Open Page" target={pagePath} />
                  <Action.Open title="Open PDF" target={part.pdfPath} />
                </ActionPanel.Section>,
              )}
            />
          ))}
        </Grid.Section>
      ))}

      {review.length > 0 ? (
        <Grid.Section title="Needs review">
          {review.map((doc) => {
            const tile = reviewTile(doc);
            return documentTile(
              `review-${doc.path}`,
              tile,
              doc.path,
              <ActionPanel.Section title="Document">
                <Action.Push
                  title="Show Details"
                  icon={Icon.Sidebar}
                  target={
                    <Detail
                      navigationTitle={doc.name}
                      markdown={reviewDetailMarkdown(doc)}
                      actions={detailActions(doc.path, true)}
                    />
                  }
                />
                <Action.Open title="Open" target={doc.path} />
                <Action
                  title="File as One Document"
                  icon={Icon.Check}
                  onAction={() => release(doc.name)}
                />
                {finderAndPath(doc.path, true)}
              </ActionPanel.Section>,
            );
          })}
        </Grid.Section>
      ) : null}

      {waiting.length > 0 ? (
        <Grid.Section title="Waiting in the inbox">
          {waiting.map((doc) =>
            documentTile(
              `waiting-${doc.path}`,
              waitingTile(doc),
              doc.path,
              <ActionPanel.Section title="Document">
                <Action.Open title="Open" target={doc.path} />
                {finderAndPath(doc.path, true)}
                <Action.Push
                  title="Show Details"
                  icon={Icon.Sidebar}
                  target={
                    <Detail
                      navigationTitle={doc.name}
                      markdown={waitingDetailMarkdown(doc)}
                      actions={detailActions(doc.path, true)}
                    />
                  }
                />
              </ActionPanel.Section>,
            ),
          )}
        </Grid.Section>
      ) : null}

      {filed.length > 0 ? (
        <Grid.Section
          title={filedSectionTitle(docs?.ok ? docs.filedAsOf : null)}
        >
          {filed.map((doc) => {
            const tile = filedTile(doc);
            return documentTile(
              `filed-${doc.notePath}`,
              tile,
              doc.path,
              <ActionPanel.Section title="Document">
                {tile.openable ? (
                  <Action.Open title="Open" target={doc.path} />
                ) : null}
                {finderAndPath(doc.path, tile.openable)}
                <Action.Push
                  title="Show Details"
                  icon={Icon.Sidebar}
                  target={
                    <Detail
                      navigationTitle={doc.title}
                      markdown={filedDetailMarkdown(doc)}
                      actions={detailActions(doc.path, tile.openable)}
                    />
                  }
                />
              </ActionPanel.Section>,
            );
          })}
        </Grid.Section>
      ) : null}

      {docs &&
      (!docs.ok || (docs.ok && docs.filed.length === 0 && docs.filedNote)) ? (
        <Grid.Section title="Recently filed">
          <Grid.Item
            key="documents-note"
            content={Icon.Warning}
            title={docs.ok ? (docs.filedNote ?? "") : docs.message}
            actions={flowPanel()}
          />
        </Grid.Section>
      ) : null}
    </Grid>
  );
}
