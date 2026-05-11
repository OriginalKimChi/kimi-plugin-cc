import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetDriftState, recordDriftEvent, getDriftState } from "../../src/adapter/drift-counter.js";

beforeEach(() => {
  resetDriftState();
});
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
    pluginVersion: "0.1.0",
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
    expect(payload.version).toBe("0.1.0");
    expect(payload.state).toBe("ok");
    expect(payload.node).toBe(process.version);
    expect(payload.plugin_root).toBe("/opt/plugin");
    expect(payload.auth.state).toBe("env");
    expect(payload.auth.source).toBe("kimi_code");
    expect(payload.auth.kimi_code_api_key_present).toBe(true);
    expect(payload.auth.moonshot_api_key_present).toBe(false);
    expect(payload.auth.preferred).toBe("kimi_code");
    expect(payload.auth.remediation).toBeNull();
    expect(payload.cli.binary).toBe("kimi");
    expect(payload.cli.version).toBe("1.41.0");
    expect(payload.cli.compat_entry).toBe("v1.41");
    expect(payload.cli.supported).toBe(true);
    expect(payload.cli.unsupported).toBe(false);
    expect(payload.cli.shape_drift).toEqual({
      count: expect.any(Number),
      active: expect.any(Boolean),
      recent_kinds: expect.any(Array),
    });
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
    expect(payload.auth.source).toBe("moonshot");
    expect(payload.auth.kimi_code_api_key_present).toBe(false);
    expect(payload.auth.moonshot_api_key_present).toBe(true);
  });

  it("no env keys + missing auth → remediation hints kimi login", async () => {
    const payload = await runStatusTool(
      baseCtx({ parentEnv: { PATH: "/usr/bin" /* no HOME, no keys */ } }),
    );
    expect(payload.auth.state).toBe("missing");
    expect(payload.auth.remediation).toMatch(/kimi login/);
  });
});

describe("runStatusTool — auth state from filesystem", () => {
  let HOME_RAW: string;
  let HOME: string;

  beforeAll(() => {
    HOME_RAW = mkdtempSync(path.join(os.tmpdir(), "kimi-status-home-"));
    HOME = HOME_RAW;
  });

  afterAll(() => {
    rmSync(HOME_RAW, { recursive: true, force: true });
  });

  it("OAuth credentials file (no env) → auth.state='oauth', overall state='ok'", async () => {
    mkdirSync(path.join(HOME, ".kimi", "credentials"), { recursive: true });
    writeFileSync(
      path.join(HOME, ".kimi", "credentials", "kimi-code.json"),
      JSON.stringify({ access_token: "stub" }),
    );

    const payload = await runStatusTool(baseCtx({ parentEnv: { HOME } }));

    expect(payload.auth.state).toBe("oauth");
    expect(payload.auth.kimi_code_api_key_present).toBe(false);
    expect(payload.auth.preferred).toBe("none"); // preferred reflects env presence
    expect(payload.state).toBe("ok"); // OAuth on disk is sufficient
    expect(payload.auth.remediation).toBeNull();
  });

  it("drift events surface via cli.shape_drift (active=true after threshold)", async () => {
    recordDriftEvent("missing_trailing_marker");
    recordDriftEvent("missing_trailing_marker");
    recordDriftEvent("stream_json_malformed");
    expect(getDriftState().active).toBe(true);

    const payload = await runStatusTool(baseCtx());
    expect(payload.cli.shape_drift.count).toBe(3);
    expect(payload.cli.shape_drift.active).toBe(true);
    expect(payload.cli.shape_drift.recent_kinds).toContain("missing_trailing_marker");
    expect(payload.cli.shape_drift.recent_kinds).toContain("stream_json_malformed");
  });

  it("config.toml api_key non-empty → auth.state='config_file'", async () => {
    rmSync(path.join(HOME, ".kimi"), { recursive: true, force: true });
    mkdirSync(path.join(HOME, ".kimi"), { recursive: true });
    writeFileSync(
      path.join(HOME, ".kimi", "config.toml"),
      [
        '[providers."managed:kimi-code"]',
        'api_key = "sk-cf-xxxx"',
        "",
      ].join("\n"),
    );

    const payload = await runStatusTool(baseCtx({ parentEnv: { HOME } }));

    expect(payload.auth.state).toBe("config_file");
    expect(payload.state).toBe("ok");
  });
});
