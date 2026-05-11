import { describe, expect, it } from "vitest";
import {
  probeKimiVersion,
  type ProbeContext,
} from "../../src/adapter/cli-probe.js";
import type {
  SubprocessOptions,
  SubprocessResult,
} from "../../src/adapter/subprocess-runner.js";

function fakeSubprocess(result: Partial<SubprocessResult>): {
  fn: NonNullable<ProbeContext["_runSubprocess"]>;
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

function baseCtx(over: Partial<ProbeContext> = {}): ProbeContext {
  return {
    parentEnv: { PATH: "/usr/bin", HOME: "/Users/test" },
    pluginVersion: "0.0.1-test",
    ...over,
  };
}

describe("probeKimiVersion — happy path", () => {
  it("parses 'kimi, version 1.41.0' and matches the v1.41 compat entry", async () => {
    const { fn } = fakeSubprocess({ stdout: "kimi, version 1.41.0\n" });

    const probe = await probeKimiVersion(baseCtx({ _runSubprocess: fn }));

    expect(probe.ok).toBe(true);
    expect(probe.version).toBe("1.41.0");
    expect(probe.entry.id).toBe("v1.41");
    expect(probe.entry.supported).toBe(true);
    expect(probe.unsupported).toBe(false);
  });
});

describe("probeKimiVersion — unsupported versions", () => {
  it("unknown major.minor → fallback entry, unsupported=true, ok=false", async () => {
    const { fn } = fakeSubprocess({ stdout: "kimi, version 99.99.0\n" });

    const probe = await probeKimiVersion(baseCtx({ _runSubprocess: fn }));

    expect(probe.version).toBe("99.99.0");
    expect(probe.entry.supported).toBe(false);
    expect(probe.unsupported).toBe(true);
    expect(probe.ok).toBe(false);
  });

  it("stdout without a version line → version=null, unsupported=true", async () => {
    const { fn } = fakeSubprocess({ stdout: "garbage that doesn't match\n" });

    const probe = await probeKimiVersion(baseCtx({ _runSubprocess: fn }));

    expect(probe.version).toBeNull();
    expect(probe.unsupported).toBe(true);
    expect(probe.ok).toBe(false);
  });
});

describe("probeKimiVersion — errors", () => {
  it("ENOENT → ok=false, error.code='cli_not_found', entry is fallback", async () => {
    const enoentSpawn: NonNullable<ProbeContext["_runSubprocess"]> = async () => {
      const e: NodeJS.ErrnoException = Object.assign(new Error("spawn kimi ENOENT"), {
        code: "ENOENT",
      });
      throw e;
    };

    const probe = await probeKimiVersion(baseCtx({ _runSubprocess: enoentSpawn }));

    expect(probe.ok).toBe(false);
    expect(probe.error?.code).toBe("cli_not_found");
    expect(probe.unsupported).toBe(true);
    expect(probe.entry.supported).toBe(false);
  });

  it("nonzero exit → ok=false, version still parsed if present", async () => {
    const { fn } = fakeSubprocess({
      stdout: "kimi, version 1.41.0\n",
      exitCode: 2,
      stderr: "deprecation warning",
    });

    const probe = await probeKimiVersion(baseCtx({ _runSubprocess: fn }));

    expect(probe.ok).toBe(false);
    expect(probe.version).toBe("1.41.0");
  });
});

describe("probeKimiVersion — wiring", () => {
  it("uses argv ['--version'], 5s default timeout, sanitized env, ctx.binary override", async () => {
    const { fn, calls } = fakeSubprocess({ stdout: "kimi, version 1.41.0\n" });

    await probeKimiVersion(
      baseCtx({
        parentEnv: {
          PATH: "/usr/bin",
          HOME: "/Users/test",
          GITHUB_TOKEN: "ghp_LEAK",
        },
        pluginVersion: "1.2.3",
        binary: "/opt/kimi/bin/kimi",
        _runSubprocess: fn,
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("/opt/kimi/bin/kimi");
    expect(calls[0]!.argv).toEqual(["--version"]);
    expect(calls[0]!.timeoutMs).toBe(5000);
    expect(calls[0]!.env.KIMI_PLUGIN_VERSION).toBe("1.2.3");
    expect(calls[0]!.env.GITHUB_TOKEN).toBeUndefined();
  });

  it("honors a custom timeoutMs", async () => {
    const { fn, calls } = fakeSubprocess({ stdout: "kimi, version 1.41.0\n" });

    await probeKimiVersion(baseCtx({ _runSubprocess: fn }), 250);

    expect(calls[0]!.timeoutMs).toBe(250);
  });
});
