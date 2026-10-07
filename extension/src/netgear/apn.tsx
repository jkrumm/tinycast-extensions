import { useRef, useState } from "react";
import {
  Action,
  ActionPanel,
  Alert,
  Color,
  confirmAlert,
  Form,
  Icon,
  List,
  useNavigation,
} from "@raycast/api";
import { reconnect as reconnectFlow } from "./flows";
import { withAdmin, AdminFn } from "./session";
import {
  ApnAuthType,
  ApnIpType,
  ApnRoamingType,
  RouterProfile,
  RouterStatus,
} from "./types";
import {
  ApnFormErrors,
  ApnFormValues,
  AUTH_OPTIONS,
  emptyApnFormValues,
  findCreatedProfile,
  fixRoamingInput,
  formValuesFromProfile,
  hasErrors,
  hasNoRoamingData,
  IP_OPTIONS,
  networkHeader,
  PASSWORD_KEEP_INFO,
  ProfileBadge,
  profileBadges,
  ROAMING_IP_OPTIONS,
  ROAMING_TYPE_INFO,
  toCreateInput,
  toUpdateInput,
  validateApnForm,
} from "./apn-model";

function toAccessory(badge: ProfileBadge): List.Item.Accessory {
  switch (badge.kind) {
    case "active":
      return { tag: { value: badge.text, color: Color.Green } };
    case "no-roaming":
      return {
        tag: { value: badge.text, color: Color.Orange },
        icon: Icon.Warning,
        tooltip: badge.tooltip,
      };
    case "locked":
      return { text: badge.text, tooltip: badge.tooltip };
    default:
      return { text: badge.text };
  }
}

