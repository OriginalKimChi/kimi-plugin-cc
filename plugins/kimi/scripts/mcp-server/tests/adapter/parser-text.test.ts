import { describe, expect, it } from "vitest";
import { parseTextStdout } from "../../src/adapter/parser-text.js";

const UUID = "c8c32f63-f8e7-434f-9776-83d2e09ab1ba";

describe("parseTextStdout", () => {
  it("extracts final message and session id from a typical reply", () => {
    const stdout =
      `The square root of 144 is 12.\n\nTo resume this session: kimi -r ${UUID}\n`;
    const out = parseTextStdout(stdout);
    expect(out.sessionId).toBe(UUID);
    expect(out.finalMessage).toBe("The square root of 144 is 12.");
    expect(out.trailingMarkerMissing).toBe(false);
  });

  it("returns sessionId=null and full stdout when no marker present", () => {
    const stdout = "Just an answer, no marker here.\n";
    const out = parseTextStdout(stdout);
    expect(out.sessionId).toBeNull();
    expect(out.finalMessage).toBe("Just an answer, no marker here.");
    expect(out.trailingMarkerMissing).toBe(true);
  });

  it("handles multi-line final messages and preserves internal blank lines", () => {
    const stdout = [
      "Line one of the answer.",
      "",
      "Line three of the answer.",
      "",
      `To resume this session: kimi -r ${UUID}`,
      "",
    ].join("\n");
    const out = parseTextStdout(stdout);
    expect(out.sessionId).toBe(UUID);
    expect(out.finalMessage).toBe(
      "Line one of the answer.\n\nLine three of the answer.",
    );
  });

  it("tolerates trailing whitespace after the marker", () => {
    const stdout = `Hello.\n\nTo resume this session: kimi -r ${UUID}    \n\n\n`;
    const out = parseTextStdout(stdout);
    expect(out.sessionId).toBe(UUID);
    expect(out.finalMessage).toBe("Hello.");
  });

  it("handles CRLF line endings", () => {
    const stdout = `Answer.\r\n\r\nTo resume this session: kimi -r ${UUID}\r\n`;
    const out = parseTextStdout(stdout);
    expect(out.sessionId).toBe(UUID);
    expect(out.finalMessage).toBe("Answer.");
  });

  it("handles empty stdout", () => {
    const out = parseTextStdout("");
    expect(out.sessionId).toBeNull();
    expect(out.finalMessage).toBe("");
    expect(out.trailingMarkerMissing).toBe(true);
  });

  it("rejects an ID that is not a UUID and keeps the whole stdout", () => {
    const stdout = "Answer.\n\nTo resume this session: kimi -r not-a-uuid\n";
    const out = parseTextStdout(stdout);
    // not-a-uuid is not parsed as a session id; the line stays in finalMessage
    expect(out.sessionId).toBeNull();
    expect(out.trailingMarkerMissing).toBe(true);
    expect(out.finalMessage).toContain("not-a-uuid");
  });

  it("matches the captured fixture sample-resume.txt", () => {
    // contents copied verbatim from docs/fixtures/cli-probe/sample-resume.txt
    const stdout =
      "Twice 12 is **24**.\n\nTo resume this session: kimi -r b3782c52-842f-4507-9f97-a837fb7a63e5\n";
    const out = parseTextStdout(stdout);
    expect(out.sessionId).toBe("b3782c52-842f-4507-9f97-a837fb7a63e5");
    expect(out.finalMessage).toBe("Twice 12 is **24**.");
  });
});
