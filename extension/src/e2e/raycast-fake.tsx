// A fake `@raycast/api`, aliased in for both the unit-test run
// (vitest.config.ts) and the e2e render harness (vitest.e2e.config.ts) — see
// AGENTS.md § End-to-end render harness. Real @raycast/api ships types only
// (no runtime JS — Tinycast/Raycast supply the real implementation at
// launch), so nothing here needs to match its exported TYPES exactly: tsc
// always type-checks call sites against the real package regardless of this
// alias (vitest aliases are a runtime-only substitution). Every export below
// only needs to behave correctly for the props this extension's commands
// actually pass — verified via `grep -rhoE` over src/ before writing this.
//
// Every UI component is a "pass-through" — it renders whichever of its own
// props are themselves React elements (actions, children, detail, …) so
// react-test-renderer's `root.findByType(X)` can discover nested
// Action/ActionPanel/etc. instances, while its own props are read directly
// off the found instance for assertions (no separate render-tree data
// structure needed).
import React, { ReactNode } from "react";

type Props = Record<string, unknown>;

function renderable(props: Props): ReactNode[] {
  const keys = [
    "children",
    "actions",
    "detail",
    "searchBarAccessory",
    "content",
    "metadata",
    "target",
    "alternate",
  ];
  return keys
    .map((k) => props[k])
    .filter((v): v is ReactNode => v !== undefined && v !== null)
    .map((node, i) => <React.Fragment key={i}>{node}</React.Fragment>);
}

// A distinct function identity per component name — `react-test-renderer`'s
// `root.findByType(X)` matches by function reference, so two components
// sharing one underlying function (e.g. via `Object.assign(sameFn, {...})`,
// which mutates and returns that same reference) would be indistinguishable
// to `findByType`. Every exported component below is its own function.
function makePassthrough(displayName: string) {
  function Component(props: Props) {
    return <>{renderable(props)}</>;
  }
  Component.displayName = displayName;
  return Component;
}

function makeLeaf(displayName: string) {
  function Component() {
    return null;
  }
  Component.displayName = displayName;
  return Component;
}

// ─── Detail ─────────────────────────────────────────────────────────────────

const DetailMetadataLabel = makeLeaf("Detail.Metadata.Label");
const DetailMetadataSeparator = makeLeaf("Detail.Metadata.Separator");
const DetailMetadata = Object.assign(makePassthrough("Detail.Metadata"), {
  Label: DetailMetadataLabel,
  Separator: DetailMetadataSeparator,
});

export const Detail = Object.assign(makePassthrough("Detail"), {
  Metadata: DetailMetadata,
});

// ─── List ───────────────────────────────────────────────────────────────────

const ListItemDetailMetadataLabel = makeLeaf("List.Item.Detail.Metadata.Label");
const ListItemDetailMetadata = Object.assign(
  makePassthrough("List.Item.Detail.Metadata"),
  { Label: ListItemDetailMetadataLabel },
);
const ListItemDetail = Object.assign(makePassthrough("List.Item.Detail"), {
  Metadata: ListItemDetailMetadata,
});
const ListItem = Object.assign(makePassthrough("List.Item"), {
  Detail: ListItemDetail,
});

const ListDropdownItem = makeLeaf("List.Dropdown.Item");
const ListDropdownSection = makePassthrough("List.Dropdown.Section");
const ListDropdown = Object.assign(makePassthrough("List.Dropdown"), {
  Item: ListDropdownItem,
  Section: ListDropdownSection,
});

const ListSection = makePassthrough("List.Section");
const ListEmptyView = makePassthrough("List.EmptyView");

export const List = Object.assign(makePassthrough("List"), {
  Item: ListItem,
  Dropdown: ListDropdown,
  Section: ListSection,
  EmptyView: ListEmptyView,
});

// ─── Grid ───────────────────────────────────────────────────────────────────

const GridItem = makePassthrough("Grid.Item");
export const Grid = Object.assign(makePassthrough("Grid"), {
  Item: GridItem,
  Fit: { Fill: "fill", Fit: "fit" } as const,
  Inset: {
    Zero: "zero",
    Small: "small",
    Medium: "medium",
    Large: "large",
  } as const,
});

