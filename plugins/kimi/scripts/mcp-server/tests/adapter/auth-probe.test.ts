import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeAuth, type AuthState } from "../../src/adapter/auth-probe.js";

let HOME_RAW: string;
let HOME: string;

beforeAll(() => {
  HOME_RAW = mkdtempSync(path.join(os.tmpdir(), "kimi-auth-"));
  HOME = HOME_RAW;
});

afterAll(() => {
  rmSync(HOME_RAW, { recursive: true, force: true });
});

function writeConfigToml(content: string) {
  mkdirSync(path.join(HOME, ".kimi"), { recursive: true });
  writeFileSync(path.join(HOME, ".kimi", "config.toml"), content);
}

function writeOauthCredentials() {
  mkdirSync(path.join(HOME, ".kimi", "credentials"), { recursive: true });
  writeFileSync(
    path.join(HOME, ".kimi", "credentials", "kimi-code.json"),
    JSON.stringify({ access_token: "stub" }),
  );
}

function clear() {
  rmSync(path.join(HOME, ".kimi"), { recursive: true, force: true });
}

describe("probeAuth", () => {
  it("env path: KIMI_CODE_API_KEY present → state='env', source='kimi_code'", () => {
    clear();
    const r = probeAuth({
      env: { KIMI_CODE_API_KEY: "sk-kc-x" },
      home: HOME,
    });
    expect(r.state).toBe<AuthState>("env");
    expect(r.source).toBe("kimi_code");
  });

  it("env path: only MOONSHOT_API_KEY → state='env', source='moonshot'", () => {
    clear();
    const r = probeAuth({
      env: { MOONSHOT_API_KEY: "sk-ms-y" },
      home: HOME,
    });
    expect(r.state).toBe<AuthState>("env");
    expect(r.source).toBe("moonshot");
  });

  it("oauth path: ~/.kimi/credentials/kimi-code.json exists → state='oauth'", () => {
    clear();
    writeOauthCredentials();
    const r = probeAuth({ env: {}, home: HOME });
    expect(r.state).toBe<AuthState>("oauth");
  });

  it("config_file path: api_key in managed:kimi-code section is non-empty → state='config_file'", () => {
    clear();
    writeConfigToml(
      [
        '[providers."managed:kimi-code"]',
        'base_url = "https://api.kimi.com/coding/v1"',
        'api_key = "sk-cf-zzzz"',
        "",
      ].join("\n"),
    );
    const r = probeAuth({ env: {}, home: HOME });
    expect(r.state).toBe<AuthState>("config_file");
  });

  it("missing: empty api_key + no OAuth → state='missing'", () => {
    clear();
    writeConfigToml(
      [
        '[providers."managed:kimi-code"]',
        'api_key = ""',
        "",
        '[providers."managed:kimi-code".oauth]',
        'token_url = "https://..."',
        "",
      ].join("\n"),
    );
    const r = probeAuth({ env: {}, home: HOME });
    expect(r.state).toBe<AuthState>("missing");
  });

  it("missing: no ~/.kimi/ at all → state='missing'", () => {
    clear();
    const r = probeAuth({ env: {}, home: HOME });
    expect(r.state).toBe<AuthState>("missing");
  });

  it("env takes precedence over oauth", () => {
    clear();
    writeOauthCredentials();
    const r = probeAuth({
      env: { KIMI_CODE_API_KEY: "sk-kc-x" },
      home: HOME,
    });
    expect(r.state).toBe<AuthState>("env");
  });

  it("oauth takes precedence over config_file", () => {
    clear();
    writeOauthCredentials();
    writeConfigToml(
      [
        '[providers."managed:kimi-code"]',
        'api_key = "sk-cf-zzzz"',
        "",
      ].join("\n"),
    );
    const r = probeAuth({ env: {}, home: HOME });
    expect(r.state).toBe<AuthState>("oauth");
  });

  it("ignores api_key under a non-managed section", () => {
    clear();
    writeConfigToml(
      [
        '[providers."someone-else"]',
        'api_key = "sk-noise"',
        "",
        '[providers."managed:kimi-code"]',
        'api_key = ""',
        "",
      ].join("\n"),
    );
    const r = probeAuth({ env: {}, home: HOME });
    expect(r.state).toBe<AuthState>("missing");
  });
});
