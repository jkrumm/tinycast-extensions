// "Print File…" from the printer view: a path (prefilled with the Finder
// selection), pages, copies, sides, pages per sheet and manual feed. The CLI
// validates the values; a successful print closes the form.

import {
  Action,
  ActionPanel,
  Form,
  Toast,
  showToast,
  useNavigation,
} from "@raycast/api";
import { printFile } from "./view-run";
import { N_UP_OPTIONS, SIDES_OPTIONS } from "./view";

export function PrintForm({ initialFile }: { initialFile: string }) {
  const { pop } = useNavigation();

  async function handleSubmit(values: {
    file: string;
    pages: string;
    copies: string;
    sides: string;
    nUp: string;
    manualFeed: boolean;
  }) {
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Sending to the printer",
    });
    const result = await printFile(values);
    toast.style = result.ok ? Toast.Style.Success : Toast.Style.Failure;
    toast.title = result.message;
    if (result.ok) pop();
  }

  return (
    <Form
      navigationTitle="Print File"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Print" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="file"
        title="File"
        placeholder="Absolute path to a pdf, png, jpg, tif or txt"
        defaultValue={initialFile}
      />
      <Form.TextField
        id="pages"
        title="Pages"
        placeholder="All, or e.g. 1-3,5,8-"
      />
      <Form.TextField id="copies" title="Copies" defaultValue="1" />
      <Form.Dropdown
        id="sides"
        title="Sides"
        defaultValue="two-sided-long-edge"
      >
        {SIDES_OPTIONS.map((option) => (
          <Form.Dropdown.Item
            key={option.value}
            value={option.value}
            title={option.title}
          />
        ))}
      </Form.Dropdown>
      <Form.Dropdown id="nUp" title="Pages per Sheet" defaultValue="1">
        {N_UP_OPTIONS.map((value) => (
          <Form.Dropdown.Item key={value} value={value} title={value} />
        ))}
      </Form.Dropdown>
      <Form.Checkbox
        id="manualFeed"
        label="Feed from the manual tray"
        defaultValue={false}
      />
    </Form>
  );
}
