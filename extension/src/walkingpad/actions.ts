// Pure core of the no-view WalkingPad commands: read a fresh status, decide,
// send at most one call, and return one line for the HUD. `command.ts` binds
// it to showHUD.

import { PadClient, describeError } from "./client";
import {
  DEFAULT_START_SPEED,
  SPEED_MAX,
  SPEED_MIN,
  clampSpeed,
  formatSpeed,
  phaseOf,
  steppedSpeed,
} from "./parse";
import { PadStatus } from "./types";

export type WalkingPadAction =
  "toggle" | "faster" | "slower" | { speed: number }; // a preset: sets the speed while walking, starts the belt at it otherwise

export type Hud = (message: string) => Promise<void>;

export interface Outcome {
  message: string;
  // true when a call changed the belt (the caller re-reads the status)
  sent: boolean;
}

const done = (message: string): Outcome => ({ message, sent: true });
const skipped = (message: string): Outcome => ({ message, sent: false });

// Reads /status, then sends at most one call. /speed goes out only when that
// fresh status reads active: the host starts a stopped belt on /speed.
export async function perform(
  action: WalkingPadAction,
  client: PadClient,
  startSpeed: number = DEFAULT_START_SPEED,
): Promise<Outcome> {
  const status = await client.status();
  const phase = phaseOf(status);

  if (phase === "padDisconnected") return skipped("Pad not connected");
  if (phase === "stopping") return skipped("Belt is stopping");

  if (action === "toggle") {
    if (phase === "standby") {
      const speed = clampSpeed(startSpeed);
      await client.start(speed);
      return done(`Started at ${formatSpeed(speed)}`);
    }
    await client.stop();
    return done("Stopped");
  }

  if (typeof action === "object") {
    const speed = clampSpeed(action.speed);
    if (phase === "active") {
      await client.setSpeed(speed);
      return done(`Speed ${formatSpeed(speed)}`);
    }
    // standing, or still ramping: /start is idempotent and applies the speed
    // once the belt is active.
    await client.start(speed);
    return done(`Started at ${formatSpeed(speed)}`);
  }

  return changeSpeed(action, status, client);
}

async function changeSpeed(
  action: "faster" | "slower",
  status: PadStatus,
  client: PadClient,
): Promise<Outcome> {
  if (phaseOf(status) !== "active") return skipped("Not walking");
  const current = clampSpeed(status.speedKmh ?? SPEED_MIN);
  const next = steppedSpeed(current, action === "faster" ? 1 : -1);
  if (next === current) {
    return skipped(
      `Already at ${formatSpeed(current)} (${current >= SPEED_MAX ? "max" : "min"})`,
    );
  }
  await client.setSpeed(next);
  return done(`Speed ${formatSpeed(next)}`);
}

// Runs the action and reports it as one HUD line; a failure is one friendly
// line. Resolves with the outcome (null on failure).
export async function runWalkingPad(
  action: WalkingPadAction,
  hud: Hud,
  client: PadClient,
  startSpeed?: number,
): Promise<Outcome | null> {
  try {
    const outcome = await perform(action, client, startSpeed);
    await hud(outcome.message);
    return outcome;
  } catch (error) {
    await hud(`WalkingPad: ${describeError(error)}`);
    return null;
  }
}
