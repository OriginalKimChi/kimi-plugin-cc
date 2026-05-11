import { describe, expect, it } from "vitest";
import {
  KimiQueryInputSchema,
  QUERY_DEFAULT_TIMEOUT_SECONDS,
  QUERY_MAX_TIMEOUT_SECONDS,
  runKimiQuery,
  type KimiQueryContext,
} from "../../src/tools/query.js";
import type {
  SubprocessOptions,
  SubprocessResult,
} from "../../src/adapter/subprocess-runner.js";

const UUID = "12345678-1234-1234-1234-123456789abc";

function fakeSubprocess(result: Partial<SubprocessResult>): {
  fn: NonNullable<KimiQueryContext["_runSubprocess"]>;
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

function baseCtx(over: Partial<KimiQueryContext> = {}): KimiQueryContext {
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

describe("KimiQueryInputSchema", () => {
  it("requires a non-empty prompt", () => {
    expect(KimiQueryInputSchema.safeParse({}).success).toBe(false);
    expect(KimiQueryInputSchema.safeParse({ prompt: "" }).success).toBe(false);
    expect(KimiQueryInputSchema.safeParse({ prompt: "hi" }).success).toBe(true);
  });

  it("accepts optional model / work_dir / add_dirs / max_steps_per_turn / session_id / timeout_seconds", () => {
    const out = KimiQueryInputSchema.safeParse({
      prompt: "hi",
      model: "kimi-mocha",
      work_dir: "/abs/work",
      add_dirs: ["/abs/a", "/abs/b"],
      max_steps_per_turn: 8,
      session_id: UUID,
      timeout_seconds: 90,
    });
    expect(out.success).toBe(true);
  });

  it("rejects timeout_seconds > 300", () => {
    expect(KimiQueryInputSchema.safeParse({ prompt: "x", timeout_seconds: 301 }).success).toBe(
      false,
    );
    expect(KimiQueryInputSchema.safeParse({ prompt: "x", timeout_seconds: 300 }).success).toBe(
      true,
    );
  });

  it("rejects session_id that isn't a UUID", () => {
    expect(KimiQueryInputSchema.safeParse({ prompt: "x", session_id: "not-a-uuid" }).success).toBe(
      false,
    );
  });

  it("rejects unknown top-level fields", () => {
    expect(KimiQueryInputSchema.safeParse({ prompt: "x", weird: true }).success).toBe(false);
  });

  it("accepts output_format='stream-json'", () => {
    expect(
      KimiQueryInputSchema.safeParse({ prompt: "x", output_format: "stream-json" }).success,
    ).toBe(true);
  });

  it("rejects unknown output_format value", () => {
    expect(
      KimiQueryInputSchema.safeParse({ prompt: "x", output_format: "yaml" }).success,
    ).toBe(false);
  });
});

describe("runKimiQuery — stream-json mode", () => {
  it("passes outputFormat='stream-json' (no --quiet) and surfaces raw_events", async () => {
    const UUID2 = "abcdef12-3456-7890-abcd-ef1234567890";
    const stdout = [
      `{"role":"user","content":"hi"}`,
      `{"role":"assistant","content":"hello back"}`,
      `To resume this session: kimi -r ${UUID2}`,
      ``,
    ].join("\n");
    const { fn, calls } = fakeSubprocess({ stdout });

    const out = await runKimiQuery(
      { prompt: "hi", output_format: "stream-json" },
      baseCtx({ _runSubprocess: fn }),
    );

    expect(out.isError).toBeFalsy();
    expect(calls[0]!.argv).toContain("--print");
    expect(calls[0]!.argv).toContain("--output-format");
    expect(calls[0]!.argv).toContain("stream-json");
    expect(calls[0]!.argv).not.toContain("--quiet");

    const sc = out.structuredContent as Record<string, unknown>;
    expect(Array.isArray(sc.raw_events)).toBe(true);
    expect((sc.raw_events as unknown[]).length).toBe(2);
    expect(sc.session_id).toBe(UUID2);
  });
});

describe("runKimiQuery — success", () => {
  it("returns MCP content with the finalMessage on ok=true", async () => {
    const stdout = `Answer: 42.\n\nTo resume this session: kimi -r ${UUID}\n`;
    const { fn } = fakeSubprocess({ stdout });

    const out = await runKimiQuery({ prompt: "what is 6*7?" }, baseCtx({ _runSubprocess: fn }));

    expect(out.isError).toBeFalsy();
    expect(out.content).toEqual([{ type: "text", text: "Answer: 42." }]);
    expect(out.structuredContent).toMatchObject({
      session_id: UUID,
      exit_code: 0,
      duration_ms: expect.any(Number),
    });
  });

  it("uses timeout default of 120 seconds when omitted", async () => {
    const { fn, calls } = fakeSubprocess({ stdout: "ok\n" });

    await runKimiQuery({ prompt: "x" }, baseCtx({ _runSubprocess: fn }));

    expect(QUERY_DEFAULT_TIMEOUT_SECONDS).toBe(120);
    expect(QUERY_MAX_TIMEOUT_SECONDS).toBe(300);
    expect(calls[0]!.timeoutMs).toBe(QUERY_DEFAULT_TIMEOUT_SECONDS * 1000);
  });

  it("honors timeout_seconds when provided", async () => {
    const { fn, calls } = fakeSubprocess({ stdout: "ok\n" });

    await runKimiQuery(
      { prompt: "x", timeout_seconds: 45 },
      baseCtx({ _runSubprocess: fn }),
    );

    expect(calls[0]!.timeoutMs).toBe(45_000);
  });

  it("passes prompt + model + session_id through to argv", async () => {
    const { fn, calls } = fakeSubprocess({ stdout: "ok\n" });

    await runKimiQuery(
      { prompt: "describe", model: "kimi-mocha", session_id: UUID },
      baseCtx({ _runSubprocess: fn }),
    );

    expect(calls[0]!.argv).toContain("-m");
    expect(calls[0]!.argv).toContain("kimi-mocha");
    expect(calls[0]!.argv).toContain("-r");
    expect(calls[0]!.argv).toContain(UUID);
    expect(calls[0]!.argv).toContain("describe");
  });
});

describe("runKimiQuery — validation errors", () => {
  it("returns isError envelope with code='validation_error' when input fails Zod", async () => {
    const { fn, calls } = fakeSubprocess({});

    const out = await runKimiQuery({}, baseCtx({ _runSubprocess: fn }));

    expect(out.isError).toBe(true);
    expect(calls).toHaveLength(0);
    const env = JSON.parse((out.content[0] as { text: string }).text) as {
      code: string;
      message: string;
    };
    expect(env.code).toBe("validation_error");
    expect(env.message.length).toBeGreaterThan(0);
  });
});

describe("runKimiQuery — forwarded adapter errors", () => {
  it("auth_missing → isError envelope, no spawn", async () => {
    const { fn, calls } = fakeSubprocess({});

    const out = await runKimiQuery(
      { prompt: "x" },
      baseCtx({
        parentEnv: { PATH: "/usr/bin" }, // no auth
        _runSubprocess: fn,
      }),
    );

    expect(out.isError).toBe(true);
    expect(calls).toHaveLength(0);
    const env = JSON.parse((out.content[0] as { text: string }).text) as { code: string };
    expect(env.code).toBe("auth_missing");
  });

  it("cli_exit_nonzero surfaces with redacted argv", async () => {
    const { fn } = fakeSubprocess({ exitCode: 1, stderr: "broke" });

    const out = await runKimiQuery({ prompt: "x" }, baseCtx({ _runSubprocess: fn }));

    expect(out.isError).toBe(true);
    const env = JSON.parse((out.content[0] as { text: string }).text) as {
      code: string;
      details: { argv_redacted: string[] };
    };
    expect(env.code).toBe("cli_exit_nonzero");
    expect(env.details.argv_redacted).toContain("--quiet");
  });
});
