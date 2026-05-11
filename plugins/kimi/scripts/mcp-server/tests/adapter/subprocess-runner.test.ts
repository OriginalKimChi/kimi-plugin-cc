import { describe, expect, it } from "vitest";
import { runSubprocess } from "../../src/adapter/subprocess-runner.js";

function nodeBin(): string {
  return process.execPath;
}

describe("runSubprocess — happy path", () => {
  it("passes only the supplied env to the child (no inherit)", async () => {
    process.env.PARENT_ONLY_TOKEN_FOR_TEST = "should-not-leak";
    try {
      const script = `process.stdout.write(JSON.stringify(process.env));`;
      const result = await runSubprocess({
        command: nodeBin(),
        argv: ["-e", script],
        env: { PATH: process.env.PATH ?? "", KIMI_PLUGIN_VERSION: "0.0.1-test" },
        timeoutMs: 5000,
      });

      expect(result.exitCode).toBe(0);
      const childEnv = JSON.parse(result.stdout) as Record<string, string>;
      expect(childEnv.PARENT_ONLY_TOKEN_FOR_TEST).toBeUndefined();
      expect(childEnv.KIMI_PLUGIN_VERSION).toBe("0.0.1-test");
    } finally {
      delete process.env.PARENT_ONLY_TOKEN_FOR_TEST;
    }
  });

  it("captures stdout and exits cleanly", async () => {
    const payload = "hello\nworld\n";
    const script = `process.stdout.write(${JSON.stringify(payload)});`;

    const result = await runSubprocess({
      command: nodeBin(),
      argv: ["-e", script],
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 5000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.killedBy).toBe("completed");
    expect(result.stdout).toBe(payload);
    expect(result.stderr).toBe("");
    expect(result.stdoutBytes).toBe(Buffer.byteLength(payload, "utf8"));
    expect(result.stderrBytes).toBe(0);
    expect(result.truncated).toEqual({ stdout: false, stderr: false });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("propagates non-zero exit code and captures stderr separately", async () => {
    const script = `
      process.stderr.write("oh no\\n");
      process.exit(7);
    `;
    const result = await runSubprocess({
      command: nodeBin(),
      argv: ["-e", script],
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 5000,
    });

    expect(result.exitCode).toBe(7);
    expect(result.signal).toBeNull();
    expect(result.killedBy).toBe("completed");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("oh no\n");
    expect(result.stderrBytes).toBe(Buffer.byteLength("oh no\n", "utf8"));
    expect(result.truncated).toEqual({ stdout: false, stderr: false });
  });
});

describe("runSubprocess — output caps", () => {
  it("truncates stdout once cap is exceeded and kills the child", async () => {
    // Child writes 200KB in 100B chunks and never exits on its own.
    const script = `
      const chunk = "x".repeat(100);
      let written = 0;
      const id = setInterval(() => {
        if (written >= 200_000) { clearInterval(id); return; }
        process.stdout.write(chunk);
        written += chunk.length;
      }, 1);
      setInterval(() => {}, 1000); // keep alive
    `;

    const cap = 1024;
    const result = await runSubprocess({
      command: nodeBin(),
      argv: ["-e", script],
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 10_000,
      stdoutCapBytes: cap,
    });

    expect(result.killedBy).toBe("stdout_cap");
    expect(result.truncated.stdout).toBe(true);
    expect(result.truncated.stderr).toBe(false);
    expect(result.stdoutBytes).toBeLessThanOrEqual(cap);
    expect(result.stdout).toContain("[truncated: stdout exceeded");
    expect(result.signal).not.toBeNull();
  });

  it("truncates stderr once cap is exceeded and kills the child", async () => {
    const script = `
      const chunk = "e".repeat(100);
      let written = 0;
      const id = setInterval(() => {
        if (written >= 200_000) { clearInterval(id); return; }
        process.stderr.write(chunk);
        written += chunk.length;
      }, 1);
      setInterval(() => {}, 1000);
    `;

    const cap = 1024;
    const result = await runSubprocess({
      command: nodeBin(),
      argv: ["-e", script],
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 10_000,
      stderrCapBytes: cap,
    });

    expect(result.killedBy).toBe("stderr_cap");
    expect(result.truncated.stderr).toBe(true);
    expect(result.truncated.stdout).toBe(false);
    expect(result.stderrBytes).toBeLessThanOrEqual(cap);
    expect(result.stderr).toContain("[truncated: stderr exceeded");
  });
});

describe("runSubprocess — timeout + kill ladder", () => {
  it("kills with SIGTERM when timeout elapses, killedBy='timeout'", async () => {
    const script = `setInterval(() => {}, 1000);`; // hang forever

    const result = await runSubprocess({
      command: nodeBin(),
      argv: ["-e", script],
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 200,
    });

    expect(result.killedBy).toBe("timeout");
    expect(result.signal).toBe("SIGTERM");
    expect(result.durationMs).toBeGreaterThanOrEqual(200);
    expect(result.durationMs).toBeLessThan(3000);
  });

  it("escalates to SIGKILL when the child ignores SIGTERM and SIGINT", async () => {
    // Child traps SIGTERM and SIGINT then never exits. Only SIGKILL stops it.
    const script = `
      process.on("SIGTERM", () => {});
      process.on("SIGINT", () => {});
      setInterval(() => {}, 1000);
    `;

    const result = await runSubprocess({
      command: nodeBin(),
      argv: ["-e", script],
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 150,
      _killLadderMs: { sigint: 100, sigkill: 200, abandon: 400 },
    });

    expect(result.killedBy).toBe("timeout");
    expect(result.signal).toBe("SIGKILL");
    expect(result.durationMs).toBeGreaterThanOrEqual(150 + 200);
    expect(result.durationMs).toBeLessThan(3000);
  });
});
