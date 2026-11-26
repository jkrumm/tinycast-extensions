import { describe, expect, it } from "vitest";
import { notificationScript } from "./notify";

describe("notificationScript", () => {
  it("is a display notification with the body and title as string literals", () => {
    expect(
      notificationScript({
        title: "Van battery",
        body: "Van battery 28 % — stop charging devices from the van",
      }),
    ).toBe(
      'display notification "Van battery 28 % — stop charging devices from the van" with title "Van battery"',
    );
  });

  it("escapes quotes and backslashes so text can never break out of the literal", () => {
    expect(
      notificationScript({ title: 'a"b', body: 'x\\" & do shell script "y' }),
    ).toBe(
      'display notification "x\\\\\\" & do shell script \\"y" with title "a\\"b"',
    );
  });
});