// ─── Form ───────────────────────────────────────────────────────────────────

const FormTextField = makePassthrough("Form.TextField");
const FormTextArea = makePassthrough("Form.TextArea");
const FormDescription = makePassthrough("Form.Description");
const FormSeparator = makeLeaf("Form.Separator");
export const Form = Object.assign(makePassthrough("Form"), {
  TextField: FormTextField,
  TextArea: FormTextArea,
  Description: FormDescription,
  Separator: FormSeparator,
});

// ─── MenuBarExtra ───────────────────────────────────────────────────────────

const MenuBarExtraItem = makePassthrough("MenuBarExtra.Item");
const MenuBarExtraSection = makePassthrough("MenuBarExtra.Section");
const MenuBarExtraSeparator = makeLeaf("MenuBarExtra.Separator");
export const MenuBarExtra = Object.assign(makePassthrough("MenuBarExtra"), {
  Item: MenuBarExtraItem,
  Section: MenuBarExtraSection,
  Separator: MenuBarExtraSeparator,
});

// ─── ActionPanel / Action ───────────────────────────────────────────────────

const ActionPanelSection = makePassthrough("ActionPanel.Section");
const ActionPanelSubmenu = makePassthrough("ActionPanel.Submenu");
export const ActionPanel = Object.assign(makePassthrough("ActionPanel"), {
  Section: ActionPanelSection,
  Submenu: ActionPanelSubmenu,
});

const ActionOpenInBrowser = makePassthrough("Action.OpenInBrowser");
const ActionCopyToClipboard = makePassthrough("Action.CopyToClipboard");
const ActionSubmitForm = makePassthrough("Action.SubmitForm");
const ActionPush = makePassthrough("Action.Push");
export const Action = Object.assign(makePassthrough("Action"), {
  Style: { Regular: "regular", Destructive: "destructive" } as const,
  OpenInBrowser: ActionOpenInBrowser,
  CopyToClipboard: ActionCopyToClipboard,
  SubmitForm: ActionSubmitForm,
  Push: ActionPush,
});

// ─── Enums / value namespaces ───────────────────────────────────────────────

export const Alert = {
  ActionStyle: {
    Default: "default",
    Destructive: "destructive",
    Cancel: "cancel",
  },
} as const;

export const Toast = {
  Style: { Success: "success", Failure: "failure", Animated: "animated" },
} as const;

export const LaunchType = {
  UserInitiated: "userInitiated",
  Background: "background",
} as const;

export const Color = {
  PrimaryText: "primary-text",
  SecondaryText: "secondary-text",
  Red: "red",
  Orange: "orange",
  Yellow: "yellow",
  Green: "green",
  Blue: "blue",
  Purple: "purple",
  Magenta: "magenta",
} as const;

// Real `Icon` is a huge enum of specific icon names — a Proxy returning the
// accessed property name covers every `Icon.Whatever` call site without
// enumerating them, and still gives each icon a distinct, inspectable value.
export const Icon: Record<string, string> = new Proxy(
  {},
  { get: (_t, prop: string) => `icon:${prop}` },
);

// ─── LocalStorage ───────────────────────────────────────────────────────────

const localStorageStore = new Map<string, string>();

export const LocalStorage = {
  async getItem<T extends string | number | boolean>(
    key: string,
  ): Promise<T | undefined> {
    return localStorageStore.has(key)
      ? (localStorageStore.get(key) as unknown as T)
      : undefined;
  },
  async setItem(key: string, value: string | number | boolean): Promise<void> {
    localStorageStore.set(key, String(value));
  },
  async removeItem(key: string): Promise<void> {
    localStorageStore.delete(key);
  },
  async clear(): Promise<void> {
    localStorageStore.clear();
  },
  async allItems(): Promise<Record<string, string>> {
    return Object.fromEntries(localStorageStore);
  },
};

// Test-only escape hatch — not part of the real @raycast/api surface, used by
// unit/e2e tests to reset state between cases.
export function __resetLocalStorage(): void {
  localStorageStore.clear();
}

