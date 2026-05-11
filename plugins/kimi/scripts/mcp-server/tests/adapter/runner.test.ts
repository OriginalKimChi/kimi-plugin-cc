import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PathValidationError } from "../../src/adapter/path-validator.js";
import { runKimi, type RunKimiContext } from "../../src/adapter/runner.js";
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
    parentEnv: { PATH: "/usr/bin", HOME: "/Users/test" },
    pluginVersion: "0.0.1-test",
    ...over,
  };
}

describe("runKimi — text mode", () => {
  it("parses sessionId and finalMessage from stdout", async () => {
    const stdout = `Hello from kimi.\n\nTo resume this session: kimi -r ${UUID}\n`;
    const { fn } = fakeSubprocess({ stdout, stdoutBytes: stdout.length });

    const result = await runKimi(
      { prompt: "hi", outputFormat: "text", finalMessageOnly: true, timeoutSeconds: 5 },
      baseCtx({ _runSubprocess: fn }),
    );

    expect(result.sessionId).toBe(UUID);
    expect(result.finalMessage).toBe("Hello from kimi.");
    expect(result.exitCode).toBe(0);
    expect(result.killedBy).toBe("completed");
    expect(result.trailingMarkerMissing).toBe(false);
    expect(result.rawEvents).toBeUndefined();
  });

  it("builds argv via buildArgv and passes binary='kimi' + sanitized env", async () => {
    const workRaw = mkdtempSync(path.join(os.tmpdir(), "kimi-runner-work-"));
    const work = realpathSync(workRaw);
    try {
      const { fn, calls } = fakeSubprocess({ stdout: "ok\n" });

      await runKimi(
        {
          prompt: "describe this repo",
          outputFormat: "text",
          finalMessageOnly: false,
          model: "kimi-mocha",
          workDir: work,
          timeoutSeconds: 12,
        },
        baseCtx({
          parentEnv: {
            PATH: "/usr/bin",
            HOME: "/Users/test",
            GITHUB_TOKEN: "ghp_LEAK",
            KIMI_CODE_API_KEY: "sk-kc-OK",
          },
          pluginVersion: "1.2.3",
          pathConstraints: { allowEphemeral: true },
          _runSubprocess: fn,
        }),
      );

      expect(calls).toHaveLength(1);
      const opts = calls[0]!;
      expect(opts.command).toBe("kimi");
      expect(opts.argv).toEqual([
        "--print",
        "--output-format",
        "text",
        "--work-dir",
        work,
        "-m",
        "kimi-mocha",
        "describe this repo",
      ]);
      expect(opts.env.KIMI_PLUGIN_VERSION).toBe("1.2.3");
      expect(opts.env.KIMI_CODE_API_KEY).toBe("sk-kc-OK");
      expect(opts.env.GITHUB_TOKEN).toBeUndefined();
      expect(opts.timeoutMs).toBe(12_000);
    } finally {
      rmSync(workRaw, { recursive: true, force: true });
    }
  });

  it("honors ctx.binary override (for tests / packaging)", async () => {
    const { fn, calls } = fakeSubprocess({ stdout: "" });

    await runKimi(
      { prompt: "x", outputFormat: "text", finalMessageOnly: true, timeoutSeconds: 1 },
      baseCtx({ binary: "/opt/kimi/bin/kimi", _runSubprocess: fn }),
    );

    expect(calls[0]!.command).toBe("/opt/kimi/bin/kimi");
  });

  it("forwards inv.cwd as the subprocess cwd (for kimi_implement worktree)", async () => {
    const { fn, calls } = fakeSubprocess({ stdout: "" });

    await runKimi(
      {
        prompt: "x",
        outputFormat: "text",
        finalMessageOnly: true,
        timeoutSeconds: 1,
        cwd: "/some/abs/worktree",
      },
      baseCtx({ _runSubprocess: fn }),
    );

    expect(calls[0]!.cwd).toBe("/some/abs/worktree");
  });
});

