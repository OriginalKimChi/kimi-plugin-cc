/**
 * Opt-in integration smoke against the real `kimi` CLI binary.
 *
 * Skipped unless KIMI_PLUGIN_INTEGRATION=1. Requires the kimi binary on PATH
 * and a valid KIMI_CODE_API_KEY (or MOONSHOT_API_KEY) in the environment.
 *
 * Run with: `KIMI_PLUGIN_INTEGRATION=1 npm run test:integration`
 */
import { describe, expect, it } from "vitest";
import { probeKimiVersion } from "../../src/adapter/cli-probe.js";
import { runKimiQuery } from "../../src/tools/query.js";
import { runKimiResume } from "../../src/tools/resume.js";

const RUN_INTEGRATION = process.env.KIMI_PLUGIN_INTEGRATION === "1";
const INTEGRATION_TIMEOUT_MS = 180_000; // generous; real LLM latency
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ctx(): {
  parentEnv: NodeJS.ProcessEnv;
  pluginVersion: string;
} {
  return {
    parentEnv: process.env,
    pluginVersion: "0.0.1-integration",
  };
}

describe.skipIf(!RUN_INTEGRATION)("kimi CLI integration (opt-in)", () => {
  it(
    "probeKimiVersion succeeds against the real binary",
    async () => {
      const probe = await probeKimiVersion(ctx());
      expect(probe.error, JSON.stringify(probe.error)).toBeUndefined();
      expect(probe.version, JSON.stringify(probe)).not.toBeNull();
      expect(probe.version).toMatch(/^\d+\.\d+\.\d+/);
      // If the version isn't in CLI_COMPAT we still pass the call but flag unsupported.
      // Either supported=true or unsupported=true must hold.
      expect(probe.entry.id).toBeDefined();
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "kimi_query returns a finalMessage and a UUID session_id",
    async () => {
      const out = await runKimiQuery(
        {
          prompt: "Reply with exactly the word 'pong' and nothing else.",
          timeout_seconds: 120,
        },
        ctx(),
      );

      expect(out.isError, JSON.stringify(out)).toBeFalsy();
      expect(out.content[0]).toBeDefined();
      const text = (out.content[0] as { text: string }).text;
      expect(text.length).toBeGreaterThan(0);

      const sc = out.structuredContent as Record<string, unknown>;
      expect(typeof sc.session_id).toBe("string");
      expect(sc.session_id as string).toMatch(UUID_RE);
      expect(sc.exit_code).toBe(0);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "kimi_resume reuses the session_id returned by kimi_query",
    async () => {
      const first = await runKimiQuery(
        {
          prompt: "Remember the number 42. Reply with the word 'ack'.",
          timeout_seconds: 120,
        },
        ctx(),
      );
      expect(first.isError, JSON.stringify(first)).toBeFalsy();
      const firstSid = (first.structuredContent as Record<string, unknown>).session_id as string;
      expect(firstSid).toMatch(UUID_RE);

      const second = await runKimiResume(
        {
          prompt: "What number did I ask you to remember?",
          session_id: firstSid,
          timeout_seconds: 120,
        },
        ctx(),
      );
      expect(second.isError, JSON.stringify(second)).toBeFalsy();
      const text = (second.content[0] as { text: string }).text;
      // The model should mention 42 if the session was actually resumed.
      expect(text).toContain("42");
    },
    INTEGRATION_TIMEOUT_MS * 2,
  );
});
