import { showHUD } from "@raycast/api";
import { describeError } from "./client";
import { WalkingPadAction, runWalkingPad } from "./actions";
import { Connection, connect, writeCached } from "./run";

// One-liner command bodies: `export default walkingPadCommand("toggle");`
export const walkingPadCommand = (action: WalkingPadAction) => async () => {
  let connection: Connection;
  try {
    connection = await connect();
  } catch (error) {
    await showHUD(`WalkingPad: ${describeError(error)}`);
    return;
  }
  const outcome = await runWalkingPad(
    action,
    showHUD,
    connection.client,
    connection.startSpeed,
  );
  if (!outcome?.sent) return;
  // Keep the view and the hub tile current; best effort, after the HUD.
  await connection.client
    .status()
    .then((status) => writeCached(status))
    .catch(() => undefined);
};
