/**
 * Stop-review-gate hook integration test.
 *
 * Spawns the hook script with a fake KIMI_BIN stub and a fake state.json,
 * confirms hook decisions for ALLOW / BLOCK / unexpected output and the
 * disabled-config path. No real Kimi CLI involved.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

const HOOK = path.resolve(
  __dirname,
  "../../../../../kimi/scripts/stop-review-gate-hook.mjs",
);

let tmp: string;
let stateRoot: string;
let repo: string;
let workspaceStateDir: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "kimi-stop-gate-")));
  stateRoot = path.join(tmp, "state-root");
  repo = path.join(tmp, "repo");
  mkdirSync(path.join(repo, ".git"), { recursive: true });

  // Compute the workspace state dir the way the hook does.
  const canonical = realpathSync(repo);
  const slug = "repo";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  workspaceStateDir = path.join(stateRoot, `${slug}-${hash}`);
  mkdirSync(workspaceStateDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(stopReviewGate: boolean): void {
  writeFileSync(
    path.join(workspaceStateDir, "state.json"),
    JSON.stringify({ jobs: [], config: { stopReviewGate } }, null, 2),
    "utf8",
  );
}

function writeStubKimi(firstLine: string, status = 0): string {
  const stub = path.join(tmp, "kimi-stub.sh");
  // The stub ignores its arguments and emits the configured first line.
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "${firstLine}"\nexit ${status}\n`, "utf8");
  chmodSync(stub, 0o755);
  return stub;
}

function runHook(opts: {
  kimiBin?: string;
  hookInput: Record<string, unknown>;
}): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KIMI_STATE_DIR: stateRoot,
  };
  if (opts.kimiBin === undefined) {
    delete env.KIMI_BIN;
    env.PATH = "/nonexistent";
  } else {
    env.KIMI_BIN = opts.kimiBin;
  }
  const res = spawnSync("node", [HOOK], {
    input: JSON.stringify(opts.hookInput),
    env,
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe("stop-review-gate hook", () => {
  it("permits silently when stopReviewGate is disabled (no config)", () => {
    const stub = writeStubKimi("ALLOW: noop");
    const res = runHook({ kimiBin: stub, hookInput: { cwd: repo, last_assistant_message: "ok" } });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("");
  });

  it("permits silently when stopReviewGate is explicitly disabled", () => {
    writeConfig(false);
    const stub = writeStubKimi("ALLOW: looks fine");
    const res = runHook({ kimiBin: stub, hookInput: { cwd: repo, last_assistant_message: "ok" } });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("");
  });

  it("permits silently when Kimi answers ALLOW:", () => {
    writeConfig(true);
    const stub = writeStubKimi("ALLOW: nothing to fix");
    const res = runHook({ kimiBin: stub, hookInput: { cwd: repo, last_assistant_message: "ok" } });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("");
  });

  it("emits block decision when Kimi answers BLOCK:", () => {
    writeConfig(true);
    const stub = writeStubKimi("BLOCK: tests fail, missing migration");
    const res = runHook({ kimiBin: stub, hookInput: { cwd: repo, last_assistant_message: "ok" } });
    expect(res.status).toBe(0);
    const payload = JSON.parse(res.stdout.trim());
    expect(payload.decision).toBe("block");
    expect(payload.reason).toMatch(/tests fail/);
  });

  it("blocks when Kimi returns garbage", () => {
    writeConfig(true);
    const stub = writeStubKimi("MAYBE: dunno");
    const res = runHook({ kimiBin: stub, hookInput: { cwd: repo, last_assistant_message: "ok" } });
    expect(res.status).toBe(0);
    const payload = JSON.parse(res.stdout.trim());
    expect(payload.decision).toBe("block");
    expect(payload.reason).toMatch(/unexpected verdict/);
  });

  it("blocks when Kimi exits non-zero", () => {
    writeConfig(true);
    const stub = writeStubKimi("crash output", 7);
    const res = runHook({ kimiBin: stub, hookInput: { cwd: repo, last_assistant_message: "ok" } });
    expect(res.status).toBe(0);
    const payload = JSON.parse(res.stdout.trim());
    expect(payload.decision).toBe("block");
    expect(payload.reason).toMatch(/exit=7/);
  });

  it("blocks with setup hint when KIMI_BIN cannot be found", () => {
    writeConfig(true);
    const res = runHook({ kimiBin: "/nonexistent/kimi-binary", hookInput: { cwd: repo } });
    expect(res.status).toBe(0);
    const payload = JSON.parse(res.stdout.trim());
    expect(payload.decision).toBe("block");
    expect(payload.reason).toMatch(/not on PATH|kimi:setup/);
  });
});
