import { describe, expect, it } from "vitest";
import { dashboardUrl } from "./argo";

describe("dashboardUrl", () => {
  it("drops the /api prefix and a trailing slash", () => {
    expect(dashboardUrl("https://example.com/api")).toBe("https://example.com");
    expect(dashboardUrl("https://example.com/api/")).toBe(
      "https://example.com",
    );
    expect(dashboardUrl("https://example.com")).toBe("https://example.com");
  });
});
