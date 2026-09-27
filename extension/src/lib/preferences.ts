// Extension-level preferences (package.json → "preferences"). Shared across
// every command — a single interface rather than one manual copy per feature.
export interface Preferences {
  apiToken: string;
  baseUrl: string;
  defaultProjectId?: string;
  netgearHost?: string;
  netgearPassword?: string;
}
