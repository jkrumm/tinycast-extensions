// Read-only smoke test against the real Netgear MR2100. NEVER calls an
// action (reboot/connect/disconnect/PIN/PUK) — only GET model.json and login,
// both explicitly allowed against the live device.
//
// Run with:
//   NETGEAR_LIVE=1 NETGEAR_HOST=http://192.168.1.1 NETGEAR_PASSWORD="$(secrets-run read ...)" \
//     bun run src/netgear/live-smoke.ts
//
// Gated on NETGEAR_LIVE=1 so it never runs as a side effect of `make test`.
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { CurlNetgearHttp } from "./transport";
import { NetgearClient } from "./client";

async function main() {
  if (process.env.NETGEAR_LIVE !== "1") {
    console.log("Skipped — set NETGEAR_LIVE=1 to run against the real router.");
    return;
  }

  const host = process.env.NETGEAR_HOST ?? "http://192.168.1.1";
  const password = process.env.NETGEAR_PASSWORD;

  const jarDir = await mkdtemp(join(tmpdir(), "netgear-smoke-"));
  const jarPath = join(jarDir, "cookies.jar");
  const client = new NetgearClient({
    host,
    transport: new CurlNetgearHttp(jarPath),
  });

  const guestStatus = await client.getStatus();
  console.log(`Guest role: ${guestStatus.userRole}`);
  console.log(
    `  connection=${guestStatus.connection} sim=${guestStatus.simStatus}`,
  );

  if (!password) {
    console.log("NETGEAR_PASSWORD not set — skipping login check.");
    return;
  }

  const adminStatus = await client.login(password);
  console.log(`Admin role after login: ${adminStatus.userRole}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
