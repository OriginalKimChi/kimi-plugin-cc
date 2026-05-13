import { describe, expect, it } from "vitest";
import { extractAndValidateFindings } from "../../src/adapter/review-schema.js";

function r1(extra: Record<string, unknown> = {}): unknown {
  return {
    schema_version: "findings_v1",
    verdict: "approve",
    summary: "ok",
    findings: [],
    next_steps: [],
    attack_round: 1,
    ...extra,
  };
}

function finding(over: Record<string, unknown> = {}): unknown {
  return {
    id: "f-abcd1",
    severity: "low",
    title: "t",
    body: "b",
    file: "a.ts",
    line_start: 1,
    line_end: 2,
    confidence: 0.5,
    ...over,
  };
}

describe("extractAndValidateFindings — JSON extraction", () => {
  it("parses a bare JSON object", () => {
    const out = extractAndValidateFindings(JSON.stringify(r1()));
    expect(out.ok).toBe(true);
  });

  it("parses JSON wrapped in a ```json fence", () => {
    const wrapped = "Here you go:\n```json\n" + JSON.stringify(r1()) + "\n```\nThanks";
    const out = extractAndValidateFindings(wrapped);
    expect(out.ok).toBe(true);
  });

  it("parses JSON with prose before and after", () => {
    const wrapped = "Sure!\n\n" + JSON.stringify(r1()) + "\n\nThat's all.";
    const out = extractAndValidateFindings(wrapped);
    expect(out.ok).toBe(true);
  });

  it("fails cleanly when no JSON is present", () => {
    const out = extractAndValidateFindings("I cannot review this.");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/no JSON/i);
  });
});

describe("extractAndValidateFindings — schema rules", () => {
  it("rejects wrong schema_version", () => {
    const out = extractAndValidateFindings(JSON.stringify(r1({ schema_version: "v2" })));
    expect(out.ok).toBe(false);
  });

  it("rejects invalid verdict", () => {
    const out = extractAndValidateFindings(JSON.stringify(r1({ verdict: "wat" })));
    expect(out.ok).toBe(false);
  });

  it("rejects findings missing required fields", () => {
    const bad = r1({ findings: [{ id: "f-x" }] });
    const out = extractAndValidateFindings(JSON.stringify(bad));
    expect(out.ok).toBe(false);
  });

  it("rejects duplicate finding ids", () => {
    const dup = r1({ findings: [finding({ id: "f-aaa1" }), finding({ id: "f-aaa1" })] });
    const out = extractAndValidateFindings(JSON.stringify(dup));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/duplicate/i);
  });

  it("accepts a fully-valid round-1 object", () => {
    const valid = r1({
      verdict: "needs-attention",
      summary: "Found issues",
      findings: [
        finding({ id: "f-aaa1", severity: "high", title: "Race", body: "X races Y", file: "a.ts", line_start: 10, line_end: 12 }),
        finding({ id: "f-aaa2", severity: "low", title: "Style", body: "...", file: "b.ts", line_start: 1, line_end: 1, recommendation: "use foo" }),
      ],
      next_steps: ["Add a mutex"],
    });
    const out = extractAndValidateFindings(JSON.stringify(valid));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.findings.length).toBe(2);
      expect(out.value.verdict).toBe("needs-attention");
    }
  });

  it("accepts round-2 with responding_to + stance", () => {
    const r2 = r1({
      attack_round: 2,
      verdict: "needs-attention",
      findings: [
        finding({
          id: "f-bbb1",
          stance: "rebut",
          responding_to: ["f-aaa1"],
          severity: "medium",
          title: "Round 1 was wrong",
          body: "Actually fine because…",
        }),
      ],
    });
    const out = extractAndValidateFindings(JSON.stringify(r2));
    expect(out.ok).toBe(true);
  });

  it("rejects round-2 finding with invalid responding_to id format", () => {
    const r2 = r1({
      attack_round: 2,
      findings: [finding({ id: "f-bbb1", stance: "rebut", responding_to: ["INVALID"] })],
    });
    const out = extractAndValidateFindings(JSON.stringify(r2));
    expect(out.ok).toBe(false);
  });
});
