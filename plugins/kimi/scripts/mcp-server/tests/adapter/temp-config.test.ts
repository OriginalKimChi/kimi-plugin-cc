import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TEMP_CONFIG_PREFIX,
  cleanupOrphanedTempConfigs,
  writeTempConfig,
} from "../../src/adapter/temp-config.js";

describe("writeTempConfig", () => {
  it("writes a 0600 TOML file under os.tmpdir() with the api_key embedded", async () => {
    const out = writeTempConfig({
      apiKey: "sk-kc-EXAMPLE-1234",
      source: "kimi_code",
    });
    try {
      expect(path.dirname(out.filePath)).toBe(os.tmpdir());
      expect(path.basename(out.filePath).startsWith(TEMP_CONFIG_PREFIX)).toBe(true);
      expect(out.filePath.endsWith(".toml")).toBe(true);

      const st = statSync(out.filePath);
      // file is regular and 0600 (owner rw, no group/other access)
      const mode = st.mode & 0o777;
      expect(mode).toBe(0o600);

      const content = readFileSync(out.filePath, "utf8");
      expect(content).toContain('[providers."managed:kimi-code"]');
      expect(content).toContain('api_key = "sk-kc-EXAMPLE-1234"');
    } finally {
      await out.cleanup();
    }
  });

  it("cleanup() unlinks the file and is idempotent", async () => {
    const out = writeTempConfig({ apiKey: "sk-kc-XYZ-9999", source: "kimi_code" });
    expect(statSync(out.filePath).isFile()).toBe(true);
    await out.cleanup();
    expect(() => statSync(out.filePath)).toThrow();
    // second call should not throw
    await expect(out.cleanup()).resolves.toBeDefined();
  });

  it("rejects an api_key containing NUL or newline (no injection)", () => {
    const nul = String.fromCharCode(0);
    expect(() =>
      writeTempConfig({ apiKey: `bad${nul}value`, source: "kimi_code" }),
    ).toThrow(/NUL|newline/i);
    expect(() =>
      writeTempConfig({ apiKey: "line1\nline2", source: "kimi_code" }),
    ).toThrow(/NUL|newline/i);
  });

  it("uses the Moonshot provider stanza when source='moonshot'", async () => {
    const out = writeTempConfig({ apiKey: "sk-ms-EXAMPLE", source: "moonshot" });
    try {
      const content = readFileSync(out.filePath, "utf8");
      expect(content).toContain('[providers."moonshot"]');
      expect(content).toContain('api_key = "sk-ms-EXAMPLE"');
    } finally {
      await out.cleanup();
    }
  });

  it("never writes inside ~/.kimi/", () => {
    const out = writeTempConfig({ apiKey: "sk-kc-EXAMPLE", source: "kimi_code" });
    try {
      expect(out.filePath).not.toContain(path.join(os.homedir(), ".kimi"));
    } finally {
      void out.cleanup();
    }
  });
});

describe("cleanupOrphanedTempConfigs", () => {
  let SCRATCH_RAW: string;
  let SCRATCH: string;

  beforeAll(() => {
    SCRATCH_RAW = mkdtempSync(path.join(os.tmpdir(), "kimi-orphan-test-"));
    SCRATCH = SCRATCH_RAW;
  });
  afterAll(() => {
    rmSync(SCRATCH_RAW, { recursive: true, force: true });
  });

  it("deletes files matching kimi-plugin-*.toml older than maxAgeMs in a target dir", async () => {
    const old = path.join(SCRATCH, "kimi-plugin-old.toml");
    const fresh = path.join(SCRATCH, "kimi-plugin-fresh.toml");
    const other = path.join(SCRATCH, "unrelated.txt");
    writeFileSync(old, "x", { mode: 0o600 });
    writeFileSync(fresh, "x", { mode: 0o600 });
    writeFileSync(other, "x");

    // Backdate the "old" file by 2 minutes.
    const now = Date.now();
    const backdated = new Date(now - 2 * 60 * 1000);
    require("node:fs").utimesSync(old, backdated, backdated);

    const result = await cleanupOrphanedTempConfigs({
      maxAgeMs: 60_000,
      dir: SCRATCH,
    });

    expect(result.removed).toContain(old);
    expect(result.removed).not.toContain(fresh);
    expect(result.removed).not.toContain(other);
    expect(readdirSync(SCRATCH)).toContain("kimi-plugin-fresh.toml");
    expect(readdirSync(SCRATCH)).toContain("unrelated.txt");
    expect(readdirSync(SCRATCH)).not.toContain("kimi-plugin-old.toml");
  });
});
