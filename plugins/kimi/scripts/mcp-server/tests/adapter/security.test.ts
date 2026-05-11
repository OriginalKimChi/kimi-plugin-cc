import { describe, expect, it } from "vitest";
import {
  buildSubprocessEnv,
  scrubControlChars,
  redactSecrets,
} from "../../src/adapter/security.js";

describe("buildSubprocessEnv", () => {
  it("forwards PATH and HOME from parent", () => {
    const out = buildSubprocessEnv({
      parentEnv: { PATH: "/u/bin:/bin", HOME: "/Users/x" },
      pluginVersion: "0.0.1",
    });
    expect(out.PATH).toBe("/u/bin:/bin");
    expect(out.HOME).toBe("/Users/x");
  });

  it("forwards LANG / LC_ALL when present", () => {
    const out = buildSubprocessEnv({
      parentEnv: { LANG: "en_US.UTF-8", LC_ALL: "ko_KR.UTF-8" },
      pluginVersion: "0.0.1",
    });
    expect(out.LANG).toBe("en_US.UTF-8");
    expect(out.LC_ALL).toBe("ko_KR.UTF-8");
  });

  it("falls back to default PATH and LANG when not present", () => {
    const out = buildSubprocessEnv({ parentEnv: {}, pluginVersion: "0.0.1" });
    expect(out.PATH).toContain("/usr/bin");
    expect(out.LANG).toBe("en_US.UTF-8");
  });

  it("forwards KIMI_CODE_API_KEY and MOONSHOT_API_KEY", () => {
    const out = buildSubprocessEnv({
      parentEnv: { KIMI_CODE_API_KEY: "sk-kc-1", MOONSHOT_API_KEY: "sk-ms-2" },
      pluginVersion: "0.0.1",
    });
    expect(out.KIMI_CODE_API_KEY).toBe("sk-kc-1");
    expect(out.MOONSHOT_API_KEY).toBe("sk-ms-2");
  });

  it("injects KIMI_PLUGIN_VERSION", () => {
    const out = buildSubprocessEnv({ parentEnv: {}, pluginVersion: "1.2.3" });
    expect(out.KIMI_PLUGIN_VERSION).toBe("1.2.3");
  });

  it("strips GITHUB_TOKEN and other secrets", () => {
    const out = buildSubprocessEnv({
      parentEnv: {
        GITHUB_TOKEN: "ghp_x",
        GH_TOKEN: "ghp_y",
        NPM_TOKEN: "npm_z",
        AWS_ACCESS_KEY_ID: "AKIA",
        AWS_SECRET_ACCESS_KEY: "secret",
        GOOGLE_APPLICATION_CREDENTIALS: "/path",
        OPENAI_API_KEY: "sk-oai",
        ANTHROPIC_API_KEY: "sk-anth",
        CLAUDE_CODE_TOKEN: "ccc",
        SSH_AUTH_SOCK: "/tmp/sock",
        SSH_AGENT_PID: "1234",
      },
      pluginVersion: "0.0.1",
    });
    expect(out.GITHUB_TOKEN).toBeUndefined();
    expect(out.GH_TOKEN).toBeUndefined();
    expect(out.NPM_TOKEN).toBeUndefined();
    expect(out.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(out.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(out.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(out.OPENAI_API_KEY).toBeUndefined();
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out.CLAUDE_CODE_TOKEN).toBeUndefined();
    expect(out.SSH_AUTH_SOCK).toBeUndefined();
    expect(out.SSH_AGENT_PID).toBeUndefined();
  });

  it("strips arbitrary _TOKEN / _KEY / _SECRET suffixed vars not in allowlist", () => {
    const out = buildSubprocessEnv({
      parentEnv: {
        MY_RANDOM_TOKEN: "x",
        SOME_API_KEY: "y",
        DB_SECRET: "z",
      },
      pluginVersion: "0.0.1",
    });
    expect(out.MY_RANDOM_TOKEN).toBeUndefined();
    expect(out.SOME_API_KEY).toBeUndefined();
    expect(out.DB_SECRET).toBeUndefined();
  });

  it("does NOT strip the two allowlisted API keys despite their _KEY suffix", () => {
    const out = buildSubprocessEnv({
      parentEnv: { KIMI_CODE_API_KEY: "ok", MOONSHOT_API_KEY: "ok2" },
      pluginVersion: "0.0.1",
    });
    expect(out.KIMI_CODE_API_KEY).toBe("ok");
    expect(out.MOONSHOT_API_KEY).toBe("ok2");
  });

  it("does not include unrelated parent env vars", () => {
    const out = buildSubprocessEnv({
      parentEnv: { RANDOM_VAR: "x", FOO_BAR: "y" },
      pluginVersion: "0.0.1",
    });
    expect(out.RANDOM_VAR).toBeUndefined();
    expect(out.FOO_BAR).toBeUndefined();
  });
});

describe("scrubControlChars", () => {
  it("strips ANSI CSI sequences", () => {
    expect(scrubControlChars("a\x1b[2Jb\x1b[31mc")).toBe("abc");
  });

  it("strips ANSI OSC sequences (BEL-terminated and ESC-backslash-terminated)", () => {
    expect(scrubControlChars("x\x1b]0;title\x07y")).toBe("xy");
    expect(scrubControlChars("x\x1b]8;;https://e.com\x1b\\linky")).toBe("xlinky");
  });

  it("strips raw C0 control characters except tab, newline, carriage return", () => {
    expect(scrubControlChars("a\x00\x07b")).toBe("ab");
    expect(scrubControlChars("a\tb\nc\rd")).toBe("a\tb\nc\rd");
    expect(scrubControlChars("a\x7fb")).toBe("ab");
  });

  it("leaves normal text alone", () => {
    expect(scrubControlChars("Hello, world!")).toBe("Hello, world!");
  });

  it("handles empty input", () => {
    expect(scrubControlChars("")).toBe("");
  });
});

describe("redactSecrets", () => {
  it("replaces every occurrence of a secret with ***REDACTED***", () => {
    expect(redactSecrets("token=sk-abc123 boo sk-abc123", ["sk-abc123"])).toBe(
      "token=***REDACTED*** boo ***REDACTED***",
    );
  });

  it("redacts multiple distinct secrets", () => {
    expect(redactSecrets("a=AAAA b=BBBB", ["AAAA", "BBBB"])).toBe(
      "a=***REDACTED*** b=***REDACTED***",
    );
  });

  it("ignores empty strings in the secrets list", () => {
    expect(redactSecrets("nothing to redact", ["", ""])).toBe("nothing to redact");
  });

  it("ignores secrets shorter than 4 chars to avoid catastrophic false positives", () => {
    expect(redactSecrets("Hello world", ["o"])).toBe("Hello world");
    expect(redactSecrets("Hello world", ["abc"])).toBe("Hello world");
    expect(redactSecrets("Hello world abcd", ["abcd"])).toBe("Hello world ***REDACTED***");
  });

  it("is case-sensitive", () => {
    expect(redactSecrets("SECRET secret", ["secret"])).toBe("SECRET ***REDACTED***");
  });

  it("handles empty input", () => {
    expect(redactSecrets("", ["abc"])).toBe("");
  });
});
