import { describe, expect, it } from "vitest";
import {
  emptyApnFormValues,
  findCreatedProfile,
  fixRoamingInput,
  formValuesFromProfile,
  hasErrors,
  networkHeader,
  profileBadges,
  toCreateInput,
  toUpdateInput,
  validateApnForm,
} from "./apn-model";
import { BASE_STATUS } from "./test-helpers";
import { RouterProfile } from "./types";

function profile(overrides: Partial<RouterProfile> = {}): RouterProfile {
  return {
    id: "p1",
    index: 0,
    name: "Work",
    apn: "work.fake",
    username: "user",
    authtype: "PAP",
    type: "IPV4",
    pdpRoamingType: "IPV4",
    hasPassword: true,
    editable: true,
    deletable: true,
    ...overrides,
  };
}

describe("profileBadges", () => {
  it("tags the active profile and always shows auth + IP type", () => {
    const badges = profileBadges(profile({ id: "a" }), "a");
    expect(badges.map((b) => [b.kind, b.text])).toEqual([
      ["active", "Active"],
      ["auth", "PAP"],
      ["ip", "IPv4"],
    ]);
  });

  it("marks a locked profile and a no-roaming profile", () => {
    const badges = profileBadges(
      profile({ editable: false, pdpRoamingType: "None", authtype: "None" }),
      "other",
    );
    expect(badges.map((b) => b.kind)).toEqual([
      "locked",
      "no-roaming",
      "auth",
      "ip",
    ]);
    expect(badges.find((b) => b.kind === "no-roaming")?.text).toBe(
      "No roaming data",
    );
    expect(badges.find((b) => b.kind === "auth")?.text).toBe("No auth");
  });
});

describe("networkHeader", () => {
  it("shows operator, MCC/MNC, country and roaming state", () => {
    expect(
      networkHeader({
        ...BASE_STATUS,
        operator: "Fakecom",
        mcc: "001",
        mnc: "01",
        country: "Fakeland",
        currentlyRoaming: true,
      }),
    ).toEqual({
      title: "Fakecom · MCC/MNC 001/01 · Fakeland",
      subtitle: "Roaming now",
    });
  });

  it("degrades to the operator alone on the home network", () => {
    expect(networkHeader({ ...BASE_STATUS, operator: "Fakecom" })).toEqual({
      title: "Fakecom",
      subtitle: "Home network",
    });
    expect(networkHeader({ ...BASE_STATUS, operator: "" }).title).toBe(
      "Not registered",
    );
  });
});

describe("validateApnForm", () => {
  it("requires a non-empty name and APN after trimming", () => {
    const errors = validateApnForm({ name: "  ", apn: "" });
    expect(errors).toEqual({
      name: "Name is required",
      apn: "APN is required",
    });
    expect(hasErrors(errors)).toBe(true);
    expect(hasErrors(validateApnForm({ name: " a ", apn: " b " }))).toBe(false);
  });
});

describe("form values", () => {
  it("defaults the roaming IP type to the IP type, never None", () => {
    const v = emptyApnFormValues();
    expect(v.pdproamingtype).toBe(v.type);
    expect(v.pdproamingtype).not.toBe("None");
  });

  it("edit keeps the name and never carries a password", () => {
    const v = formValuesFromProfile(profile(), "edit");
    expect(v).toMatchObject({ name: "Work", apn: "work.fake", password: "" });
  });

  it("duplicate renames the copy", () => {
    expect(formValuesFromProfile(profile(), "duplicate").name).toBe(
      "Work copy",
    );
  });

  it("keeps a profile's own None roaming type when editing", () => {
    expect(
      formValuesFromProfile(profile({ pdpRoamingType: "None" }), "edit")
        .pdproamingtype,
    ).toBe("None");
  });

  it("falls back to the IP type for an unknown roaming type", () => {
    expect(
      formValuesFromProfile(
        profile({ type: "IPV6", pdpRoamingType: "" }),
        "edit",
      ).pdproamingtype,
    ).toBe("IPV6");
  });
});

describe("toCreateInput / toUpdateInput", () => {
  const values = {
    name: " Work ",
    apn: " work.fake ",
    authtype: "PAP" as const,
    username: " user ",
    password: "s3cr3t",
    type: "IPV4V6" as const,
    pdproamingtype: "IPV4" as const,
  };

  it("trims and keeps credentials for an authenticated profile", () => {
    expect(toCreateInput(values)).toEqual({
      name: "Work",
      apn: "work.fake",
      username: "user",
      password: "s3cr3t",
      authtype: "PAP",
      type: "IPV4V6",
      pdproamingtype: "IPV4",
    });
  });

  it("drops username and password for auth type None", () => {
    const input = toCreateInput({ ...values, authtype: "None" });
    expect(input.username).toBeUndefined();
    expect(input.password).toBeUndefined();
  });

  it("update leaves the password out when the field was left blank", () => {
    const input = toUpdateInput("p1", { ...values, password: "" });
    expect(input.id).toBe("p1");
    expect(input.password).toBeUndefined();
  });
});

describe("fixRoamingInput", () => {
  it("sets the roaming IP type to the IP type and sends no password", () => {
    const input = fixRoamingInput(
      profile({ type: "IPV6", pdpRoamingType: "None" }),
    );
    expect(input).toEqual({
      id: "p1",
      name: "Work",
      apn: "work.fake",
      username: "user",
      authtype: "PAP",
      type: "IPV6",
      pdproamingtype: "IPV6",
    });
  });
});

describe("findCreatedProfile", () => {
  const existing = profile({ id: "Work 1", index: 1 });
  const created = profile({ id: "Work 2", index: 2 });

  it("picks the single new id even when name+apn collide with an old one", () => {
    expect(
      findCreatedProfile({
        before: new Set(["Work 1"]),
        after: [created, existing], // order must not matter
        name: "Work",
        apn: "work.fake",
      }),
    ).toBe(created);
  });

  it("among several new ids prefers the highest-index name+apn match", () => {
    const other = profile({ id: "Other 3", index: 3, name: "Other" });
    const later = profile({ id: "Work 4", index: 4 });
    expect(
      findCreatedProfile({
        before: new Set(["Work 1"]),
        after: [existing, created, other, later],
        name: "Work",
        apn: "work.fake",
      }),
    ).toBe(later);
  });

  it("falls back to the highest-index name+apn match when nothing is new", () => {
    expect(
      findCreatedProfile({
        before: new Set(["Work 1", "Work 2"]),
        after: [existing, created],
        name: "Work",
        apn: "work.fake",
      }),
    ).toBe(created);
  });

  it("returns null when nothing matches", () => {
    expect(
      findCreatedProfile({
        before: new Set(),
        after: [],
        name: "Work",
        apn: "work.fake",
      }),
    ).toBeNull();
  });
});
