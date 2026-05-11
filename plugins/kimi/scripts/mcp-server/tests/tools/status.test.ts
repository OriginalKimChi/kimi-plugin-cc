import { describe, expect, it } from "vitest";
import {
  runStatusTool,
  type StatusContext,
} from "../../src/tools/status.js";
import type { CliProbeResult } from "../../src/adapter/cli-probe.js";
import { KimiError } from "../../src/adapter/errors.js";

function fakeProbe(over: Partial<CliProbeResult> = {}): CliProbeResult {
  return {
    ok: true,
    version: "1.41.0",
    rawStdout: "kimi, version 1.41.0\n",
    rawStderr: "",
    entry: {
      id: "v1.41",
      matchMajorMinor: { major: 1, minor: 41 },
      supported: true,
      trailingSessionLine: /placeholder/,
    },
    unsupported: false,
    ...over,
  };
}

function baseCtx(over: Partial<StatusContext> = {}): StatusContext {
  return {
    parentEnv: { KIMI_CODE_API_KEY: "sk-kc-OK" },
    pluginVersion: "0.0.1",
    pluginRoot: "/opt/plugin",
    binary: "kimi",
    _probe: async () => fakeProbe(),
    ...over,
  };
}

describe("runStatusTool — happy path", () => {
  it("returns plugin + auth + cli sections with state='ok'", async () => {
    const payload = await runStatusTool(baseCtx());

    expect(payload.plugin).toBe("kimi");
    expect(payload.version).toBe("0.0.1");
    expect(payload.state).toBe("ok");
    expect(payload.node).toBe(process.version);
    expect(payload.plugin_root).toBe("/opt/plugin");
    expect(payload.auth.kimi_code_api_key_present).toBe(true);
    expect(payload.auth.moonshot_api_key_present).toBe(false);
    expect(payload.auth.preferred).toBe("kimi_code");
    expect(payload.cli.binary).toBe("kimi");
    expect(payload.cli.version).toBe("1.41.0");
    expect(payload.cli.compat_entry).toBe("v1.41");
    expect(payload.cli.supported).toBe(true);
    expect(payload.cli.unsupported).toBe(false);
    expect(payload.cli.error).toBeNull();
  });
});

describe("runStatusTool — state derivation", () => {
  it("no auth at all → state='missing'", async () => {
    const payload = await runStatusTool(baseCtx({ parentEnv: { PATH: "/usr/bin" } }));
    expect(payload.state).toBe("missing");
    expect(payload.auth.preferred).toBe("none");
  });

  it("cli_not_found → state='missing' regardless of auth", async () => {
    const payload = await runStatusTool(
      baseCtx({
        _probe: async () => ({
          ok: false,
          version: null,
          rawStdout: "",
          rawStderr: "",
          entry: fakeProbe().entry, // shape doesn't matter
          unsupported: true,
          error: new KimiError("cli_not_found", "ENOENT", {
            stdout_excerpt: "",
            stderr_excerpt: "",
            argv_redacted: ["--version"],
            duration_ms: 0,
          }),
        }),
      }),
    );
    expect(payload.state).toBe("missing");
    expect(payload.cli.error?.code).toBe("cli_not_found");
  });

  it("unsupported cli version → state='degraded'", async () => {
    const payload = await runStatusTool(
      baseCtx({
        _probe: async () =>
          fakeProbe({
            ok: false,
            version: "99.99.0",
            entry: {
              id: "v1.41",
              matchMajorMinor: { major: 1, minor: 41 },
              supported: false,
              trailingSessionLine: /placeholder/,
            },
            unsupported: true,
          }),
      }),
    );
    expect(payload.state).toBe("degraded");
    expect(payload.cli.compat_entry).toBeNull();
    expect(payload.cli.supported).toBe(false);
    expect(payload.cli.unsupported).toBe(true);
  });

  it("version=null (garbage stdout) → state='degraded'", async () => {
    const payload = await runStatusTool(
      baseCtx({
        _probe: async () =>
          fakeProbe({
            ok: false,
            version: null,
            entry: {
              id: "v1.41",
              matchMajorMinor: { major: 1, minor: 41 },
              supported: false,
              trailingSessionLine: /placeholder/,
            },
            unsupported: true,
          }),
      }),
    );
    expect(payload.state).toBe("degraded");
    expect(payload.cli.version).toBeNull();
  });

  it("moonshot-only auth surfaces preferred='moonshot' and state='ok'", async () => {
    const payload = await runStatusTool(
      baseCtx({ parentEnv: { MOONSHOT_API_KEY: "sk-ms-OK" } }),
    );
    expect(payload.state).toBe("ok");
    expect(payload.auth.preferred).toBe("moonshot");
    expect(payload.auth.kimi_code_api_key_present).toBe(false);
    expect(payload.auth.moonshot_api_key_present).toBe(true);
  });
});
