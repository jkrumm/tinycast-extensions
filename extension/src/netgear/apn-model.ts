// Pure helpers behind apn.tsx — option lists, row badges, form validation and
// the mapping from form values to client inputs. No `@raycast/api` import, so
// this runs under vitest (see apn-model.test.ts).

import {
  ApnAuthType,
  ApnIpType,
  ApnRoamingType,
  CreateProfileInput,
  RouterProfile,
  RouterStatus,
  UpdateProfileInput,
} from "./types";

export const AUTH_OPTIONS: { value: ApnAuthType; title: string }[] = [
  { value: "None", title: "None" },
  { value: "PAP", title: "PAP" },
  { value: "CHAP", title: "CHAP" },
  { value: "PAPCHAP", title: "PAP/CHAP" },
];

export const IP_OPTIONS: { value: ApnIpType; title: string }[] = [
  { value: "IPV4", title: "IPv4" },
  { value: "IPV6", title: "IPv6" },
  { value: "IPV4V6", title: "IPv4/IPv6" },
];

export const ROAMING_IP_OPTIONS: { value: ApnRoamingType; title: string }[] = [
  { value: "None", title: "None (no data while roaming)" },
  ...IP_OPTIONS,
];

export const ROAMING_TYPE_INFO =
  "The IP type used while roaming. None means this profile carries no data at all when roaming.";
export const PASSWORD_KEEP_INFO =
  "Leave blank to keep the current password — the router never shows it.";

function titleOf(
  options: { value: string; title: string }[],
  value: string,
): string {
  return options.find((o) => o.value === value)?.title ?? (value || "—");
}

export function authLabel(authtype: string): string {
  return authtype === "None" ? "No auth" : titleOf(AUTH_OPTIONS, authtype);
}

export function ipLabel(type: string): string {
  return titleOf(IP_OPTIONS, type);
}

function asAuth(value: string): ApnAuthType {
  return AUTH_OPTIONS.find((o) => o.value === value)?.value ?? "None";
}

function asIp(value: string): ApnIpType {
  return IP_OPTIONS.find((o) => o.value === value)?.value ?? "IPV4V6";
}

function asRoaming(value: string, fallback: ApnIpType): ApnRoamingType {
  return ROAMING_IP_OPTIONS.find((o) => o.value === value)?.value ?? fallback;
}

export function hasNoRoamingData(profile: RouterProfile): boolean {
  return profile.pdpRoamingType === "None";
}

export type BadgeKind = "active" | "locked" | "auth" | "ip" | "no-roaming";

export interface ProfileBadge {
  kind: BadgeKind;
  text: string;
  tooltip?: string;
}

export function profileBadges(
  profile: RouterProfile,
  activeProfileId: string,
): ProfileBadge[] {
  const badges: ProfileBadge[] = [];
  if (profile.id === activeProfileId) {
    badges.push({ kind: "active", text: "Active" });
  }
  if (!profile.editable) {
    badges.push({
      kind: "locked",
      text: "🔒",
      tooltip: "Locked by the router — duplicate it to change a copy",
    });
  }
  if (hasNoRoamingData(profile)) {
    badges.push({
      kind: "no-roaming",
      text: "No roaming data",
      tooltip:
        "Roaming IP type is None — this profile has no data when roaming",
    });
  }
  badges.push({ kind: "auth", text: authLabel(profile.authtype) });
  badges.push({ kind: "ip", text: ipLabel(profile.type) });
  return badges;
}

// The line above the profile list: who the router is registered with, and
// whether that counts as roaming.
export function networkHeader(status: RouterStatus): {
  title: string;
  subtitle: string;
} {
  const parts = [status.operator || "Not registered"];
  if (status.mcc && status.mnc)
    parts.push(`MCC/MNC ${status.mcc}/${status.mnc}`);
  if (status.country) parts.push(status.country);
  return {
    title: parts.join(" · "),
    subtitle: status.currentlyRoaming ? "Roaming now" : "Home network",
  };
}

export interface ApnFormValues {
  name: string;
  apn: string;
  authtype: ApnAuthType;
  username: string;
  password: string;
  type: ApnIpType;
  pdproamingtype: ApnRoamingType;
}

export function emptyApnFormValues(): ApnFormValues {
  return {
    name: "",
    apn: "",
    authtype: "None",
    username: "",
    password: "",
    type: "IPV4V6",
    pdproamingtype: "IPV4V6",
  };
}

// Edit keeps the profile's own values. Duplicate copies them under a new name;
// the password is never copied (the model only reveals `hasPassword`).
export function formValuesFromProfile(
  profile: RouterProfile,
  mode: "edit" | "duplicate",
): ApnFormValues {
  const type = asIp(profile.type);
  return {
    name: mode === "duplicate" ? `${profile.name} copy` : profile.name,
    apn: profile.apn,
    authtype: asAuth(profile.authtype),
    username: profile.username,
    password: "",
    type,
    pdproamingtype: asRoaming(profile.pdpRoamingType, type),
  };
}

export interface ApnFormErrors {
  name?: string;
  apn?: string;
}

export function validateApnForm(
  values: Pick<ApnFormValues, "name" | "apn">,
): ApnFormErrors {
  const errors: ApnFormErrors = {};
  if (!values.name.trim()) errors.name = "Name is required";
  if (!values.apn.trim()) errors.apn = "APN is required";
  return errors;
}

export function hasErrors(errors: ApnFormErrors): boolean {
  return Object.keys(errors).length > 0;
}

// Username and password are irrelevant (and not sent) with auth type None.
export function toCreateInput(values: ApnFormValues): CreateProfileInput {
  const authenticated = values.authtype !== "None";
  return {
    name: values.name.trim(),
    apn: values.apn.trim(),
    username: authenticated ? values.username.trim() || undefined : undefined,
    password: authenticated ? values.password || undefined : undefined,
    authtype: values.authtype,
    type: values.type,
    pdproamingtype: values.pdproamingtype,
  };
}

// A blank password means "keep the existing one" — it is simply left out.
export function toUpdateInput(
  id: string,
  values: ApnFormValues,
): UpdateProfileInput {
  return { id, ...toCreateInput(values) };
}

// "Fix Roaming Data": same profile, roaming IP type = its IP type.
export function fixRoamingInput(profile: RouterProfile): UpdateProfileInput {
  return {
    id: profile.id,
    name: profile.name,
    apn: profile.apn,
    username: profile.username,
    authtype: asAuth(profile.authtype),
    type: asIp(profile.type),
    pdproamingtype: asIp(profile.type),
  };
}

// The router assigns the id. Like the web UI, diff against the ids that
// existed before the create; several new entries (or none distinguishable)
// fall back to the highest-index name+apn match.
export function findCreatedProfile(opts: {
  before: ReadonlySet<string>;
  after: readonly RouterProfile[];
  name: string;
  apn: string;
}): RouterProfile | null {
  const { before, after, name, apn } = opts;
  const highest = (list: readonly RouterProfile[]) =>
    list.reduce<RouterProfile | null>(
      (best, p) => (!best || p.index > best.index ? p : best),
      null,
    );
  const added = after.filter((p) => !before.has(p.id));
  if (added.length === 1) return added[0];
  const matches = (list: readonly RouterProfile[]) =>
    highest(list.filter((p) => p.name === name && p.apn === apn));
  return matches(added) ?? matches(after);
}
