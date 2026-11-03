import { showHUD } from "@raycast/api";
import { runSpotify, SpotifyAction } from "./actions";
import { writeCached } from "./run";

// One-liner command bodies: `export default spotifyCommand("next");`
export const spotifyCommand = (action: SpotifyAction) => async () => {
  const state = await runSpotify(action, showHUD);
  if (state) await writeCached(state);
};