describe("runKimi — stream-json mode", () => {
  it("populates rawEvents and picks finalMessage from last assistant event", async () => {
    const lines = [
      `{"role":"user","content":"hi"}`,
      `{"role":"assistant","content":"partial"}`,
      `{"role":"tool","content":"trace"}`,
      `{"role":"assistant","content":"final answer"}`,
      `To resume this session: kimi -r ${UUID}`,
      ``,
    ];
    const stdout = lines.join("\n");
    const { fn } = fakeSubprocess({ stdout });

    const result = await runKimi(
      { prompt: "q", outputFormat: "stream-json", timeoutSeconds: 5 },
      baseCtx({ _runSubprocess: fn }),
    );

    expect(result.sessionId).toBe(UUID);
    expect(result.finalMessage).toBe("final answer");
    expect(result.rawEvents).toHaveLength(4);
    expect(result.rawEvents?.[3]).toEqual({ role: "assistant", content: "final answer" });
    expect(result.trailingMarkerMissing).toBe(false);
  });
});

describe("runKimi — scrub + redact", () => {
  it("strips ANSI sequences from finalMessage", async () => {
    const stdout = `\x1b[31mred\x1b[0m text\n\nTo resume this session: kimi -r ${UUID}\n`;
    const { fn } = fakeSubprocess({ stdout });

    const result = await runKimi(
      { prompt: "x", outputFormat: "text", finalMessageOnly: true, timeoutSeconds: 1 },
      baseCtx({ _runSubprocess: fn }),
    );

    expect(result.finalMessage).toBe("red text");
  });

  it("redacts KIMI_CODE_API_KEY value if it appears in stderr", async () => {
    const apiKey = "sk-kc-VERY-SECRET-VALUE-1234";
    const stderr = `auth=Bearer ${apiKey}\nother log line\n`;
    const { fn } = fakeSubprocess({ stderr });

    const result = await runKimi(
      { prompt: "x", outputFormat: "text", finalMessageOnly: true, timeoutSeconds: 1 },
      baseCtx({
        parentEnv: { PATH: "/usr/bin", KIMI_CODE_API_KEY: apiKey },
        _runSubprocess: fn,
      }),
    );

    expect(result.stderr).toBe("auth=Bearer ***REDACTED***\nother log line\n");
    expect(result.stderr).not.toContain(apiKey);
  });
});

describe("runKimi — subprocess field propagation", () => {
  it("surfaces killedBy, truncated, byte counts, durationMs from subprocess", async () => {
    const { fn } = fakeSubprocess({
      stdout: "partial output\n",
      stdoutBytes: 4_194_304,
      stderrBytes: 42,
      durationMs: 12_345,
      killedBy: "stdout_cap",
      truncated: { stdout: true, stderr: false },
      signal: "SIGTERM",
      exitCode: null,
    });

    const result = await runKimi(
      { prompt: "x", outputFormat: "text", finalMessageOnly: true, timeoutSeconds: 5 },
      baseCtx({ _runSubprocess: fn }),
    );

    expect(result.killedBy).toBe("stdout_cap");
    expect(result.truncated).toEqual({ stdout: true, stderr: false });
    expect(result.stdoutBytes).toBe(4_194_304);
    expect(result.stderrBytes).toBe(42);
    expect(result.durationMs).toBe(12_345);
    expect(result.signal).toBe("SIGTERM");
    expect(result.exitCode).toBeNull();
  });

  it("enforces 4 MB stdout / 1 MB stderr caps per P0-D policy", async () => {
    const { fn, calls } = fakeSubprocess({});

    await runKimi(
      { prompt: "x", outputFormat: "text", finalMessageOnly: true, timeoutSeconds: 1 },
      baseCtx({ _runSubprocess: fn }),
    );

    expect(calls[0]!.stdoutCapBytes).toBe(4 * 1024 * 1024);
    expect(calls[0]!.stderrCapBytes).toBe(1 * 1024 * 1024);
  });
});

