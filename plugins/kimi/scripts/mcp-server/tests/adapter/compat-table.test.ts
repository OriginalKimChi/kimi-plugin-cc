import { describe, expect, it } from "vitest";
import { parseKimiVersion, selectCompatEntry, CLI_COMPAT } from "../../src/adapter/compat-table.js";

describe("parseKimiVersion", () => {
  it("parses the canonical output", () => {
    expect(parseKimiVersion("kimi, version 1.41.0\n")).toBe("1.41.0");
  });

  it("parses with extra whitespace", () => {
    expect(parseKimiVersion("  kimi, version 1.41.0  ")).toBe("1.41.0");
  });

  it("returns null for garbage", () => {
    expect(parseKimiVersion("not a version line")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseKimiVersion("")).toBeNull();
  });
});

describe("selectCompatEntry", () => {
  it("returns the 1.41 entry for 1.41.0", () => {
    const entry = selectCompatEntry("1.41.0");
    expect(entry.id).toBe("v1.41");
    expect(entry.supported).toBe(true);
  });

  it("returns the 1.41 entry for a 1.41.x patch release", () => {
    const entry = selectCompatEntry("1.41.5");
    expect(entry.id).toBe("v1.41");
    expect(entry.supported).toBe(true);
  });

  it("falls back to the newest entry and flags unsupported for an unknown version", () => {
    const entry = selectCompatEntry("999.0.0");
    expect(entry.supported).toBe(false);
  });

  it("falls back when version cannot be parsed", () => {
    const entry = selectCompatEntry(null);
    expect(entry.supported).toBe(false);
  });

  it("exposes at least one compat entry", () => {
    expect(CLI_COMPAT.length).toBeGreaterThan(0);
  });
});
