import { describe, it, expect } from "vitest";
import { joinSucceeded, parseWifiDevice } from "./wifi";

describe("parseWifiDevice", () => {
  it("finds the Wi-Fi device among other hardware ports", () => {
    const out = [
      "Hardware Port: Ethernet Adapter (en4)",
      "Device: en4",
      "Ethernet Address: 00:00:00:00:00:01",
      "",
      "Hardware Port: Wi-Fi",
      "Device: en1",
      "Ethernet Address: 00:00:00:00:00:02",
    ].join("\n");
    expect(parseWifiDevice(out)).toBe("en1");
  });

  it("returns null without a Wi-Fi port", () => {
    expect(
      parseWifiDevice("Hardware Port: Thunderbolt Bridge\nDevice: bridge0"),
    ).toBeNull();
  });
});

describe("joinSucceeded", () => {
  it("accepts the empty output of a successful join", () => {
    expect(joinSucceeded("")).toBe(true);
  });

  it.each([
    "Could not find network FakeNet.",
    "Failed to join network FakeNet.\nError: -3900",
    "Error: -3905 The operation couldn't be completed",
    "Unable to join network FakeNet.",
    "The operation timed out.",
  ])("rejects %j", (output) => {
    expect(joinSucceeded(output)).toBe(false);
  });
});
