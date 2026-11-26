import { describe, expect, it } from "vitest";
import { list, parseFrontmatter, scalar } from "./frontmatter";

describe("parseFrontmatter", () => {
  it("reads scalars, quoted strings and the body", () => {
    const note = parseFrontmatter(`---
kind: invoice
issuer: "Example Utilities GmbH"
date: 2026-03-14
valid_until: 'none'
vault_id: abc-123
---
A gas invoice for March. Amount due in 14 days.
`);
    expect(note.data).toEqual({
      kind: "invoice",
      issuer: "Example Utilities GmbH",
      date: "2026-03-14",
      valid_until: "none",
      vault_id: "abc-123",
    });
    expect(note.body).toBe("A gas invoice for March. Amount due in 14 days.");
  });

  it("reads inline and block lists", () => {
    const note = parseFrontmatter(`---
tags: [energy, "gas, heating", 'home']
more:
  - first
  - "second one"
empty: []
---
body`);
    expect(note.data.tags).toEqual(["energy", "gas, heating", "home"]);
    expect(note.data.more).toEqual(["first", "second one"]);
    expect(note.data.empty).toEqual([]);
  });

  it("treats a key with nothing under it as an empty scalar", () => {
    const note = parseFrontmatter("---\ntax_year:\nkind: letter\n---\nx");
    expect(note.data).toEqual({ tax_year: "", kind: "letter" });
  });

  it("handles escapes in double quotes, comments, blank lines and CRLF", () => {
    const note = parseFrontmatter(
      '---\r\n# a comment\r\n\r\nissuer: "Example \\"Quote\\" AG"\r\n---\r\nBody\r\n',
    );
    expect(note.data.issuer).toBe('Example "Quote" AG');
    expect(note.body).toBe("Body");
  });

  it("returns no data without a frontmatter block", () => {
    expect(parseFrontmatter("just text")).toEqual({
      data: {},
      body: "just text",
    });
    expect(parseFrontmatter("---\nkind: x\nno end")).toEqual({
      data: {},
      body: "---\nkind: x\nno end",
    });
    expect(parseFrontmatter("")).toEqual({ data: {}, body: "" });
  });

  it("helpers read scalars and lists defensively", () => {
    expect(scalar("a")).toBe("a");
    expect(scalar(["a"])).toBe("");
    expect(scalar(undefined)).toBe("");
    expect(list(["a", "b"])).toEqual(["a", "b"]);
    expect(list("a")).toEqual(["a"]);
    expect(list("")).toEqual([]);
    expect(list(undefined)).toEqual([]);
  });
});
