import { Action, ActionPanel, Form, useNavigation } from "@raycast/api";
import { ensureConnected, unlockSim } from "./flows";
import { pinStore, withAdmin } from "./session";

export function EnterPinForm({ onDone }: { onDone: () => void }) {
  const { pop } = useNavigation();

  async function handleSubmit(values: { pin: string; remember: boolean }) {
    await withAdmin(
      "Unlock SIM",
      async (client, onProgress) => {
        // A Locked SIM hides its ICCID — the PIN is saved under the ICCID
        // the router reports once unlocked.
        await unlockSim({
          client,
          pin: values.pin,
          pinStore,
          remember: values.remember,
          onProgress,
        });
        await ensureConnected({ client, onProgress });
        onDone();
        pop();
      },
      { successTitle: "SIM unlocked", selfHeal: true },
    );
  }

  return (
    <Form
      navigationTitle="Enter SIM PIN"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Submit" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.PasswordField
        id="pin"
        title="SIM PIN"
        placeholder="4-8 digits"
        autoFocus
      />
      <Form.Checkbox
        id="remember"
        label="Remember for this SIM"
        defaultValue={true}
      />
      <Form.Description text="Stored in macOS Keychain per SIM (by ICCID), never in the extension's config." />
    </Form>
  );
}

export function UnblockPukForm({ onDone }: { onDone: () => void }) {
  const { pop } = useNavigation();

  async function handleSubmit(values: {
    puk: string;
    newPin: string;
    remember: boolean;
  }) {
    await withAdmin(
      "Unblock SIM",
      async (client) => {
        await client.enterSimPuk(values.puk, values.newPin);
        const status = await client.getStatus();
        if (values.remember && status.iccid) {
          await pinStore.set(status.iccid, values.newPin);
        }
        onDone();
        pop();
      },
      { successTitle: "SIM unblocked", selfHeal: true },
    );
  }

  return (
    <Form
      navigationTitle="Unblock SIM With PUK"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Submit" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.PasswordField
        id="puk"
        title="PUK"
        placeholder="8 digits"
        autoFocus
      />
      <Form.PasswordField
        id="newPin"
        title="New SIM PIN"
        placeholder="4-8 digits"
      />
      <Form.Checkbox
        id="remember"
        label="Remember new PIN for this SIM"
        defaultValue={true}
      />
    </Form>
  );
}

export function ChangePinForm({
  iccid,
  onDone,
}: {
  iccid: string;
  onDone: () => void;
}) {
  const { pop } = useNavigation();

  async function handleSubmit(values: {
    oldPin: string;
    newPin: string;
    remember: boolean;
  }) {
    await withAdmin(
      "Change SIM PIN",
      async (client) => {
        await client.changeSimPin(values.oldPin, values.newPin);
        if (values.remember && iccid) {
          await pinStore.set(iccid, values.newPin);
        }
        onDone();
        pop();
      },
      { successTitle: "PIN changed" },
    );
  }

  return (
    <Form
      navigationTitle="Change SIM PIN"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Submit" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.PasswordField id="oldPin" title="Current PIN" autoFocus />
      <Form.PasswordField id="newPin" title="New PIN" />
      <Form.Checkbox
        id="remember"
        label="Remember for this SIM"
        defaultValue={true}
      />
    </Form>
  );
}

export function SimPinLockForm({
  enable,
  onDone,
}: {
  enable: boolean;
  onDone: () => void;
}) {
  const { pop } = useNavigation();

  async function handleSubmit(values: { pin: string }) {
    await withAdmin(
      enable ? "Enable SIM PIN Lock" : "Disable SIM PIN Lock",
      async (client) => {
        await client.setSimPinLock({ enabled: enable, pin: values.pin });
        onDone();
        pop();
      },
      { successTitle: enable ? "PIN lock enabled" : "PIN lock disabled" },
    );
  }

  return (
    <Form
      navigationTitle={enable ? "Enable SIM PIN Lock" : "Disable SIM PIN Lock"}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Submit" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.PasswordField id="pin" title="SIM PIN" autoFocus />
    </Form>
  );
}
