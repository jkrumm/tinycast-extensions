import { argoFetch } from "../lib/argo";
import {
  CreateTaskInput,
  TickTickProjectData,
  TickTickProject,
  TickTickTask,
} from "./types";

export const client = {
  getProjects: () => argoFetch<TickTickProject[]>("/ticktick/projects"),

  getProjectData: (projectId: string) =>
    argoFetch<TickTickProjectData>(`/ticktick/projects/${projectId}/data`),

  createTask: (data: CreateTaskInput) =>
    argoFetch<TickTickTask>("/ticktick/tasks", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  updateTask: (taskId: string, data: Partial<TickTickTask>) =>
    argoFetch<TickTickTask>(`/ticktick/tasks/${taskId}`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  completeTask: (projectId: string, taskId: string) =>
    argoFetch<void>(
      `/ticktick/projects/${projectId}/tasks/${taskId}/complete`,
      {
        method: "POST",
      },
    ),

  deleteTask: (projectId: string, taskId: string) =>
    argoFetch<void>(`/ticktick/projects/${projectId}/tasks/${taskId}`, {
      method: "DELETE",
    }),
};
