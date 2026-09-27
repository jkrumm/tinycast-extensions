import {
  Action,
  ActionPanel,
  Form,
  showHUD,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useFetch } from "@raycast/utils";
import { useState } from "react";
import { prefs, useAuthHeaders } from "../lib/argo";
import { client } from "./client";
import { TickTickProject, TickTickTask } from "./types";
import { priorityLabel } from "./format";

interface Props {
  task?: TickTickTask;
  onDone?: () => void;
}

export default function CreateTask({ task, onDone }: Props) {
  const { pop } = useNavigation();
  const isEditing = !!task;
  const [isSubmitting, setIsSubmitting] = useState(false);

  const base = prefs().baseUrl.replace(/\/$/, "");
  const { headers, isLoading: authLoading, ready } = useAuthHeaders();

  const { data: projectsRaw } = useFetch<{ data: TickTickProject[] }>(
    `${base}/ticktick/projects`,
    {
      headers,
      execute: ready,
      keepPreviousData: true,
    },
  );

  const projectList = projectsRaw?.data ?? [];

  const defaultProjectId = (() => {
    if (task) return task.projectId;
    const pref = prefs().defaultProjectId;
    if (pref) return pref;
    return projectList[0]?.id ?? "";
  })();

  async function handleSubmit(values: {
    title: string;
    content: string;
    projectId: string;
    priority: string;
    dueDate: Date | null;
  }) {
    if (!values.title.trim()) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Titel erforderlich",
      });
      return;
    }

    const projectId = values.projectId || defaultProjectId;
    if (!projectId) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Projekt auswählen",
      });
      return;
    }

    setIsSubmitting(true);
    try {
      let savedTask: TickTickTask;
      if (isEditing) {
        savedTask = await client.updateTask(task.id, {
          title: values.title.trim(),
          content: values.content.trim() || "",
          priority: Number(values.priority) as 0 | 1 | 3 | 5,
          dueDate: values.dueDate
            ? values.dueDate.toLocaleDateString("sv-SE", {
                timeZone: "Europe/Berlin",
              })
            : null,
          projectId,
        });
      } else {
        savedTask = await client.createTask({
          title: values.title.trim(),
          content: values.content.trim() || undefined,
          priority: Number(values.priority) as 0 | 1 | 3 | 5,
          dueDate: values.dueDate
            ? values.dueDate.toLocaleDateString("sv-SE", {
                timeZone: "Europe/Berlin",
              })
            : null,
          projectId,
          timeZone: "Europe/Berlin",
        });
      }
      await showHUD(
        isEditing
          ? `Aktualisiert: ${savedTask.title}`
          : `Erstellt: ${savedTask.title}`,
      );
      onDone?.();
      pop();
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
      navigationTitle={isEditing ? "Aufgabe bearbeiten" : "Aufgabe erstellen"}
      isLoading={isSubmitting || authLoading || projectList.length === 0}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title={isEditing ? "Speichern" : "Erstellen"}
            onSubmit={handleSubmit}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="title"
        title="Titel"
        placeholder="Was ist zu tun?"
        defaultValue={task?.title ?? ""}
        autoFocus
      />

      <Form.TextArea
        id="content"
        title="Notizen"
        placeholder="Details, Links oder Kontext… (Markdown)"
        defaultValue={task?.content ?? ""}
        enableMarkdown
      />

      <Form.Separator />

      <Form.Dropdown
        id="projectId"
        title="Projekt"
        defaultValue={defaultProjectId}
      >
        {projectList.map((p) => (
          <Form.Dropdown.Item key={p.id} value={p.id} title={p.name} />
        ))}
      </Form.Dropdown>

      <Form.Dropdown
        id="priority"
        title="Priorität"
        defaultValue={String(task?.priority ?? 0)}
      >
        {([0, 1, 3, 5] as const).map((p) => (
          <Form.Dropdown.Item
            key={p}
            value={String(p)}
            title={priorityLabel(p)}
          />
        ))}
      </Form.Dropdown>

      <Form.DatePicker
        id="dueDate"
        title="Fälligkeit"
        type={Form.DatePicker.Type.Date}
        defaultValue={task?.dueDate ? new Date(task.dueDate) : null}
      />
    </Form>
  );
}
