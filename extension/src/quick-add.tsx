import {
  Action,
  ActionPanel,
  Form,
  showHUD,
  showToast,
  Toast,
  popToRoot,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useState, useMemo } from "react";
import { prefs } from "./lib/argo";
import { client } from "./ticktick/client";
import { parse } from "./ticktick/parse";
import { formatDue, priorityLabel } from "./ticktick/format";
import { stamped } from "./lib/freshness";

export default function QuickAdd() {
  const [input, setInput] = useState("");
  const [note, setNote] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const {
    data: projectsData,
    isLoading,
    error: projectsError,
  } = useCachedPromise(() => stamped(client.getProjects), [], {
    keepPreviousData: true,
    onError: () => {},
  });
  const projects = projectsData?.data ?? [];
  const defaultProjectId = prefs().defaultProjectId ?? projects[0]?.id ?? "";

  const parsed = useMemo(() => parse(input, projects), [input, projects]);

  const resolvedProject =
    parsed.project ??
    (defaultProjectId
      ? projects.find((p) => p.id === defaultProjectId)
      : null) ??
    null;

  const dateLabel = parsed.dueDate
    ? (formatDue(parsed.dueDate.toISOString()) ??
      parsed.dueDate.toLocaleDateString("de-DE", {
        day: "numeric",
        month: "long",
      }))
    : null;

  async function handleSubmit() {
    const title = parsed.title.trim() || input.trim();
    if (!title) {
      await showToast({ style: Toast.Style.Failure, title: "Titel fehlt" });
      return;
    }
    const projectId = resolvedProject?.id ?? defaultProjectId;
    if (!projectId) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Kein Projekt — Standard in den Einstellungen setzen",
      });
      return;
    }
    setIsSubmitting(true);
    try {
      await client.createTask({
        title,
        projectId,
        dueDate: parsed.dueDate
          ? parsed.dueDate.toLocaleDateString("sv-SE", {
              timeZone: "Europe/Berlin",
            })
          : undefined,
        timeZone: "Europe/Berlin",
        priority:
          parsed.priority > 0 ? (parsed.priority as 1 | 3 | 5) : undefined,
        content: note.trim() || undefined,
      });
      await showHUD(`Hinzugefügt: ${title}`);
      await popToRoot();
    } catch (e) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Fehler",
        message: String(e),
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Form
      navigationTitle="Aufgabe hinzufügen"
      isLoading={isSubmitting || isLoading}
      actions={
        <ActionPanel>
          <Action title="Aufgabe Hinzufügen" onAction={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="input"
        title="Aufgabe"
        placeholder="#HomeLab morgen !m Carpe diem"
        value={input}
        onChange={setInput}
        autoFocus
      />

      <Form.Separator />

      <Form.Description
        title="Projekt"
        text={`${resolvedProject?.name ?? "—"}${projectsError ? " (offline)" : ""}`}
      />
      <Form.Description title="Datum" text={dateLabel ?? "—"} />
      <Form.Description
        title="Priorität"
        text={parsed.priority > 0 ? priorityLabel(parsed.priority) : "—"}
      />

      <Form.Separator />

      <Form.TextArea
        id="note"
        title="Beschreibung"
        placeholder="Weitere Details..."
        value={note}
        onChange={setNote}
      />
    </Form>
  );
}
