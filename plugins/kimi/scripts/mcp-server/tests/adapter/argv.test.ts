import { describe, expect, it } from "vitest";
import { buildArgv } from "../../src/adapter/argv.js";
import type { KimiInvocation } from "../../src/adapter/types.js";

function base(over: Partial<KimiInvocation> = {}): KimiInvocation {
  return {
    prompt: "hello",
    outputFormat: "text",
    finalMessageOnly: true,
    ...over,
  };
}

describe("buildArgv", () => {
  it("emits --quiet for text + finalMessageOnly", () => {
    expect(buildArgv(base())).toEqual(["--quiet", "--prompt", "hello"]);
  });

  it("uses --print --output-format text when finalMessageOnly is false", () => {
    expect(buildArgv(base({ finalMessageOnly: false }))).toEqual([
      "--print",
      "--output-format",
      "text",
      "--prompt",
      "hello",
    ]);
  });

  it("emits stream-json without --final-message-only", () => {
    expect(buildArgv(base({ outputFormat: "stream-json", finalMessageOnly: false }))).toEqual([
      "--print",
      "--output-format",
      "stream-json",
      "--prompt",
      "hello",
    ]);
  });

  it("adds --work-dir before the prompt", () => {
    const argv = buildArgv(base({ workDir: "/abs/proj" }));
    expect(argv).toEqual(["--quiet", "--work-dir", "/abs/proj", "--prompt", "hello"]);
  });

  it("adds repeatable --add-dir entries", () => {
    const argv = buildArgv(base({
      workDir: "/abs/proj",
      addDirs: ["/abs/extra1", "/abs/extra2"],
    }));
    expect(argv).toEqual([
      "--quiet",
      "--work-dir",
      "/abs/proj",
      "--add-dir",
      "/abs/extra1",
      "--add-dir",
      "/abs/extra2",
      "--prompt",
      "hello",
    ]);
  });

  it("emits -r for session resume", () => {
    const argv = buildArgv(base({ sessionId: "c8c32f63-f8e7-434f-9776-83d2e09ab1ba" }));
    expect(argv).toEqual([
      "--quiet",
      "-r",
      "c8c32f63-f8e7-434f-9776-83d2e09ab1ba",
      "--prompt",
      "hello",
    ]);
  });

  it("emits --max-steps-per-turn when set", () => {
    expect(buildArgv(base({ maxStepsPerTurn: 5 }))).toEqual([
      "--quiet",
      "--max-steps-per-turn",
      "5",
      "--prompt",
      "hello",
    ]);
  });

  it("emits -m for explicit model override", () => {
    expect(buildArgv(base({ model: "kimi-code/kimi-for-coding" }))).toEqual([
      "--quiet",
      "-m",
      "kimi-code/kimi-for-coding",
      "--prompt",
      "hello",
    ]);
  });

  it("emits --thinking and --no-thinking", () => {
    expect(buildArgv(base({ thinking: true }))).toEqual([
      "--quiet",
      "--thinking",
      "--prompt",
      "hello",
    ]);
    expect(buildArgv(base({ noThinking: true }))).toEqual([
      "--quiet",
      "--no-thinking",
      "--prompt",
      "hello",
    ]);
  });

  it("emits --config-file", () => {
    expect(buildArgv(base({ configFile: "/tmp/x.toml" }))).toEqual([
      "--quiet",
      "--config-file",
      "/tmp/x.toml",
      "--prompt",
      "hello",
    ]);
  });

  it("keeps the prompt as the FINAL positional argument", () => {
    const argv = buildArgv(base({
      workDir: "/w",
      maxStepsPerTurn: 3,
      sessionId: "c8c32f63-f8e7-434f-9776-83d2e09ab1ba",
      model: "m",
      prompt: "FINAL_PROMPT",
    }));
    expect(argv[argv.length - 1]).toBe("FINAL_PROMPT");
  });

  it("rejects an empty prompt", () => {
    expect(() => buildArgv(base({ prompt: "" }))).toThrow(/prompt/i);
  });

  it("rejects a session id that is not a UUID", () => {
    expect(() => buildArgv(base({ sessionId: "not-a-uuid" }))).toThrow(/session/i);
  });

  it("rejects a non-absolute workDir", () => {
    expect(() => buildArgv(base({ workDir: "relative/path" }))).toThrow(/absolute/i);
  });

  it("rejects a non-absolute addDir entry", () => {
    expect(() => buildArgv(base({ workDir: "/abs", addDirs: ["./relative"] }))).toThrow(/absolute/i);
  });

  it("rejects an invalid output format combo (stream-json + finalMessageOnly)", () => {
    expect(() =>
      buildArgv(base({ outputFormat: "stream-json", finalMessageOnly: true })),
    ).toThrow(/final-message-only.*stream-json|stream-json.*final-message-only/i);
  });
});
