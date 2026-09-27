import { getPreferenceValues } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { Preferences } from "./preferences";
import { getSecret } from "./secrets";

// Shared argo proxy client — used by ticktick/ (TickTick CRUD) and usage/
// (spend timeseries + summary). Both talk to the same base URL and bearer
// token, so the fetch plumbing lives once, here.

export function prefs(): Preferences {
  return getPreferenceValues<Preferences>();
}

export function argoBaseUrl(): string {
  return prefs().baseUrl.replace(/\/$/, "");
}

// The bearer token is resolved through lib/secrets.ts (override → Keychain →
// 1Password) rather than read straight off the preference, so async.
async function authHeader(): Promise<Record<string, string>> {
  const token = await getSecret("apiToken", prefs());
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

// For the few call sites still using @raycast/utils's `useFetch` directly
// (its `headers` option is a plain object, not awaitable) — resolves the
// bearer token once via the secrets chain and reports it back through
// `isLoading`/`execute` gating instead.
export function useAuthHeaders(): {
  headers: Record<string, string> | undefined;
  isLoading: boolean;
  ready: boolean;
} {
  const { data: token, isLoading } = usePromise(() =>
    getSecret("apiToken", prefs()),
  );
  return {
    headers: token
      ? { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
      : undefined,
    isLoading,
    ready: !!token,
  };
}

export async function argoFetch<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const res = await fetch(argoBaseUrl() + path, {
    ...options,
    headers: {
      ...(await authHeader()),
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
