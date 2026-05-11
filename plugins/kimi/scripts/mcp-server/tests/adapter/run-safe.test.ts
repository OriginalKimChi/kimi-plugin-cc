import { describe, expect, it } from "vitest";
import { runKimiSafe } from "../../src/adapter/run-safe.js";
import type { RunKimiContext } from "../../src/adapter/runner.js";
import type { SubprocessOptions, SubprocessResult } from "../../src/adapter/subprocess-runner.js";

const UUID = "12345678-1234-1234-1234-123456789abc";

function fakeSubprocess(result: Partial<SubprocessResult>): {
  fn: NonNullable<RunKimiContext["_runSubprocess"]>;
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

function baseCtx(over: Partial<RunKimiContext> = {}): RunKimiContext {
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

function neverCall(): NonNullable<RunKimiContext["_runSubprocess"]> {
  return async () => {
    throw new Error("subprocess should not have been invoked");
  };
}

describe("runKimiSafe — success path", () => {
  it("returns ok=true with KimiResult", async () => {
    const stdout = `Hi.\n\nTo resume this session: kimi -r ${UUID}\n`;
    const { fn } = fakeSubprocess({ stdout });

    const outcome = await runKimiSafe(
      { prompt: "x", outputFormat: "text", finalMessageOnly: true, timeoutSeconds: 5 },
      baseCtx({
        parentEnv: { PATH: "/usr/bin", HOME: "/Users/test", KIMI_CODE_API_KEY: "sk-kc-OK" },
        _runSubprocess: fn,
      }),
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.sessionId).toBe(UUID);
      expect(outcome.result.finalMessage).toBe("Hi.");
    }
  });
});

describe("runKimiSafe — auth_missing precheck", () => {
  it("returns ok:false code='auth_missing' when neither auth env var is set", async () => {
    const outcome = await runKimiSafe(
      { prompt: "x", outputFormat: "text", finalMessageOnly: true, timeoutSeconds: 1 },
      baseCtx({
        parentEnv: { PATH: "/usr/bin", HOME: "/Users/test" }, // no auth keys
        _runSubprocess: neverCall(),
      }),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("auth_missing");
    }
  });

  it("passes when KIMI_CODE_API_KEY is set", async () => {
    const { fn } = fakeSubprocess({ stdout: "ok\n" });
    const outcome = await runKimiSafe(
      { prompt: "x", outputFormat: "text", finalMessageOnly: true, timeoutSeconds: 1 },
      baseCtx({
        parentEnv: { PATH: "/usr/bin", HOME: "/Users/test", KIMI_CODE_API_KEY: "sk-kc-OK" },
        _runSubprocess: fn,
      }),
    );
    expect(outcome.ok).toBe(true);
  });

  it("passes when only MOONSHOT_API_KEY is set", async () => {
    const { fn } = fakeSubprocess({ stdout: "ok\n" });
    const outcome = await runKimiSafe(
      { prompt: "x", outputFormat: "text", finalMessageOnly: true, timeoutSeconds: 1 },
      baseCtx({
        parentEnv: { PATH: "/usr/bin", HOME: "/Users/test", MOONSHOT_API_KEY: "sk-ms-OK" },
        _runSubprocess: fn,
      }),
    );
    expect(outcome.ok).toBe(true);
  });
});

describe("runKimiSafe — caught errors", () => {
  it("PathValidationError → ok:false code='path_validation', no spawn", async () => {
    const outcome = await runKimiSafe(
      {
        prompt: "x",
        outputFormat: "text",
        finalMessageOnly: true,
        workDir: "relative/dir",
        timeoutSeconds: 1,
      },
      baseCtx({ _runSubprocess: neverCall() }),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("path_validation");
      expect(outcome.error.message).toContain("workDir");
    }
  });

  it("spawn ENOENT → ok:false code='cli_not_found'", async () => {
    const enoentSpawn: NonNullable<RunKimiContext["_runSubprocess"]> = async () => {
      const e: NodeJS.ErrnoException = Object.assign(new Error("spawn kimi ENOENT"), {
        code: "ENOENT",
        errno: -2,
        syscall: "spawn kimi",
      });
      throw e;
    };

    const outcome = await runKimiSafe(
      { prompt: "x", outputFormat: "text", finalMessageOnly: true, timeoutSeconds: 1 },
      baseCtx({ _runSubprocess: enoentSpawn }),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("cli_not_found");
      expect(outcome.error.message).toContain("ENOENT");
    }
  });

  it("classifier failure (nonzero exit) surfaces as ok:false", async () => {
    const apiKey = "sk-kc-SECRET-VALUE-1234";
    const { fn } = fakeSubprocess({
      exitCode: 1,
      stderr: "kimi: something broke\n",
      durationMs: 99,
    });

    const outcome = await runKimiSafe(
      { prompt: apiKey, outputFormat: "text", finalMessageOnly: true, timeoutSeconds: 1 },
      baseCtx({
        parentEnv: {
          PATH: "/usr/bin",
          HOME: "/Users/test",
          KIMI_CODE_API_KEY: apiKey,
        },
        _runSubprocess: fn,
      }),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("cli_exit_nonzero");
      expect(outcome.error.details.duration_ms).toBe(99);
      expect(outcome.error.details.stderr_excerpt).toContain("something broke");
    }
  });

  it("populates argv_redacted on PathValidationError envelopes (redacting secret-valued args)", async () => {
    const apiKey = "sk-kc-SECRET-VALUE-1234";
    const outcome = await runKimiSafe(
      {
        prompt: apiKey,
        model: "kimi-mocha",
        outputFormat: "text",
        finalMessageOnly: true,
        // workDir below is a valid absolute path that doesn't exist → triggers PathValidationError
        workDir: "/definitely/not/a/real/path/for/run-safe/test",
        timeoutSeconds: 1,
      },
      baseCtx({
        parentEnv: {
          PATH: "/usr/bin",
          HOME: "/Users/test",
          KIMI_CODE_API_KEY: apiKey,
        },
        _runSubprocess: neverCall(),
      }),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("path_validation");
      // argv should include the model + prompt (redacted) and the would-be workDir
      expect(outcome.error.details.argv_redacted).toContain("kimi-mocha");
      expect(outcome.error.details.argv_redacted).toContain("***REDACTED***");
      expect(outcome.error.details.argv_redacted).not.toContain(apiKey);
    }
  });

  it("populates argv_redacted on ENOENT envelopes", async () => {
    const enoentSpawn: NonNullable<RunKimiContext["_runSubprocess"]> = async () => {
      const e: NodeJS.ErrnoException = Object.assign(new Error("spawn kimi ENOENT"), {
        code: "ENOENT",
      });
      throw e;
    };

    const outcome = await runKimiSafe(
      { prompt: "hello", outputFormat: "text", finalMessageOnly: true, timeoutSeconds: 1 },
      baseCtx({ _runSubprocess: enoentSpawn }),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("cli_not_found");
      expect(outcome.error.details.argv_redacted).toEqual(["--quiet", "hello"]);
    }
  });

  it("populates argv_redacted on classifier failures", async () => {
    const { fn } = fakeSubprocess({ exitCode: 1, stderr: "broke" });
    const outcome = await runKimiSafe(
      { prompt: "hi", outputFormat: "text", finalMessageOnly: true, timeoutSeconds: 1 },
      baseCtx({ _runSubprocess: fn }),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("cli_exit_nonzero");
      expect(outcome.error.details.argv_redacted).toEqual(["--quiet", "hi"]);
    }
  });

  it("forwards authFailurePatterns into classifier", async () => {
    const { fn } = fakeSubprocess({
      exitCode: 1,
      stderr: "Error: invalid API key (401)\n",
    });

    const outcome = await runKimiSafe(
      { prompt: "x", outputFormat: "text", finalMessageOnly: true, timeoutSeconds: 1 },
      baseCtx({ _runSubprocess: fn }),
      { authFailurePatterns: [/invalid api key/i] },
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("auth_invalid");
    }
  });
});
