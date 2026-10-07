// Extension-level preferences (package.json → "preferences"). Shared across
// every command — a single interface rather than one manual copy per feature.
//
// `apiToken`/`netgearPassword`/`victronKey` are optional *overrides* — leave them blank
// and `lib/secrets.ts` resolves the real value from Keychain, then
// 1Password, using the matching `*Ref` preference. See docs/architecture.md
// § Secrets.
export interface Preferences {
  apiToken?: string;
  apiTokenRef: string;
  baseUrl: string;
  defaultProjectId?: string;
  netgearHost?: string;
  netgearPassword?: string;
  netgearPasswordRef: string;
  victronKey?: string;
  victronKeyRef: string;
}