export function ApnProfiles({
  status,
  onDone,
}: {
  status: RouterStatus;
  onDone: () => void;
}) {
  const { push } = useNavigation();
  // The list outlives every mutation, so it keeps its own copy of the status
  // and re-reads it (inside the admin session) after each change.
  const [current, setCurrent] = useState(status);

  async function syncFrom(client: { getStatus: () => Promise<RouterStatus> }) {
    try {
      setCurrent(await client.getStatus());
    } catch {
      // The action's own outcome is what the toast reports.
    }
    onDone();
  }

  function mutate(label: string, fn: AdminFn, successTitle: string) {
    return withAdmin(
      label,
      async (client, onProgress, password) => {
        try {
          await fn(client, onProgress, password);
        } finally {
          await syncFrom(client);
        }
      },
      { successTitle },
    );
  }

  function setActive(profile: RouterProfile) {
    return mutate(
      "Set as Active APN",
      async (client, onProgress) => {
        await client.setActiveProfile(profile.id);
        onProgress("Reconnecting…");
        await reconnectFlow({ client, onProgress });
      },
      "Active APN updated",
    );
  }

  async function remove(profile: RouterProfile) {
    const confirmed = await confirmAlert({
      title: `Delete "${profile.name || profile.apn}"?`,
      message: "The APN profile is removed from the router.",
      primaryAction: { title: "Delete", style: Alert.ActionStyle.Destructive },
    });
    if (!confirmed) return;
    await mutate(
      "Delete APN Profile",
      (client) => client.deleteProfile(profile.id),
      "APN profile deleted",
    );
  }

  function fixRoaming(profile: RouterProfile) {
    return mutate(
      "Fix Roaming Data",
      async (client, onProgress) => {
        await client.updateProfile(fixRoamingInput(profile));
        if (profile.id !== current.activeProfileId) return;
        onProgress("Reconnecting…");
        await reconnectFlow({ client, onProgress });
      },
      "Roaming data enabled for this profile",
    );
  }

  const openForm = (mode: ApnFormMode) =>
    push(
      <ApnProfileForm
        mode={mode}
        status={current}
        onSaved={(fresh) => {
          setCurrent(fresh);
          onDone();
        }}
      />,
    );

  const addAction = (
    <Action
      // eslint-disable-next-line @raycast/prefer-title-case
      title="Add APN Profile"
      icon={Icon.Plus}
      onAction={() => openForm({ kind: "add" })}
    />
  );

  const header = networkHeader(current);

  return (
    <List navigationTitle="APN Profiles">
      {current.profiles.length === 0 ? (
        <List.EmptyView
          title="No APN profiles"
          actions={<ActionPanel>{addAction}</ActionPanel>}
        />
      ) : (
        <List.Section title={header.title} subtitle={header.subtitle}>
          {current.profiles.map((p) => (
            <List.Item
              key={p.id}
              title={p.name || p.apn}
              subtitle={p.apn}
              accessories={profileBadges(p, current.activeProfileId).map(
                toAccessory,
              )}
              actions={
                <ActionPanel>
                  <ActionPanel.Section>
                    <Action
                      // eslint-disable-next-line @raycast/prefer-title-case
                      title="Set as Active APN"
                      icon={Icon.CheckCircle}
                      onAction={() => setActive(p)}
                    />
                    {p.editable && (
                      <Action
                        title="Edit"
                        icon={Icon.Pencil}
                        shortcut={{ modifiers: ["cmd"], key: "e" }}
                        onAction={() => openForm({ kind: "edit", profile: p })}
                      />
                    )}
                    <Action
                      title="Duplicate as New"
                      icon={Icon.CopyClipboard}
                      shortcut={{ modifiers: ["cmd"], key: "d" }}
                      onAction={() =>
                        openForm({ kind: "duplicate", profile: p })
                      }
                    />
                    {hasNoRoamingData(p) && p.editable && (
                      <Action
                        title="Fix Roaming Data"
                        icon={Icon.Globe}
                        onAction={() => fixRoaming(p)}
                      />
                    )}
                  </ActionPanel.Section>
                  <ActionPanel.Section>
                    {addAction}
                    {p.deletable && (
                      <Action
                        title="Delete"
                        icon={Icon.Trash}
                        style={Action.Style.Destructive}
                        shortcut={{ modifiers: ["ctrl"], key: "x" }}
                        onAction={() => remove(p)}
                      />
                    )}
                  </ActionPanel.Section>
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}
    </List>
  );
}

type ApnFormMode =
  | { kind: "add" }
  | { kind: "edit"; profile: RouterProfile }
  | { kind: "duplicate"; profile: RouterProfile };

const FORM_TITLES: Record<ApnFormMode["kind"], string> = {
  add: "Add APN Profile",
  edit: "Edit APN Profile",
  duplicate: "Duplicate APN Profile",
};

// One form for add, edit and duplicate — duplicate is how a locked profile
// gets "edited": a prefilled add form.
function ApnProfileForm({
  mode,
  status,
  onSaved,
}: {
  mode: ApnFormMode;
  status: RouterStatus;
  onSaved: (fresh: RouterStatus) => void;
}) {
  const { pop } = useNavigation();
  const initial: ApnFormValues =
    mode.kind === "add"
      ? emptyApnFormValues()
      : formValuesFromProfile(mode.profile, mode.kind);
  const [authtype, setAuthtype] = useState<ApnAuthType>(initial.authtype);
  const [type, setType] = useState<ApnIpType>(initial.type);
  const [roamingType, setRoamingType] = useState<ApnRoamingType>(
    initial.pdproamingtype,
  );
  // The roaming IP type follows the IP type until the user picks one — and an
  // existing profile that already differs (e.g. None) is never overridden.
  const roamingTouched = useRef(initial.pdproamingtype !== initial.type);
  const [errors, setErrors] = useState<ApnFormErrors>({});

  const title = FORM_TITLES[mode.kind];
  const editing = mode.kind === "edit";

  async function handleSubmit(raw: {
    name?: string;
    apn?: string;
    username?: string;
    password?: string;
    activate?: boolean;
  }) {
    const values: ApnFormValues = {
      name: raw.name ?? "",
      apn: raw.apn ?? "",
      authtype,
      username: raw.username ?? "",
      password: raw.password ?? "",
      type,
      pdproamingtype: roamingType,
    };
    const found = validateApnForm(values);
    setErrors(found);
    if (hasErrors(found)) return;

    await withAdmin(
      title,
      async (client, onProgress) => {
        if (mode.kind === "edit") {
          const wasActive = mode.profile.id === status.activeProfileId;
          await client.updateProfile(toUpdateInput(mode.profile.id, values));
          if (wasActive) {
            onProgress("Reconnecting…");
            await reconnectFlow({ client, onProgress });
          }
          onSaved(await client.getStatus());
          pop();
          return;
        }

        const before = new Set(
          (await client.getStatus()).profiles.map((p) => p.id),
        );
        await client.createProfile(toCreateInput(values));
        const fresh = await client.getStatus();
        onSaved(fresh);
        pop();
        if (!raw.activate) return;

        const created = findCreatedProfile({
          before,
          after: fresh.profiles,
          name: values.name.trim(),
          apn: values.apn.trim(),
        });
        if (!created) {
          throw new Error(
            "The profile was created, but could not be found to activate it.",
          );
        }
        onProgress("Activating…");
        await client.setActiveProfile(created.id);
        await reconnectFlow({ client, onProgress });
        onSaved(await client.getStatus());
      },
      { successTitle: editing ? "APN profile saved" : "APN profile created" },
    );
  }

  return (
    <Form
      navigationTitle={title}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title={editing ? "Save" : "Create"}
            onSubmit={handleSubmit}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="name"
        title="Name"
        autoFocus
        defaultValue={initial.name}
        error={errors.name}
        onChange={() =>
          errors.name && setErrors({ ...errors, name: undefined })
        }
      />
      <Form.TextField
        id="apn"
        title="APN"
        defaultValue={initial.apn}
        error={errors.apn}
        onChange={() => errors.apn && setErrors({ ...errors, apn: undefined })}
      />
      <Form.Dropdown
        id="authtype"
        title="Auth Type"
        value={authtype}
        onChange={(v) => setAuthtype(v as ApnAuthType)}
      >
        {AUTH_OPTIONS.map((o) => (
          <Form.Dropdown.Item key={o.value} value={o.value} title={o.title} />
        ))}
      </Form.Dropdown>
      {authtype !== "None" && (
        <>
          <Form.TextField
            id="username"
            title="Username"
            defaultValue={initial.username}
          />
          <Form.PasswordField
            id="password"
            title="Password"
            placeholder={
              mode.kind === "edit" && mode.profile.hasPassword
                ? "Unchanged — leave blank to keep it"
                : undefined
            }
            info={editing ? PASSWORD_KEEP_INFO : undefined}
          />
        </>
      )}
      <Form.Dropdown
        id="type"
        title="IP Type"
        value={type}
        onChange={(v) => {
          setType(v as ApnIpType);
          if (!roamingTouched.current) setRoamingType(v as ApnIpType);
        }}
      >
        {IP_OPTIONS.map((o) => (
          <Form.Dropdown.Item key={o.value} value={o.value} title={o.title} />
        ))}
      </Form.Dropdown>
      <Form.Dropdown
        id="pdproamingtype"
        title="Roaming IP Type"
        info={ROAMING_TYPE_INFO}
        value={roamingType}
        onChange={(v) => {
          roamingTouched.current = true;
          setRoamingType(v as ApnRoamingType);
        }}
      >
        {ROAMING_IP_OPTIONS.map((o) => (
          <Form.Dropdown.Item key={o.value} value={o.value} title={o.title} />
        ))}
      </Form.Dropdown>
      {roamingType === "None" && (
        <Form.Description text="With Roaming IP Type None this profile has no data while roaming." />
      )}
      {mode.kind === "duplicate" && mode.profile.hasPassword && (
        <Form.Description text="The original's password cannot be copied — enter it again if the profile needs one." />
      )}
      {mode.kind !== "edit" && (
        <Form.Checkbox id="activate" label="Activate now" defaultValue={true} />
      )}
    </Form>
  );
}
