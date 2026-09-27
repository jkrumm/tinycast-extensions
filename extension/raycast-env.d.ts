/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** API Token (override) - Bearer token for the argo proxy — leave blank to resolve it from Keychain / 1Password instead (see API Token Ref) */
  "apiToken"?: string,
  /** API Token 1Password Ref - op:// reference used to resolve the API Token when no override and no cached Keychain entry exist */
  "apiTokenRef": string,
  /** API Base URL - argo proxy base URL (incl. /api path prefix) */
  "baseUrl": string,
  /** Default Project ID - TickTick project used when Quick Add cannot match a project (optional) */
  "defaultProjectId"?: string,
  /** Netgear Host - Base URL of the Netgear Nighthawk M2 (MR2100) */
  "netgearHost": string,
  /** Netgear Admin Password (override) - Router admin password — leave blank to resolve it from Keychain / 1Password instead (see Netgear Admin Password Ref) */
  "netgearPassword"?: string,
  /** Netgear Admin Password 1Password Ref - op:// reference used to resolve the router admin password when no override and no cached Keychain entry exist */
  "netgearPasswordRef": string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `my-tasks` command */
  export type MyTasks = ExtensionPreferences & {}
  /** Preferences accessible in the `quick-add` command */
  export type QuickAdd = ExtensionPreferences & {}
  /** Preferences accessible in the `ticktick-menu-bar` command */
  export type TicktickMenuBar = ExtensionPreferences & {}
  /** Preferences accessible in the `claude-usage` command */
  export type ClaudeUsage = ExtensionPreferences & {}
  /** Preferences accessible in the `claude-usage-menu-bar` command */
  export type ClaudeUsageMenuBar = ExtensionPreferences & {}
  /** Preferences accessible in the `netgear` command */
  export type Netgear = ExtensionPreferences & {}
  /** Preferences accessible in the `battery` command */
  export type Battery = ExtensionPreferences & {}
  /** Preferences accessible in the `speed-test` command */
  export type SpeedTest = ExtensionPreferences & {}
  /** Preferences accessible in the `hub` command */
  export type Hub = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `my-tasks` command */
  export type MyTasks = {}
  /** Arguments passed to the `quick-add` command */
  export type QuickAdd = {}
  /** Arguments passed to the `ticktick-menu-bar` command */
  export type TicktickMenuBar = {}
  /** Arguments passed to the `claude-usage` command */
  export type ClaudeUsage = {}
  /** Arguments passed to the `claude-usage-menu-bar` command */
  export type ClaudeUsageMenuBar = {}
  /** Arguments passed to the `netgear` command */
  export type Netgear = {}
  /** Arguments passed to the `battery` command */
  export type Battery = {}
  /** Arguments passed to the `speed-test` command */
  export type SpeedTest = {}
  /** Arguments passed to the `hub` command */
  export type Hub = {}
}

