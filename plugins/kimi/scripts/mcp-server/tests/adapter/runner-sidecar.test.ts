import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runKimi, type RunKimiContext } from "../../src/adapter/runner.js";
import { listSidecars, readSidecar } from "../../src/adapter/state-sidecar.js";
import { sessionsDir } from "../../src/adapter/state-paths.js";
import type { SubprocessOptions, SubprocessResult } from "../../src/adapter/subprocess-runner.js";

const UUID = "12345678-1234-1234-1234-123456789abc";
const savedEnv = { ...process.env };
let tmp: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "kimi-runner-sidecar-")));
  process.env.KIMI_STATE_DIR = path.join(tmp, "root");
  delete process.env.CLAUDE_PLUGIN_DATA;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of ["KIMI_STATE_DIR", "CLAUDE_PLUGIN_DATA"]) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function fakeSub(result: Partial<SubprocessResult>): NonNullable<RunKimiContext["_runSubprocess"]> {
  return async (_opts: SubprocessOptions): Promise<SubprocessResult> => ({
    stdout: "",
    stderr: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    exitCode: 0,
    signal: null,
    durationMs: 7,
    truncated: { stdout: false, stderr: false },
    killedBy: "completed",
    ...result,
  });
}

function baseCtx(over: Partial<RunKimiContext> = {}): RunKimiContext {
  return {
    parentEnv: { PATH: "/usr/bin", HOME: "/Users/test" },
    pluginVersion: "0.3.0-test",
    pathConstraints: { allowEphemeral: true },
    ...over,
  };
}

describe("runKimi sidecar integration", () => {
  it("writes a sidecar when ctx.tool is set and a valid sessionId comes back", async () => {
    const stdout = `Hi.\n\nTo resume this session: kimi -r ${UUID}\n`;
    await runKimi(
      { prompt: "hi", outputFormat: "text", finalMessageOnly: true, timeoutSeconds: 5, workDir: tmp },
      baseCtx({ _runSubprocess: fakeSub({ stdout, stdoutBytes: stdout.length }), tool: "kimi_query" }),
    );
    const written = readSidecar(tmp, UUID);
    expect(written).not.toBeNull();
    expect(written?.tool).toBe("kimi_query");
    expect(written?.source).toBe("mcp");
    expect(written?.phase).toBe("completed");
    expect(written?.exit_code).toBe(0);
    expect(written?.plugin_version).toBe("0.3.0-test");
  });

  it("does NOT write a sidecar when ctx.tool is unset (backwards compatible)", async () => {
    const stdout = `Hi.\n\nTo resume this session: kimi -r ${UUID}\n`;
    await runKimi(
      { prompt: "hi", outputFormat: "text", finalMessageOnly: true, timeoutSeconds: 5, workDir: tmp },
      baseCtx({ _runSubprocess: fakeSub({ stdout, stdoutBytes: stdout.length }) }),
    );
    // sessions dir may not even exist
    expect(listSidecars(tmp)).toEqual([]);
  });

  it("does NOT write a sidecar when sessionId is null", async () => {
    await runKimi(
      { prompt: "hi", outputFormat: "text", finalMessageOnly: true, timeoutSeconds: 5, workDir: tmp },
      baseCtx({ _runSubprocess: fakeSub({ stdout: "no trailing marker\n" }), tool: "kimi_query" }),
    );
    expect(listSidecars(tmp)).toEqual([]);
  });

  it('marks phase "failed" when exit code is non-zero', async () => {
    const stdout = `Err.\n\nTo resume this session: kimi -r ${UUID}\n`;
    await runKimi(
      { prompt: "hi", outputFormat: "text", finalMessageOnly: true, timeoutSeconds: 5, workDir: tmp },
      baseCtx({
        _runSubprocess: fakeSub({ stdout, stdoutBytes: stdout.length, exitCode: 2 }),
        tool: "kimi_query",
      }),
    );
    expect(readSidecar(tmp, UUID)?.phase).toBe("failed");
  });

  it('marks phase "cancelled" when killedBy != "completed"', async () => {
    const stdout = `Cancelled.\n\nTo resume this session: kimi -r ${UUID}\n`;
    await runKimi(
      { prompt: "hi", outputFormat: "text", finalMessageOnly: true, timeoutSeconds: 5, workDir: tmp },
      baseCtx({
        _runSubprocess: fakeSub({
          stdout,
          stdoutBytes: stdout.length,
          exitCode: null,
          signal: "SIGTERM",
          killedBy: "timeout",
        }),
        tool: "kimi_query",
      }),
    );
    const w = readSidecar(tmp, UUID);
    expect(w?.phase).toBe("cancelled");
    expect(w?.killed_by).toBe("timeout");
  });

  it("sidecar write failure does NOT throw out of runKimi", async () => {
    // Point KIMI_STATE_DIR at a path that cannot be created
    process.env.KIMI_STATE_DIR = "/proc/forbidden-by-os";
    const stdout = `Hi.\n\nTo resume this session: kimi -r ${UUID}\n`;
    await expect(
      runKimi(
        { prompt: "hi", outputFormat: "text", finalMessageOnly: true, timeoutSeconds: 5, workDir: tmp },
        baseCtx({ _runSubprocess: fakeSub({ stdout, stdoutBytes: stdout.length }), tool: "kimi_query" }),
      ),
    ).resolves.toBeTruthy();
  });
});
