// The Finder selection as paths. `getSelectedFinderItems` rejects while Finder is
// not the frontmost app; that reads as "nothing selected", never as an error.

import { getSelectedFinderItems } from "@raycast/api";

export async function selectedFinderPaths(): Promise<string[]> {
  try {
    return (await getSelectedFinderItems()).map((item) => item.path);
  } catch {
    return [];
  }
}
