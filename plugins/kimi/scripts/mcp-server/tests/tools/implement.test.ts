import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  IMPLEMENT_DEFAULT_TIMEOUT_SECONDS,
  IMPLEMENT_MAX_TIMEOUT_SECONDS,
  KimiImplementInputSchema,
  runKimiImplement,
  type KimiImplementContext,
} from "../../src/tools/implement.js";
import type {
  SubprocessOptions,
  SubprocessResult,
} from "../../src/adapter/subprocess-runner.js";

const UUID = "12345678-1234-1234-1234-123456789abc";

let TMP_RAW: string;
let TMP: string;
let BASE_REPO: string;

beforeAll(() => {
  TMP_RAW = mkdtempSync(path.join(os.tmpdir(), "kimi-impl-tool-"));
  TMP = realpathSync(TMP_RAW);
  BASE_REPO = path.join(TMP, "base");
  mkdirSync(BASE_REPO);
  execSync(`git init -q -b main "${BASE_REPO}"`);
  execSync(`git -C "${BASE_REPO}" config user.email test@example.com`);
  execSync(`git -C "${BASE_REPO}" config user.name test`);
  writeFileSync(path.join(BASE_REPO, "README.md"), "# bootstrap\n");
  execSync(`git -C "${BASE_REPO}" add README.md`);
  execSync(`git -C "${BASE_REPO}" commit -q -m bootstrap`);
});

afterAll(() => {
  rmSync(TMP_RAW, { recursive: true, force: true });
});

function fakeKimiThatEdits(filename: string, contents: string) {
  return async (opts: SubprocessOptions): Promise<SubprocessResult> => {
    // Simulate the kimi CLI editing a file inside the spawned cwd (the worktree).
    if (opts.cwd) {
      writeFileSync(path.join(opts.cwd, filename), contents);
      execSync(`git -C "${opts.cwd}" add ${filename}`);
      execSync(`git -C "${opts.cwd}" commit -q -m "kimi: ${filename}"`);
    }
    const stdout = `Edited ${filename}.\n\nTo resume this session: kimi -r ${UUID}\n`;
    return {
      stdout,
      stderr: "",
      stdoutBytes: Buffer.byteLength(stdout, "utf8"),
      stderrBytes: 0,
      exitCode: 0,
      signal: null,
      durationMs: 7,
      truncated: { stdout: false, stderr: false },
      killedBy: "completed",
    };
  };
}

function fakeKimiFailure(stderr = "kimi: boom\n") {
  return async (_opts: SubprocessOptions): Promise<SubprocessResult> => ({
    stdout: "",
    stderr,
    stdoutBytes: 0,
    stderrBytes: Buffer.byteLength(stderr, "utf8"),
    exitCode: 1,
    signal: null,
    durationMs: 3,
    truncated: { stdout: false, stderr: false },
    killedBy: "completed",
  });
}

function baseCtx(over: Partial<KimiImplementContext> = {}): KimiImplementContext {
  return {
    parentEnv: {
      PATH: "/usr/bin",
      HOME: "/Users/test",
      KIMI_CODE_API_KEY: "sk-kc-default-test",
    },
    pluginVersion: "0.0.1-test",
    pathConstraints: { allowEphemeral: true },
    ...over,
  };
}

describe("KimiImplementInputSchema", () => {
  it("requires task, worktree_path, base_repo", () => {
    expect(KimiImplementInputSchema.safeParse({}).success).toBe(false);
    expect(
      KimiImplementInputSchema.safeParse({
        task: "do the thing",
        worktree_path: "/abs/wt",
        base_repo: "/abs/repo",
      }).success,
    ).toBe(true);
  });

  it("defaults base_ref='HEAD', create_worktree=true, allow_dirty=false", () => {
    const parsed = KimiImplementInputSchema.parse({
      task: "x",
      worktree_path: "/abs/wt",
      base_repo: "/abs/repo",
    });
    expect(parsed.base_ref).toBe("HEAD");
    expect(parsed.create_worktree).toBe(true);
    expect(parsed.allow_dirty).toBe(false);
  });

  it("default 600 s timeout, cap 1200 s", () => {
    expect(IMPLEMENT_DEFAULT_TIMEOUT_SECONDS).toBe(600);
    expect(IMPLEMENT_MAX_TIMEOUT_SECONDS).toBe(1200);
    expect(
      KimiImplementInputSchema.safeParse({
        task: "x",
        worktree_path: "/abs",
        base_repo: "/abs",
        timeout_seconds: 1201,
      }).success,
    ).toBe(false);
    expect(
      KimiImplementInputSchema.safeParse({
        task: "x",
        worktree_path: "/abs",
        base_repo: "/abs",
        timeout_seconds: 1200,
      }).success,
    ).toBe(true);
  });

  it("rejects unknown fields (strict)", () => {
    expect(
      KimiImplementInputSchema.safeParse({
        task: "x",
        worktree_path: "/abs",
        base_repo: "/abs",
        weird: 1,
      }).success,
    ).toBe(false);
  });
});