// ─── Cache ──────────────────────────────────────────────────────────────────

export class Cache {
  private store = new Map<string, string>();
  get(key: string): string | undefined {
    return this.store.get(key);
  }
  set(key: string, value: string): void {
    this.store.set(key, value);
  }
  has(key: string): boolean {
    return this.store.has(key);
  }
  remove(key: string): boolean {
    return this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  subscribe(): () => void {
    return () => {};
  }
}

// ─── environment ────────────────────────────────────────────────────────────

import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// A real (temp) directory — session.ts's getClient() does a real
// `mkdir(environment.supportPath, { recursive: true })`, and hub.tsx reads
// real command-icon SVGs off `environment.assetsPath`.
const supportPath = mkdtempSync(join(tmpdir(), "tinycast-e2e-support-"));
const assetsPath = join(__dirname, "..", "..", "assets");

export const environment = {
  supportPath,
  assetsPath,
  isDevelopment: true,
  extensionName: "jkrumm",
  commandName: "e2e",
  commandMode: "view",
  raycastVersion: "0.0.0-e2e",
  appearance: "dark",
  textSize: "medium",
  launchType: "userInitiated",
};

// ─── Toasts ─────────────────────────────────────────────────────────────────

export interface FakeToast {
  style: string;
  title: string;
  message?: string;
  primaryAction?: { title: string; onAction: () => void };
}

export const __toasts: FakeToast[] = [];

export async function showToast(
  options: Partial<FakeToast> & { style?: string; title?: string },
): Promise<FakeToast> {
  const toast: FakeToast = {
    style: options.style ?? Toast.Style.Success,
    title: options.title ?? "",
    message: options.message,
    primaryAction: options.primaryAction,
  };
  __toasts.push(toast);
  return toast;
}

export function __resetToasts(): void {
  __toasts.length = 0;
}

export async function confirmAlert(): Promise<boolean> {
  return false;
}

// ─── Navigation / launch / preferences ──────────────────────────────────────

export function useNavigation(): {
  push: (element: ReactNode) => void;
  pop: () => void;
} {
  return {
    push: (element) => __pushedViews.push(element),
    pop: () => {
      __pushedViews.pop();
    },
  };
}

export const __pushedViews: ReactNode[] = [];

export async function launchCommand(options: Props): Promise<void> {
  __launchedCommands.push(options);
}
export const __launchedCommands: Props[] = [];

export async function updateCommandMetadata(options: Props): Promise<void> {
  __commandMetadataUpdates.push(options);
}
export const __commandMetadataUpdates: Props[] = [];

export async function openExtensionPreferences(): Promise<void> {
  __extensionPreferencesOpened.count += 1;
}
export const __extensionPreferencesOpened = { count: 0 };

export function open(target: string): Promise<void> {
  __openedTargets.push(target);
  return Promise.resolve();
}
export const __openedTargets: string[] = [];

export async function showHUD(title: string): Promise<void> {
  __hudMessages.push(title);
}
export const __hudMessages: string[] = [];

export async function popToRoot(): Promise<void> {
  __poppedToRoot.count += 1;
}
export const __poppedToRoot = { count: 0 };

// package.json's `preferences[]` — same shape getPreferenceValues() reads in
// the real extension, minus anything secret (never hardcode a real secret
// here; tests override what they need per-case).
// eslint-disable-next-line @typescript-eslint/no-var-requires -- JSON import keeps this file resolvable without a bundler-specific import assertion
const pkg = require("../../package.json") as {
  preferences: { name: string; default?: string }[];
};

const preferenceDefaults: Props = Object.fromEntries(
  pkg.preferences.map((p) => [p.name, p.default]),
);

let preferenceOverrides: Props = {};

export function getPreferenceValues<T = Props>(): T {
  return { ...preferenceDefaults, ...preferenceOverrides } as T;
}

// Test-only escape hatch to exercise a specific preference value/override.
export function __setPreferenceOverrides(overrides: Props): void {
  preferenceOverrides = overrides;
}
