import { describe, expect, it } from "vitest";
import {
  KimiError,
  classifyKimiResult,
  type ClassifyContext,
} from "../../src/adapter/errors.js";
import type { KimiResult } from "../../src/adapter/runner.js";

function baseResult(over: Partial<KimiResult> = {}): KimiResult {
  return {
    sessionId: "12345678-1234-1234-1234-123456789abc",
    finalMessage: "hi",
    stdout: "hi\n",
    stderr: "",
    stdoutBytes: 3,
    stderrBytes: 0,
    exitCode: 0,
    signal: null,
    durationMs: 42,
    truncated: { stdout: false, stderr: false },
    killedBy: "completed",
    trailingMarkerMissing: false,
    ...over,
  };
}

function baseCtx(over: Partial<ClassifyContext> = {}): ClassifyContext {
  return {
    argv: ["--quiet", "hello"],
    secrets: [],
    outputFormat: "text",
    ...over,
  };
}

describe("KimiError", () => {
  it("carries code, message, and details", () => {
    const err = new KimiError("timeout", "kill ladder fired", {
      stdout_excerpt: "partial",
      stderr_excerpt: "",
      argv_redacted: ["--quiet", "hello"],
      duration_ms: 12345,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("timeout");
    expect(err.message).toBe("kill ladder fired");
    expect(err.details.duration_ms).toBe(12345);
    expect(err.details.argv_redacted).toEqual(["--quiet", "hello"]);
  });
});

describe("classifyKimiResult — success", () => {
  it("returns null for clean exit with parsed result", () => {
    expect(classifyKimiResult(baseResult(), baseCtx())).toBeNull();
  });
});

describe("classifyKimiResult — kill-ladder kills map to 'timeout'", () => {
  it.each(["timeout", "stdout_cap", "stderr_cap"] as const)(
    "killedBy=%s → code='timeout'",
    (killedBy) => {
      const err = classifyKimiResult(
        baseResult({ killedBy, exitCode: null, signal: "SIGTERM" }),
        baseCtx(),
      );
      expect(err).toBeInstanceOf(KimiError);
      expect(err?.code).toBe("timeout");
      expect(err?.details.duration_ms).toBe(42);
    },
  );
});

describe("classifyKimiResult — failure classifications", () => {
  it("nonzero exit with no auth match → 'cli_exit_nonzero'", () => {
    const err = classifyKimiResult(
      baseResult({ exitCode: 1, stderr: "something broke" }),
      baseCtx(),
    );
    expect(err?.code).toBe("cli_exit_nonzero");
    expect(err?.details.stderr_excerpt).toContain("something broke");
  });

  it("auth failure pattern in stderr → 'auth_invalid' (wins over cli_exit_nonzero)", () => {
    const err = classifyKimiResult(
      baseResult({ exitCode: 1, stderr: "Error: invalid API key" }),
      baseCtx({ authFailurePatterns: [/invalid api key/i] }),
    );
    expect(err?.code).toBe("auth_invalid");
  });

  it("auth failure pattern wins over exit=0 too", () => {
    const err = classifyKimiResult(
      baseResult({ exitCode: 0, stderr: "401 Unauthorized" }),
      baseCtx({ authFailurePatterns: [/401\s+Unauthorized/] }),
    );
    expect(err?.code).toBe("auth_invalid");
  });

  it("signal present + killedBy='completed' → 'subprocess_killed_external'", () => {
    const err = classifyKimiResult(
      baseResult({ exitCode: null, signal: "SIGKILL", killedBy: "completed" }),
      baseCtx(),
    );
    expect(err?.code).toBe("subprocess_killed_external");
  });

  it("stream-json with 0 events on clean exit → 'cli_shape_error'", () => {
    const err = classifyKimiResult(
      baseResult({
        stdout: "nothing parseable here\n",
        finalMessage: "",
        rawEvents: [],
      }),
      baseCtx({ outputFormat: "stream-json" }),
    );
    expect(err?.code).toBe("cli_shape_error");
  });

  it("stream-json with at least one event → not cli_shape_error", () => {
    const err = classifyKimiResult(
      baseResult({
        finalMessage: "hi",
        rawEvents: [{ role: "assistant", content: "hi" }],
      }),
      baseCtx({ outputFormat: "stream-json" }),
    );
    expect(err).toBeNull();
  });
});

describe("classifyKimiResult — details redaction + caps", () => {
  it("replaces argv entries that equal a known secret with ***REDACTED***", () => {
    const apiKey = "sk-kc-VERY-SECRET-1234";
    const err = classifyKimiResult(
      baseResult({ exitCode: 1, stderr: "fail" }),
      baseCtx({
        argv: ["--config-file", "/path", "--auth", apiKey, "prompt-here"],
        secrets: [apiKey],
      }),
    );
    expect(err?.details.argv_redacted).toEqual([
      "--config-file",
      "/path",
      "--auth",
      "***REDACTED***",
      "prompt-here",
    ]);
  });

  it("caps stdout_excerpt and stderr_excerpt at 2 KiB with a truncation marker", () => {
    const big = "x".repeat(3000);
    const err = classifyKimiResult(
      baseResult({ exitCode: 1, stdout: big, stderr: big }),
      baseCtx(),
    );
    expect(err?.details.stdout_excerpt.length).toBeLessThanOrEqual(3000);
    expect(err?.details.stdout_excerpt).toContain("[truncated: excerpt exceeded 2048 bytes]");
    expect(err?.details.stderr_excerpt).toContain("[truncated: excerpt exceeded 2048 bytes]");
  });

  it("does not truncate excerpts under the cap", () => {
    const small = "short";
    const err = classifyKimiResult(
      baseResult({ exitCode: 1, stderr: small }),
      baseCtx(),
    );
    expect(err?.details.stderr_excerpt).toBe(small);
  });

  it("ignores secrets shorter than 4 chars when redacting argv", () => {
    const err = classifyKimiResult(
      baseResult({ exitCode: 1 }),
      baseCtx({ argv: ["a", "longer-arg"], secrets: ["a"] }),
    );
    expect(err?.details.argv_redacted).toEqual(["a", "longer-arg"]);
  });
});
