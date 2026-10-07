// Starts the fake Netgear M2 (src/netgear/fake-router.ts) for click-testing
// the Netgear commands without the real router. Run via `make fake-router`.

import { startFakeRouter } from "../src/netgear/fake-router";

const PORT = 8188;
const PASSWORD = "fake";

const router = await startFakeRouter({
  port: PORT,
  host: "127.0.0.1",
  password: PASSWORD,
});

console.log(`Fake Netgear M2 listening on ${router.url}`);
console.log(`  Admin password: ${PASSWORD}`);
console.log(`  SIM PIN:        ${router.state.simPin} (locked after a reboot)`);
console.log("");
console.log("Point Tinycast at it: Settings → Extensions → jkrumm →");
console.log(`  Netgear Host = ${router.url}`);
console.log(`  Netgear Password = ${PASSWORD}  (override preference)`);
console.log("The Netgear Watchdog targets it too while the preference is set.");
console.log("Reset the host preference to http://192.168.1.1 when done.");
console.log("Ctrl-C to stop.");

process.on("SIGINT", async () => {
  await router.close();
  process.exit(0);
});
