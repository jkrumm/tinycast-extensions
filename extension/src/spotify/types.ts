// `home audio` JSON, narrowed to what the commands show. Every field can be
// missing (nothing loaded, Mine idle), so everything is nullable.
export interface SpotifyState {
  status: string | null; // "playing" | "paused" | anything else the CLI says
  active: boolean | null; // Mine is the active Connect device
  volume: number | null; // 0..100
  output: string | null;
  track: string | null;
  artists: string[];
  album: string | null;
  context: string | null;
  cover: string | null;
  positionMs: number | null;
  durationMs: number | null;
  shuffle: boolean | null;
  repeat: string | null;
}