describe("runKimiImplement — create_worktree=true happy path", () => {
  it("creates a worktree, runs kimi with cwd=worktree, captures diff, removes worktree", async () => {
    const newWt = path.join(TMP, `new-wt-${Date.now()}`);
    const out = await runKimiImplement(
      {
        task: "add a hello file",
        worktree_path: newWt,
        base_repo: BASE_REPO,
      },
      baseCtx({ _runSubprocess: fakeKimiThatEdits("hello.txt", "world\n") }),
    );

    expect(out.isError).toBeFalsy();
    const sc = out.structuredContent as Record<string, unknown>;
    expect(sc.worktree_path).toBe(newWt);
    expect((sc.branch as string)).toMatch(/^kimi-impl-/);
    expect(sc.cleanup_status).toBe("removed");
    expect(sc.files_changed).toContain("hello.txt");
    expect(typeof sc.diff).toBe("string");
    expect(sc.diff).toContain("hello.txt");
    expect(sc.diff).toContain("+world");
    expect(existsSync(newWt)).toBe(false);
  });
});

describe("runKimiImplement — create_worktree=false (caller-owned)", () => {
  it("uses an existing registered worktree and leaves it in place", async () => {
    const ownedWt = path.join(TMP, "owned-wt");
    execSync(`git -C "${BASE_REPO}" worktree add -q -B owned "${ownedWt}"`);
    try {
      const out = await runKimiImplement(
        {
          task: "add a file",
          worktree_path: ownedWt,
          base_repo: BASE_REPO,
          create_worktree: false,
        },
        baseCtx({ _runSubprocess: fakeKimiThatEdits("note.txt", "owned\n") }),
      );

      expect(out.isError).toBeFalsy();
      const sc = out.structuredContent as Record<string, unknown>;
      expect(sc.cleanup_status).toBe("left_in_place");
      expect(sc.files_changed).toContain("note.txt");
      expect(existsSync(ownedWt)).toBe(true);
    } finally {
      execSync(`git -C "${BASE_REPO}" worktree remove --force "${ownedWt}"`);
    }
  });
});

describe("runKimiImplement — validation errors", () => {
  it("schema failure → isError validation_error, no spawn", async () => {
    let called = 0;
    const out = await runKimiImplement(
      { task: "" }, // missing worktree_path/base_repo + empty task
      baseCtx({
        _runSubprocess: async () => {
          called += 1;
          throw new Error("should not be called");
        },
      }),
    );
    expect(out.isError).toBe(true);
    expect(called).toBe(0);
    const env = JSON.parse((out.content[0] as { text: string }).text) as { code: string };
    expect(env.code).toBe("validation_error");
  });

  it("worktree_path inside base_repo → isError code='inside_base_repo'", async () => {
    const inside = path.join(BASE_REPO, "subdir-wt");
    const out = await runKimiImplement(
      {
        task: "x",
        worktree_path: inside,
        base_repo: BASE_REPO,
        create_worktree: true,
      },
      baseCtx({ _runSubprocess: fakeKimiThatEdits("nope.txt", "nope") }),
    );
    expect(out.isError).toBe(true);
    const env = JSON.parse((out.content[0] as { text: string }).text) as { code: string };
    expect(env.code).toBe("inside_base_repo");
  });
});

describe("runKimiImplement — runKimiSafe failure", () => {
  it("cli_exit_nonzero from kimi → isError but worktree still cleaned up", async () => {
    const newWt = path.join(TMP, `fail-wt-${Date.now()}`);
    const out = await runKimiImplement(
      {
        task: "x",
        worktree_path: newWt,
        base_repo: BASE_REPO,
      },
      baseCtx({ _runSubprocess: fakeKimiFailure() }),
    );

    expect(out.isError).toBe(true);
    const env = JSON.parse((out.content[0] as { text: string }).text) as { code: string };
    expect(env.code).toBe("cli_exit_nonzero");
    expect(existsSync(newWt)).toBe(false);
  });
});
