import { describe, expect, it } from "vitest";
import {
  KimiResumeInputSchema,
  RESUME_DEFAULT_TIMEOUT_SECONDS,
  RESUME_MAX_TIMEOUT_SECONDS,
  runKimiResume,
  type KimiResumeContext,
} from "../../src/tools/resume.js";
import type {
  SubprocessOptions,
  SubprocessResult,
} from "../../src/adapter/subprocess-runner.js";

const UUID = "12345678-1234-1234-1234-123456789abc";
const UUID2 = "abcdef12-3456-7890-abcd-ef1234567890";

function fakeSubprocess(result: Partial<SubprocessResult>): {
  fn: NonNullable<KimiResumeContext["_runSubprocess"]>;
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

function baseCtx(over: Partial<KimiResumeContext> = {}): KimiResumeContext {
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

describe("KimiResumeInputSchema", () => {
  it("requires both session_id (UUID) and prompt", () => {
    expect(KimiResumeInputSchema.safeParse({ prompt: "hi" }).success).toBe(false);
    expect(KimiResumeInputSchema.safeParse({ session_id: UUID }).success).toBe(false);
    expect(KimiResumeInputSchema.safeParse({ prompt: "hi", session_id: UUID }).success).toBe(true);
    expect(KimiResumeInputSchema.safeParse({ prompt: "hi", session_id: "nope" }).success).toBe(
      false,
    );
  });

  it("caps timeout_seconds at 600 (default 300)", () => {
    expect(RESUME_DEFAULT_TIMEOUT_SECONDS).toBe(300);
    expect(RESUME_MAX_TIMEOUT_SECONDS).toBe(600);
    expect(
      KimiResumeInputSchema.safeParse({ prompt: "x", session_id: UUID, timeout_seconds: 601 })
        .success,
    ).toBe(false);
    expect(
      KimiResumeInputSchema.safeParse({ prompt: "x", session_id: UUID, timeout_seconds: 600 })
        .success,
    ).toBe(true);
  });

  it("rejects extra fields", () => {
    expect(
      KimiResumeInputSchema.safeParse({ prompt: "x", session_id: UUID, weird: 1 }).success,
    ).toBe(false);
  });
});

describe("runKimiResume — success", () => {
  it("passes -r <session_id> in argv and returns finalMessage", async () => {
    const stdout = `Continuing.\n\nTo resume this session: kimi -r ${UUID}\n`;
    const { fn, calls } = fakeSubprocess({ stdout });

    const out = await runKimiResume(
      { prompt: "continue", session_id: UUID },
      baseCtx({ _runSubprocess: fn }),
    );

    expect(out.isError).toBeFalsy();
    expect(out.content).toEqual([{ type: "text", text: "Continuing." }]);
    expect(calls[0]!.argv).toContain("-r");
    expect(calls[0]!.argv).toContain(UUID);
    expect(calls[0]!.timeoutMs).toBe(RESUME_DEFAULT_TIMEOUT_SECONDS * 1000);
    expect(out.structuredContent).toMatchObject({
      session_id: UUID,
      exit_code: 0,
    });
  });

  it("honors timeout_seconds when within cap", async () => {
    const { fn, calls } = fakeSubprocess({ stdout: "ok\n" });

    await runKimiResume(
      { prompt: "x", session_id: UUID, timeout_seconds: 500 },
      baseCtx({ _runSubprocess: fn }),
    );

    expect(calls[0]!.timeoutMs).toBe(500_000);
  });

  it("forwards a new server-issued session_id back via structuredContent", async () => {
    // CLI replies with a different UUID in the trailing marker (a re-issue).
    const stdout = `ok\n\nTo resume this session: kimi -r ${UUID2}\n`;
    const { fn } = fakeSubprocess({ stdout });

    const out = await runKimiResume(
      { prompt: "x", session_id: UUID },
      baseCtx({ _runSubprocess: fn }),
    );

    expect(out.structuredContent).toMatchObject({ session_id: UUID2 });
  });
});

describe("runKimiResume — validation errors", () => {
  it("missing session_id → isError validation_error, no spawn", async () => {
    const { fn, calls } = fakeSubprocess({});

    const out = await runKimiResume({ prompt: "x" }, baseCtx({ _runSubprocess: fn }));

    expect(out.isError).toBe(true);
    expect(calls).toHaveLength(0);
    const env = JSON.parse((out.content[0] as { text: string }).text) as { code: string };
    expect(env.code).toBe("validation_error");
  });

  it("non-UUID session_id → isError validation_error", async () => {
    const { fn, calls } = fakeSubprocess({});

    const out = await runKimiResume(
      { prompt: "x", session_id: "not-a-uuid" },
      baseCtx({ _runSubprocess: fn }),
    );

    expect(out.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
