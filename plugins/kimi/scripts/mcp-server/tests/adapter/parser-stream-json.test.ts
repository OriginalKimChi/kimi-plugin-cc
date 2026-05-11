import { describe, expect, it } from "vitest";
import { parseStreamJsonStdout } from "../../src/adapter/parser-stream-json.js";

const UUID = "b3782c52-842f-4507-9f97-a837fb7a63e5";

describe("parseStreamJsonStdout", () => {
  it("extracts a single assistant event and session id", () => {
    const stdout =
      `{"role":"assistant","content":"The square root of 144 is **12**."}\n` +
      `\n` +
      `To resume this session: kimi -r ${UUID}\n`;
    const out = parseStreamJsonStdout(stdout);
    expect(out.sessionId).toBe(UUID);
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toEqual({
      role: "assistant",
      content: "The square root of 144 is **12**.",
    });
    expect(out.finalMessage).toBe("The square root of 144 is **12**.");
    expect(out.malformedLines).toBe(0);
    expect(out.trailingMarkerMissing).toBe(false);
  });

  it("returns the last assistant content as finalMessage when there are several events", () => {
    const stdout =
      `{"role":"user","content":"hi"}\n` +
      `{"role":"assistant","content":"first"}\n` +
      `{"role":"tool","name":"search","content":"..."}\n` +
      `{"role":"assistant","content":"second and final"}\n` +
      `\n` +
      `To resume this session: kimi -r ${UUID}\n`;
    const out = parseStreamJsonStdout(stdout);
    expect(out.events).toHaveLength(4);
    expect(out.finalMessage).toBe("second and final");
  });

  it("skips bad lines and counts them in malformedLines", () => {
    const stdout =
      `{"role":"assistant","content":"a"}\n` +
      `not json at all\n` +
      `{"role":"assistant","content":"b"}\n` +
      `{broken json\n` +
      `\n` +
      `To resume this session: kimi -r ${UUID}\n`;
    const out = parseStreamJsonStdout(stdout);
    expect(out.events).toHaveLength(2);
    expect(out.finalMessage).toBe("b");
    expect(out.malformedLines).toBe(2);
  });

  it("returns empty events and missing marker for empty stdout", () => {
    const out = parseStreamJsonStdout("");
    expect(out.events).toHaveLength(0);
    expect(out.finalMessage).toBe("");
    expect(out.sessionId).toBeNull();
    expect(out.trailingMarkerMissing).toBe(true);
    expect(out.malformedLines).toBe(0);
  });

  it("flags missing marker but still parses events", () => {
    const stdout = `{"role":"assistant","content":"x"}\n`;
    const out = parseStreamJsonStdout(stdout);
    expect(out.sessionId).toBeNull();
    expect(out.trailingMarkerMissing).toBe(true);
    expect(out.finalMessage).toBe("x");
  });

  it("handles CRLF line endings", () => {
    const stdout =
      `{"role":"assistant","content":"hi"}\r\n` +
      `\r\n` +
      `To resume this session: kimi -r ${UUID}\r\n`;
    const out = parseStreamJsonStdout(stdout);
    expect(out.sessionId).toBe(UUID);
    expect(out.events).toHaveLength(1);
    expect(out.finalMessage).toBe("hi");
  });

  it("ignores assistant events with no content when picking finalMessage", () => {
    const stdout =
      `{"role":"assistant","content":"real"}\n` +
      `{"role":"assistant"}\n`;
    const out = parseStreamJsonStdout(stdout);
    expect(out.events).toHaveLength(2);
    expect(out.finalMessage).toBe("real");
  });

  it("matches the captured fixture sample-stream-json.txt", () => {
    const stdout =
      `{"role":"assistant","content":"The square root of 144 is **12**."}\n\nTo resume this session: kimi -r b3782c52-842f-4507-9f97-a837fb7a63e5\n`;
    const out = parseStreamJsonStdout(stdout);
    expect(out.sessionId).toBe("b3782c52-842f-4507-9f97-a837fb7a63e5");
    expect(out.finalMessage).toBe("The square root of 144 is **12**.");
    expect(out.malformedLines).toBe(0);
  });
});
