import { describe, expect, it } from "vitest";
import { Exec, normalizeUrl, readConfig } from "./config";

const exec =
  (answers: Record<string, string | Error>): Exec =>
  async (bin, args) => {
    const key = bin.endsWith("defaults") ? `defaults ${args[2]}` : "security";
    const answer = answers[key];
    if (answer === undefined || answer instanceof Error) {
      throw answer ?? new Error("not found");
    }
    return answer;
  };

describe("normalizeUrl", () => {
  it("accepts http(s) and drops trailing slashes", () => {
    expect(normalizeUrl(" https://example.com/ ")).toBe("https://example.com");
    expect(normalizeUrl("http://127.0.0.1:7706")).toBe("http://127.0.0.1:7706");
  });
  it("rejects anything else", () => {
    expect(normalizeUrl("")).toBeNull();
    expect(normalizeUrl("ftp://example.com")).toBeNull();
    expect(normalizeUrl("example.com")).toBeNull();
  });
});

describe("readConfig", () => {
  const good = {
    "defaults hostURL": "https://example.com/\n",
    security: "secret-token\n",
  };

  it("reads URL and token from the app's storage", async () => {
    expect(await readConfig(exec(good))).toEqual({
      baseUrl: "https://example.com",
      token: "secret-token",
      startSpeed: 3,
    });
  });

  it("uses the app's start speed, clamped", async () => {
    const config = await readConfig(
      exec({ ...good, "defaults startSpeed": "3.5\n" }),
    );
    expect(config.startSpeed).toBe(3.5);
  });

  it("is unconfigured without a URL, and says so without echoing secrets", async () => {
    const error = await readConfig(exec({ security: "secret-token" })).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ kind: "unconfigured" });
    expect(String((error as Error).message)).not.toContain("secret-token");
  });

  it("is unconfigured when the Keychain read fails or is denied", async () => {
    await expect(
      readConfig(exec({ "defaults hostURL": "https://example.com" })),
    ).rejects.toMatchObject({ kind: "unconfigured" });
  });
});
