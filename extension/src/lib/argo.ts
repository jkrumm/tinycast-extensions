import { getPreferenceValues } from "@raycast/api";
import { Preferences } from "./preferences";

// Shared argo proxy client — used by ticktick/ (TickTick CRUD) and usage/
// (spend timeseries + summary). Both talk to the same base URL and bearer
// token, so the fetch plumbing lives once, here.

export function prefs(): Preferences {
  return getPreferenceValues<Preferences>();
}

export function argoBaseUrl(): string {
  return prefs().baseUrl.replace(/\/$/, "");
}

export function authHeader(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${prefs().apiToken}`,
  };
}

export async function argoFetch<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const res = await fetch(argoBaseUrl() + path, {
    ...options,
    headers: {
      ...authHeader(),
      ...(options?.headers as Record<string, string>),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "Unknown error");
    throw new Error(`${res.status}: ${text}`);
  }
  if (res.status === 204 || res.headers.get("content-length") === "0")
    return undefined as T;
  const json = await res.json();
  // Proxy wraps all responses in { data: T }
  if (
    json &&
    typeof json === "object" &&
    !Array.isArray(json) &&
    "data" in json
  ) {
    return (json as { data: T }).data;
  }
  return json as T;
}
