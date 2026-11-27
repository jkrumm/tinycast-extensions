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
  "netgearPasswordRef": string,
  /** Victron Instant Readout Key (override) - 32-hex-char Instant Readout encryption key of the SmartSolar MPPT — leave blank to resolve it from Keychain / 1Password instead (see Victron Key 1Password Ref) */
  "victronKey"?: string,
  /** Victron Key 1Password Ref - op:// reference used to resolve the Victron key when no override and no cached Keychain entry exist */
  "victronKeyRef": string
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
  /** Preferences accessible in the `van-power` command */
  export type VanPower = ExtensionPreferences & {}
  /** Preferences accessible in the `shortcuts` command */
  export type Shortcuts = ExtensionPreferences & {}
  /** Preferences accessible in the `home` command */
  export type Home = ExtensionPreferences & {}
  /** Preferences accessible in the `home-menu-bar` command */
  export type HomeMenuBar = ExtensionPreferences & {}
  /** Preferences accessible in the `home-climate` command */
  export type HomeClimate = ExtensionPreferences & {}
  /** Preferences accessible in the `scene-arbeit` command */
  export type SceneArbeit = ExtensionPreferences & {}
  /** Preferences accessible in the `scene-aus` command */
  export type SceneAus = ExtensionPreferences & {}
  /** Preferences accessible in the `scene-bett-dunkel` command */
  export type SceneBettDunkel = ExtensionPreferences & {}
  /** Preferences accessible in the `scene-bett-hell` command */
  export type SceneBettHell = ExtensionPreferences & {}
  /** Preferences accessible in the `scene-chill` command */
  export type SceneChill = ExtensionPreferences & {}
  /** Preferences accessible in the `scene-gute-nacht` command */
  export type SceneGuteNacht = ExtensionPreferences & {}
  /** Preferences accessible in the `scene-guten-morgen` command */
  export type SceneGutenMorgen = ExtensionPreferences & {}
  /** Preferences accessible in the `scene-hell` command */
  export type SceneHell = ExtensionPreferences & {}
  /** Preferences accessible in the `scene-tv` command */
  export type SceneTv = ExtensionPreferences & {}
  /** Preferences accessible in the `nami-comes-along` command */
  export type NamiComesAlong = ExtensionPreferences & {}
  /** Preferences accessible in the `nami-stays-home` command */
  export type NamiStaysHome = ExtensionPreferences & {}
  /** Preferences accessible in the `spotify` command */
  export type Spotify = ExtensionPreferences & {}
  /** Preferences accessible in the `spotify-play-pause` command */
  export type SpotifyPlayPause = ExtensionPreferences & {}
  /** Preferences accessible in the `spotify-next` command */
  export type SpotifyNext = ExtensionPreferences & {}
  /** Preferences accessible in the `spotify-previous` command */
  export type SpotifyPrevious = ExtensionPreferences & {}
  /** Preferences accessible in the `spotify-louder` command */
  export type SpotifyLouder = ExtensionPreferences & {}
  /** Preferences accessible in the `spotify-quieter` command */
  export type SpotifyQuieter = ExtensionPreferences & {}
  /** Preferences accessible in the `spotify-play-on-mine` command */
  export type SpotifyPlayOnMine = ExtensionPreferences & {}
  /** Preferences accessible in the `spotify-play-on-macbook` command */
  export type SpotifyPlayOnMacbook = ExtensionPreferences & {}
  /** Preferences accessible in the `hub` command */
  export type Hub = ExtensionPreferences & {}
  /** Preferences accessible in the `walkingpad` command */
  export type Walkingpad = ExtensionPreferences & {}
  /** Preferences accessible in the `walkingpad-toggle` command */
  export type WalkingpadToggle = ExtensionPreferences & {}
  /** Preferences accessible in the `walkingpad-faster` command */
  export type WalkingpadFaster = ExtensionPreferences & {}
  /** Preferences accessible in the `walkingpad-slower` command */
  export type WalkingpadSlower = ExtensionPreferences & {}
  /** Preferences accessible in the `walkingpad-speed-3-0` command */
  export type WalkingpadSpeed30 = ExtensionPreferences & {}
  /** Preferences accessible in the `walkingpad-speed-3-5` command */
  export type WalkingpadSpeed35 = ExtensionPreferences & {}
  /** Preferences accessible in the `walkingpad-speed-4-0` command */
  export type WalkingpadSpeed40 = ExtensionPreferences & {}
  /** Preferences accessible in the `walkingpad-speed-4-5` command */
  export type WalkingpadSpeed45 = ExtensionPreferences & {}
  /** Preferences accessible in the `walkingpad-speed-5-0` command */
  export type WalkingpadSpeed50 = ExtensionPreferences & {}
  /** Preferences accessible in the `scan` command */
  export type Scan = ExtensionPreferences & {}
  /** Preferences accessible in the `scan-fronts` command */
  export type ScanFronts = ExtensionPreferences & {}
  /** Preferences accessible in the `scan-backs` command */
  export type ScanBacks = ExtensionPreferences & {}
  /** Preferences accessible in the `scan-flatbed` command */
  export type ScanFlatbed = ExtensionPreferences & {}
  /** Preferences accessible in the `scan-more` command */
  export type ScanMore = ExtensionPreferences & {}
  /** Preferences accessible in the `scan-submit` command */
  export type ScanSubmit = ExtensionPreferences & {}
  /** Preferences accessible in the `scan-discard` command */
  export type ScanDiscard = ExtensionPreferences & {}
  /** Preferences accessible in the `documents` command */
  export type Documents = ExtensionPreferences & {}
  /** Preferences accessible in the `printer` command */
  export type Printer = ExtensionPreferences & {}
  /** Preferences accessible in the `print-selection` command */
  export type PrintSelection = ExtensionPreferences & {}
  /** Preferences accessible in the `print-selection-simplex` command */
  export type PrintSelectionSimplex = ExtensionPreferences & {}
  /** Preferences accessible in the `print-cancel` command */
  export type PrintCancel = ExtensionPreferences & {}
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
  /** Arguments passed to the `van-power` command */
  export type VanPower = {}
  /** Arguments passed to the `shortcuts` command */
  export type Shortcuts = {}
  /** Arguments passed to the `home` command */
  export type Home = {}
  /** Arguments passed to the `home-menu-bar` command */
  export type HomeMenuBar = {}
  /** Arguments passed to the `home-climate` command */
  export type HomeClimate = {}
  /** Arguments passed to the `scene-arbeit` command */
  export type SceneArbeit = {}
  /** Arguments passed to the `scene-aus` command */
  export type SceneAus = {}
  /** Arguments passed to the `scene-bett-dunkel` command */
  export type SceneBettDunkel = {}
  /** Arguments passed to the `scene-bett-hell` command */
  export type SceneBettHell = {}
  /** Arguments passed to the `scene-chill` command */
  export type SceneChill = {}
  /** Arguments passed to the `scene-gute-nacht` command */
  export type SceneGuteNacht = {}
  /** Arguments passed to the `scene-guten-morgen` command */
  export type SceneGutenMorgen = {}
  /** Arguments passed to the `scene-hell` command */
  export type SceneHell = {}
  /** Arguments passed to the `scene-tv` command */
  export type SceneTv = {}
  /** Arguments passed to the `nami-comes-along` command */
  export type NamiComesAlong = {}
  /** Arguments passed to the `nami-stays-home` command */
  export type NamiStaysHome = {}
  /** Arguments passed to the `spotify` command */
  export type Spotify = {}
  /** Arguments passed to the `spotify-play-pause` command */
  export type SpotifyPlayPause = {}
  /** Arguments passed to the `spotify-next` command */
  export type SpotifyNext = {}
  /** Arguments passed to the `spotify-previous` command */
  export type SpotifyPrevious = {}
  /** Arguments passed to the `spotify-louder` command */
  export type SpotifyLouder = {}
  /** Arguments passed to the `spotify-quieter` command */
  export type SpotifyQuieter = {}
  /** Arguments passed to the `spotify-play-on-mine` command */
  export type SpotifyPlayOnMine = {}
  /** Arguments passed to the `spotify-play-on-macbook` command */
  export type SpotifyPlayOnMacbook = {}
  /** Arguments passed to the `hub` command */
  export type Hub = {}
  /** Arguments passed to the `walkingpad` command */
  export type Walkingpad = {}
  /** Arguments passed to the `walkingpad-toggle` command */
  export type WalkingpadToggle = {}
  /** Arguments passed to the `walkingpad-faster` command */
  export type WalkingpadFaster = {}
  /** Arguments passed to the `walkingpad-slower` command */
  export type WalkingpadSlower = {}
  /** Arguments passed to the `walkingpad-speed-3-0` command */
  export type WalkingpadSpeed30 = {}
  /** Arguments passed to the `walkingpad-speed-3-5` command */
  export type WalkingpadSpeed35 = {}
  /** Arguments passed to the `walkingpad-speed-4-0` command */
  export type WalkingpadSpeed40 = {}
  /** Arguments passed to the `walkingpad-speed-4-5` command */
  export type WalkingpadSpeed45 = {}
  /** Arguments passed to the `walkingpad-speed-5-0` command */
  export type WalkingpadSpeed50 = {}
  /** Arguments passed to the `scan` command */
  export type Scan = {}
  /** Arguments passed to the `scan-fronts` command */
  export type ScanFronts = {}
  /** Arguments passed to the `scan-backs` command */
  export type ScanBacks = {}
  /** Arguments passed to the `scan-flatbed` command */
  export type ScanFlatbed = {}
  /** Arguments passed to the `scan-more` command */
  export type ScanMore = {}
  /** Arguments passed to the `scan-submit` command */
  export type ScanSubmit = {}
  /** Arguments passed to the `scan-discard` command */
  export type ScanDiscard = {}
  /** Arguments passed to the `documents` command */
  export type Documents = {}
  /** Arguments passed to the `printer` command */
  export type Printer = {}
  /** Arguments passed to the `print-selection` command */
  export type PrintSelection = {}
  /** Arguments passed to the `print-selection-simplex` command */
  export type PrintSelectionSimplex = {}
  /** Arguments passed to the `print-cancel` command */
  export type PrintCancel = {}
}

