// Pure core of the no-view commands (scenes, Nami): run one `home` call and
// turn the outcome into a single HUD line. No @raycast/api import, so it is
// unit-testable; `scene-command.ts` binds it to showHUD.

import { friendlyError } from "./format";
import { namiPresence, RunHome, runHome, triggerScene } from "./run";

export type Hud = (message: string) => Promise<void>;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

async function report(
  task: () => Promise<void>,
  success: string,
  failure: string,
  hud: Hud,
): Promise<void> {
  try {
    await task();
  } catch (error) {
    await hud(`${failure}: ${friendlyError(messageOf(error))}`);
    return;
  }
  await hud(success);
}

// `target` is what the CLI is given (name or id); `name` is what the HUD says.
export const runScene = (
  name: string,
  hud: Hud,
  run: RunHome = runHome,
  target: string = name,
) =>
  report(
    () => triggerScene(target, run),
    `${name} triggered`,
    `Could not trigger ${name}`,
    hud,
  );

// `home: true` = Nami stays home, `false` = Nami comes along.
export const runNamiPresence = (
  home: boolean,
  hud: Hud,
  run: RunHome = runHome,
) =>
  report(
    () => namiPresence(home, run),
    home ? "Nami stays home" : "Nami comes along",
    "Could not update Nami",
    hud,
  );
