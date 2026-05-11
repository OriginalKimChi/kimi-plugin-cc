import { describe, expect, it } from "vitest";
import {
  REVIEW_DEFAULT_TIMEOUT_SECONDS,
  REVIEW_MAX_TIMEOUT_SECONDS,
  KimiReviewInputSchema,
  runKimiReview,
  type KimiReviewContext,
} from "../../src/tools/review.js";
import type {
  SubprocessOptions,
  SubprocessResult,
} from "../../src/adapter/subprocess-runner.js";

const UUID = "12345678-1234-1234-1234-123456789abc";

function fakeSubprocess(result: Partial<SubprocessResult>): {
  fn: NonNullable<KimiReviewContext["_runSubprocess"]>;
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

function baseCtx(over: Partial<KimiReviewContext> = {}): KimiReviewContext {
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

describe("KimiReviewInputSchema", () => {
  it("requires a non-empty prompt", () => {
    expect(KimiReviewInputSchema.safeParse({}).success).toBe(false);
    expect(KimiReviewInputSchema.safeParse({ prompt: "review this PR" }).success).toBe(true);
  });

  it("default 300 s / cap 600 s timeout policy", () => {
    expect(REVIEW_DEFAULT_TIMEOUT_SECONDS).toBe(300);
    expect(REVIEW_MAX_TIMEOUT_SECONDS).toBe(600);
    expect(KimiReviewInputSchema.safeParse({ prompt: "x", timeout_seconds: 601 }).success).toBe(
      false,
    );
    expect(KimiReviewInputSchema.safeParse({ prompt: "x", timeout_seconds: 600 }).success).toBe(
      true,
    );
  });

  it("rejects unknown fields (strict)", () => {
    expect(KimiReviewInputSchema.safeParse({ prompt: "x", weird: 1 }).success).toBe(false);
  });
});

describe("runKimiReview — success", () => {
  it("returns finalMessage and applies the 300 s default timeout", async () => {
    const stdout = `Looks good.\n\nTo resume this session: kimi -r ${UUID}\n`;
    const { fn, calls } = fakeSubprocess({ stdout });

    const out = await runKimiReview(
      { prompt: "review my diff" },
      baseCtx({ _runSubprocess: fn }),
    );

    expect(out.isError).toBeFalsy();
    expect(out.content).toEqual([{ type: "text", text: "Looks good." }]);
    expect(calls[0]!.timeoutMs).toBe(REVIEW_DEFAULT_TIMEOUT_SECONDS * 1000);
  });
});

describe("runKimiReview — validation errors", () => {
  it("missing prompt → isError validation_error, no spawn", async () => {
    const { fn, calls } = fakeSubprocess({});

    const out = await runKimiReview({}, baseCtx({ _runSubprocess: fn }));

    expect(out.isError).toBe(true);
    expect(calls).toHaveLength(0);
    const env = JSON.parse((out.content[0] as { text: string }).text) as { code: string };
    expect(env.code).toBe("validation_error");
  });
});