describe("runKimi — path validation", () => {
  let TMP_RAW: string;
  let TMP: string;

  beforeAll(() => {
    TMP_RAW = mkdtempSync(path.join(os.tmpdir(), "kimi-runner-paths-"));
    TMP = realpathSync(TMP_RAW);
  });

  afterAll(() => {
    rmSync(TMP_RAW, { recursive: true, force: true });
  });

  it("resolves symlinked workDir and passes the resolved path into argv", async () => {
    const real = path.join(TMP, "real-work");
    const link = path.join(TMP, "link-work");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);
    const { fn, calls } = fakeSubprocess({});

    await runKimi(
      {
        prompt: "x",
        outputFormat: "text",
        finalMessageOnly: true,
        workDir: link,
        timeoutSeconds: 1,
      },
      baseCtx({
        _runSubprocess: fn,
        pathConstraints: { allowEphemeral: true },
      }),
    );

    expect(calls[0]!.argv).toContain("--work-dir");
    const idx = calls[0]!.argv.indexOf("--work-dir");
    expect(calls[0]!.argv[idx + 1]).toBe(real);
    expect(calls[0]!.argv).not.toContain(link);
  });

  it("rejects relative workDir without spawning", async () => {
    const { fn, calls } = fakeSubprocess({});

    await expect(
      runKimi(
        {
          prompt: "x",
          outputFormat: "text",
          finalMessageOnly: true,
          workDir: "relative/dir",
          timeoutSeconds: 1,
        },
        baseCtx({ _runSubprocess: fn }),
      ),
    ).rejects.toBeInstanceOf(PathValidationError);
    expect(calls).toHaveLength(0);
  });

  it("validates each addDirs entry and rejects non-existent ones", async () => {
    const good = path.join(TMP, "ok-add");
    mkdirSync(good, { recursive: true });
    const missing = path.join(TMP, "no-such");
    const { fn, calls } = fakeSubprocess({});

    await expect(
      runKimi(
        {
          prompt: "x",
          outputFormat: "text",
          finalMessageOnly: true,
          addDirs: [good, missing],
          timeoutSeconds: 1,
        },
        baseCtx({
          _runSubprocess: fn,
          pathConstraints: { allowEphemeral: true },
        }),
      ),
    ).rejects.toMatchObject({
      name: "PathValidationError",
      code: "not_found",
      field: "addDirs[1]",
    });
    expect(calls).toHaveLength(0);
  });

  it("validates configFile when provided", async () => {
    const { fn, calls } = fakeSubprocess({});

    await expect(
      runKimi(
        {
          prompt: "x",
          outputFormat: "text",
          finalMessageOnly: true,
          configFile: "/nope/missing/config.toml",
          timeoutSeconds: 1,
        },
        baseCtx({
          _runSubprocess: fn,
          pathConstraints: { allowEphemeral: true },
        }),
      ),
    ).rejects.toMatchObject({
      name: "PathValidationError",
      field: "configFile",
    });
    expect(calls).toHaveLength(0);
  });

  it("rechecks paths just before spawn and aborts on TOCTOU drift", async () => {
    const work = path.join(TMP, "toctou-work");
    mkdirSync(work, { recursive: true });
    const { fn, calls } = fakeSubprocess({});

    await expect(
      runKimi(
        {
          prompt: "x",
          outputFormat: "text",
          finalMessageOnly: true,
          workDir: work,
          timeoutSeconds: 1,
        },
        baseCtx({
          _runSubprocess: fn,
          pathConstraints: { allowEphemeral: true },
          _afterValidate: () => {
            rmSync(work, { recursive: true, force: true });
          },
        }),
      ),
    ).rejects.toMatchObject({
      name: "PathValidationError",
      code: "toctou",
      field: "workDir",
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects workDir under an ephemeral root by default", async () => {
    const work = path.join(TMP, "ephemeral-default");
    mkdirSync(work, { recursive: true });
    const { fn, calls } = fakeSubprocess({});

    await expect(
      runKimi(
        {
          prompt: "x",
          outputFormat: "text",
          finalMessageOnly: true,
          workDir: work,
          timeoutSeconds: 1,
        },
        baseCtx({ _runSubprocess: fn }), // no pathConstraints → allowEphemeral defaults to false
      ),
    ).rejects.toMatchObject({
      name: "PathValidationError",
      code: "ephemeral_root",
      field: "workDir",
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects workDir outside ctx.pathConstraints.allowedRoots", async () => {
    const allowedRaw = mkdtempSync(path.join(os.tmpdir(), "kimi-allowed-"));
    const otherRaw = mkdtempSync(path.join(os.tmpdir(), "kimi-other-"));
    const allowed = realpathSync(allowedRaw);
    const other = realpathSync(otherRaw);
    const { fn, calls } = fakeSubprocess({});

    try {
      await expect(
        runKimi(
          {
            prompt: "x",
            outputFormat: "text",
            finalMessageOnly: true,
            workDir: other,
            timeoutSeconds: 1,
          },
          baseCtx({
            _runSubprocess: fn,
            pathConstraints: { allowedRoots: [allowed], allowEphemeral: true },
          }),
        ),
      ).rejects.toMatchObject({
        name: "PathValidationError",
        code: "outside_root",
        field: "workDir",
      });
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(allowedRaw, { recursive: true, force: true });
      rmSync(otherRaw, { recursive: true, force: true });
    }
  });
});
