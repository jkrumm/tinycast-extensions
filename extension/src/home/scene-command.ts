import { showHUD } from "@raycast/api";
import { runNamiPresence, runScene } from "./actions";

// One-liner command bodies: `export default sceneCommand("Arbeit");`
export const sceneCommand = (name: string) => () => runScene(name, showHUD);

export const namiCommand = (home: boolean) => () =>
  runNamiPresence(home, showHUD);
