import { useState } from "react";
import {
  Action,
  ActionPanel,
  Alert,
  confirmAlert,
  Detail,
  Icon,
  List,
} from "@raycast/api";
import { RouterSmsMessage, RouterStatus } from "./types";
import { withAdmin } from "./session";

function formatSmsTime(iso: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("de-DE");
}

export function SmsInbox({
  status,
  onDone,
}: {
  status: RouterStatus;
  onDone: () => void;
}) {
  const [messages, setMessages] = useState<RouterSmsMessage[]>(
    status.smsMessages,
  );

  async function markRead(id: string) {
    await withAdmin(
      "Mark as Read",
      async (client) => {
        await client.markSmsRead(id);
        setMessages((prev) =>
          prev.map((m) => (m.id === id ? { ...m, read: true } : m)),
        );
        onDone();
      },
      { successTitle: "Marked as read" },
    );
  }

  async function deleteMessage(id: string) {
    const confirmed = await confirmAlert({
      title: "Delete this message?",
      primaryAction: { title: "Delete", style: Alert.ActionStyle.Destructive },
    });
    if (!confirmed) return;
    await withAdmin(
      "Delete Message",
      async (client) => {
        await client.deleteSms(id);
        setMessages((prev) => prev.filter((m) => m.id !== id));
        onDone();
      },
      { successTitle: "Message deleted" },
    );
  }

  if (messages.length === 0) {
    return (
      <List navigationTitle="SMS">
        <List.EmptyView title="No messages" />
      </List>
    );
  }

  return (
    <List navigationTitle="SMS">
      {messages.map((m) => (
        <List.Item
          key={m.id}
          title={m.sender || "Unknown"}
          subtitle={m.text.split("\n")[0]}
          accessories={[
            { text: formatSmsTime(m.rxTime) },
            ...(m.read ? [] : [{ tag: "Unread" }]),
          ]}
          actions={
            <ActionPanel>
              <Action.Push
                title="Open"
                icon={Icon.SpeechBubble}
                target={<SmsDetail message={m} />}
              />
              {!m.read && (
                <Action
                  title="Mark as Read"
                  icon={Icon.Checkmark}
                  onAction={() => markRead(m.id)}
                />
              )}
              <Action.CopyToClipboard title="Copy Text" content={m.text} />
              <Action
                title="Delete"
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                onAction={() => deleteMessage(m.id)}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}

function SmsDetail({ message }: { message: RouterSmsMessage }) {
  const markdown = [
    `# ${message.sender || "Unknown"}`,
    "",
    formatSmsTime(message.rxTime),
    "",
    message.text,
  ].join("\n");
  return (
    <Detail
      navigationTitle="Message"
      markdown={markdown}
      actions={
        <ActionPanel>
          <Action.CopyToClipboard title="Copy Text" content={message.text} />
        </ActionPanel>
      }
    />
  );
}
