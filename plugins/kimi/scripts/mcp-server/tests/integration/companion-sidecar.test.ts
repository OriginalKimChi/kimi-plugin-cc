/**
 * Companion sidecar smoke test.
 *
 * Spawns kimi-companion.mjs with KIMI_BIN pointing at a stub binary that emits
 * the canonical session-resume trailer, and asserts a sidecar file is written
 * under sessions/<session-id>.json in the workspace state dir.
 *
 * Runs unconditionally — uses a stub, never the real Kimi CLI.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runKimi, type RunKimiContext } from "../../src/adapter/runner.js";
import { sessionsDir } from "../../src/adapter/state-paths.js";
import type { SubprocessOptions, SubprocessResult } from "../../src/adapter/subprocess-runner.js";

const COMPANION = path.resolve(
  __dirname,
  "../../../../../kimi/scripts/kimi-companion.mjs",
);
const UUID = "12345678-1234-1234-1234-123456789abc";

let tmp: string;
let stateRoot: string;
let stubPath: string;
let repo: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "kimi-companion-side-")));
  stateRoot = path.join(tmp, "state-root");
  repo = path.join(tmp, "repo");
  mkdirSync(path.join(repo, ".git"), { recursive: true });

  stubPath = path.join(tmp, "kimi-stub.sh");
  writeFileSync(
    stubPath,
    `#!/bin/sh\nprintf 'Hello from stub.\\n\\nTo resume this session: kimi -r ${UUID}\\n'\n`,
    "utf8",
  );
  chmodSync(stubPath, 0o755);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function fakeSub(stdout: string): NonNullable<RunKimiContext["_runSubprocess"]> {
  return async (_opts: SubprocessOptions): Promise<SubprocessResult> => ({
    stdout,
    stderr: "",
    stdoutBytes: stdout.length,
    stderrBytes: 0,
    exitCode: 0,
    signal: null,
    durationMs: 5,
    truncated: { stdout: false, stderr: false },
    killedBy: "completed",
  });
}

describe("kimi-companion writes a sidecar", () => {
  it("writes <stateRoot>/<slug>-<hash>/sessions/<session_id>.json after a foreground task", () => {
    const res = spawnSync(
      "node",
      [COMPANION, "task", "--read-only", "--cwd", repo, "--timeout-seconds", "10", "hi"],
      {
        env: {
          ...process.env,
          KIMI_BIN: stubPath,
          KIMI_STATE_DIR: stateRoot,
        },
        encoding: "utf8",
      },
    );
    expect(res.status, `companion exit=${res.status} stderr=${res.stderr}`).toBe(0);

    const entries = readdirSync(stateRoot);
    expect(entries.length).toBeGreaterThan(0);
    const workspaceDir = path.join(stateRoot, entries[0]!);
    const sessionsDir = path.join(workspaceDir, "sessions");
    const sidecarFiles = readdirSync(sessionsDir);
    expect(sidecarFiles).toContain(`${UUID}.json`);
    const sidecar = JSON.parse(readFileSync(path.join(sessionsDir, `${UUID}.json`), "utf8"));
    expect(sidecar.session_id).toBe(UUID);
    expect(sidecar.source).toBe("companion");
    expect(sidecar.phase).toBe("completed");
    expect(sidecar.job_id).toMatch(/^kimi-task-/);
    expect(sidecar.schema_version).toBe(1);
  });

  it("MCP runner and companion converge on the same sessions/ directory", async () => {
    // 1) Companion writes its sidecar
    const compRes = spawnSync(
      "node",
      [COMPANION, "task", "--read-only", "--cwd", repo, "--timeout-seconds", "10", "hi"],
      {
        env: { ...process.env, KIMI_BIN: stubPath, KIMI_STATE_DIR: stateRoot },
        encoding: "utf8",
      },
    );
    expect(compRes.status).toBe(0);

    // 2) MCP runner writes its sidecar in the same workspace (different session)
    process.env.KIMI_STATE_DIR = stateRoot;
    const mcpSession = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await runKimi(
      { prompt: "x", outputFormat: "text", finalMessageOnly: true, timeoutSeconds: 5, workDir: repo },
      {
        parentEnv: { PATH: "/usr/bin", HOME: "/Users/test" },
        pluginVersion: "0.3.0-test",
        pathConstraints: { allowEphemeral: true },
        tool: "kimi_query",
        _runSubprocess: fakeSub(
          `mcp-final\n\nTo resume this session: kimi -r ${mcpSession}\n`,
        ),
      },
    );

    const dir = sessionsDir(repo);
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files).toContain(`${UUID}.json`);
    expect(files).toContain(`${mcpSession}.json`);

    const compSide = JSON.parse(readFileSync(path.join(dir, `${UUID}.json`), "utf8"));
    const mcpSide = JSON.parse(readFileSync(path.join(dir, `${mcpSession}.json`), "utf8"));
    expect(compSide.source).toBe("companion");
    expect(mcpSide.source).toBe("mcp");
  });
});
