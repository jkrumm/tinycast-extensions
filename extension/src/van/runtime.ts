// What the van code needs from its host and cannot get on its own: the support
// dir (capture/trend logs), the dir the bundled helper lives in, and the
// preferences. Inside Tinycast the view module registers them from
// `@raycast/api`; the launchd entry (scripts/van-sampler.ts) registers plain
// values. This module must never import `@raycast/api`, so everything the
// daemon loads stays free of it.

import { Preferences } from "../lib/preferences";

export interface VanRuntime {
  supportDir: string;
  assetsDir: string;
  preferences: Preferences;
}

let resolver: (() => VanRuntime) | null = null;

// A resolver, not a value: Tinycast's `environment`/preferences are read at use.
export function configureVanRuntime(resolve: () => VanRuntime): void {
  resolver = resolve;
}

export function vanRuntime(): VanRuntime {
  if (!resolver) throw new Error("van runtime is not configured");
  return resolver();
}
