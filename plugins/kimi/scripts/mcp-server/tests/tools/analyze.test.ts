import { describe, expect, it } from "vitest";
import {
  ANALYZE_DEFAULT_TIMEOUT_SECONDS,
  ANALYZE_MAX_TIMEOUT_SECONDS,
  KimiAnalyzeInputSchema,
  runKimiAnalyze,
  type KimiAnalyzeContext,
} from "../../src/tools/analyze.js";
import type {
  SubprocessOptions,
  SubprocessResult,
} from "../../src/adapter/subprocess-runner.js";

const UUID = "12345678-1234-1234-1234-123456789abc";

function fakeSubprocess(result: Partial<SubprocessResult>): {
  fn: NonNullable<KimiAnalyzeContext["_runSubprocess"]>;
  calls: SubprocessOptions[];
} {
  const calls: SubprocessOptions[] = [];
  const fn = async (opts: SubprocessOptions): Promise<SubprocessResult> => {
    calls.push(opts);
    return {
      stdout: "",
      stderr: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      exitCode: 0,
      signal: null,
      durationMs: 5,
      truncated: { stdout: false, stderr: false },
      killedBy: "completed",
      ...result,
    };
  };
  return { fn, calls };
}

function baseCtx(over: Partial<KimiAnalyzeContext> = {}): KimiAnalyzeContext {
  return {
    parentEnv: {
      PATH: "/usr/bin",
      HOME: "/Users/test",
      KIMI_CODE_API_KEY: "sk-kc-default-test",
    },
    pluginVersion: "0.0.1-test",
    ...over,
  };
}

describe("KimiAnalyzeInputSchema", () => {
  it("requires a non-empty prompt", () => {
    expect(KimiAnalyzeInputSchema.safeParse({}).success).toBe(false);
    expect(KimiAnalyzeInputSchema.safeParse({ prompt: "" }).success).toBe(false);
    expect(KimiAnalyzeInputSchema.safeParse({ prompt: "look at this repo" }).success).toBe(true);
  });

  it("caps timeout_seconds at 600 (default 300)", () => {
    expect(ANALYZE_DEFAULT_TIMEOUT_SECONDS).toBe(300);
    expect(ANALYZE_MAX_TIMEOUT_SECONDS).toBe(600);
    expect(KimiAnalyzeInputSchema.safeParse({ prompt: "x", timeout_seconds: 601 }).success).toBe(
      false,
    );
    expect(KimiAnalyzeInputSchema.safeParse({ prompt: "x", timeout_seconds: 600 }).success).toBe(
      true,
    );
  });

  it("accepts optional model / work_dir / add_dirs / max_steps_per_turn / session_id", () => {
    expect(
      KimiAnalyzeInputSchema.safeParse({
        prompt: "analyze",
        model: "kimi-mocha",
        work_dir: "/abs",
        add_dirs: ["/abs/a"],
        max_steps_per_turn: 8,
        session_id: UUID,
      }).success,
    ).toBe(true);
  });

  it("rejects unknown fields (strict)", () => {
    expect(KimiAnalyzeInputSchema.safeParse({ prompt: "x", extra: 1 }).success).toBe(false);
  });
});

describe("runKimiAnalyze — success", () => {
  it("returns finalMessage and applies the 300 s default timeout", async () => {
    const stdout = `Analysis: clean.\n\nTo resume this session: kimi -r ${UUID}\n`;
    const { fn, calls } = fakeSubprocess({ stdout });

    const out = await runKimiAnalyze(
      { prompt: "analyze this repo" },
      baseCtx({ _runSubprocess: fn }),
    );

    expect(out.isError).toBeFalsy();
    expect(out.content).toEqual([{ type: "text", text: "Analysis: clean." }]);
    expect(calls[0]!.timeoutMs).toBe(ANALYZE_DEFAULT_TIMEOUT_SECONDS * 1000);
  });

  it("honors timeout_seconds when within cap", async () => {
    const { fn, calls } = fakeSubprocess({ stdout: "ok\n" });

    await runKimiAnalyze(
      { prompt: "x", timeout_seconds: 555 },
      baseCtx({ _runSubprocess: fn }),
    );

    expect(calls[0]!.timeoutMs).toBe(555_000);
  });
});

describe("runKimiAnalyze — validation errors", () => {
  it("missing prompt → isError validation_error, no spawn", async () => {
    const { fn, calls } = fakeSubprocess({});

    const out = await runKimiAnalyze({}, baseCtx({ _runSubprocess: fn }));

    expect(out.isError).toBe(true);
    expect(calls).toHaveLength(0);
    const env = JSON.parse((out.content[0] as { text: string }).text) as { code: string };
    expect(env.code).toBe("validation_error");
  });
});
