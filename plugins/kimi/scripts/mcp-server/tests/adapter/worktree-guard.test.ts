import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  WorktreeValidationError,
  finishExistingWorktreeChecks,
  prepareCreateWorktree,
  recheckWorktreeTarget,
  validateWorktreeTarget,
} from "../../src/adapter/worktree-guard.js";
import { existsSync, writeFileSync } from "node:fs";

let TMP_RAW: string;
let TMP: string;
let BASE_REPO: string;
let LINKED_WT: string;

beforeAll(() => {
  TMP_RAW = mkdtempSync(path.join(os.tmpdir(), "kimi-wtguard-"));
  TMP = realpathSync(TMP_RAW);

  BASE_REPO = path.join(TMP, "base");
  LINKED_WT = path.join(TMP, "linked");

  mkdirSync(BASE_REPO);
  execSync(`git init -q -b main "${BASE_REPO}"`);
  execSync(`git -C "${BASE_REPO}" config user.email test@example.com`);
  execSync(`git -C "${BASE_REPO}" config user.name test`);
  execSync(`git -C "${BASE_REPO}" commit -q --allow-empty -m bootstrap`);
  execSync(`git -C "${BASE_REPO}" worktree add -q -B feature "${LINKED_WT}"`);
});

afterAll(() => {
  rmSync(TMP_RAW, { recursive: true, force: true });
});

describe("validateWorktreeTarget — happy path", () => {
  it("accepts a separate worktree and returns resolved paths + main worktree", async () => {
    const v = await validateWorktreeTarget({
      baseRepo: BASE_REPO,
      worktreePath: LINKED_WT,
      allowEphemeral: true,
    });

    expect(v.baseRepo.resolved).toBe(BASE_REPO);
    expect(v.worktree.resolved).toBe(LINKED_WT);
    expect(v.mainWorktreePath).toBe(BASE_REPO);
  });
});

describe("validateWorktreeTarget — rejections", () => {
  it("rejects when worktree_path is the main worktree", async () => {
    await expect(
      validateWorktreeTarget({
        baseRepo: BASE_REPO,
        worktreePath: BASE_REPO,
        allowEphemeral: true,
      }),
    ).rejects.toMatchObject({
      name: "WorktreeValidationError",
      code: "equals_main_worktree",
    });
  });

  it("rejects when worktree_path is inside base_repo", async () => {
    const inside = path.join(BASE_REPO, "nested");
    mkdirSync(inside, { recursive: true });
    await expect(
      validateWorktreeTarget({
        baseRepo: BASE_REPO,
        worktreePath: inside,
        allowEphemeral: true,
      }),
    ).rejects.toMatchObject({
      name: "WorktreeValidationError",
      code: "inside_base_repo",
    });
  });

  it("rejects when base_repo is not a git repository", async () => {
    const notGit = path.join(TMP, "not-a-repo");
    mkdirSync(notGit, { recursive: true });
    await expect(
      validateWorktreeTarget({
        baseRepo: notGit,
        worktreePath: LINKED_WT,
        allowEphemeral: true,
      }),
    ).rejects.toMatchObject({
      name: "WorktreeValidationError",
      code: "not_git_repo",
    });
  });

  it("rejects relative base_repo (delegated to path validator)", async () => {
    await expect(
      validateWorktreeTarget({
        baseRepo: "relative/path",
        worktreePath: LINKED_WT,
        allowEphemeral: true,
      }),
    ).rejects.toBeInstanceOf(WorktreeValidationError);
  });
});

describe("prepareCreateWorktree", () => {
  it("creates a new worktree with a kimi-impl-* branch and returns a working cleanup()", async () => {
    const newPath = path.join(TMP, "new-wt");
    const prep = await prepareCreateWorktree({
      baseRepo: BASE_REPO,
      worktreePath: newPath,
      baseRef: "HEAD",
      allowEphemeral: true,
    });

    try {
      expect(prep.createdByUs).toBe(true);
      expect(prep.branch).toMatch(/^kimi-impl-/);
      expect(prep.validated.worktree.resolved).toBe(newPath);
      expect(existsSync(newPath)).toBe(true);
    } finally {
      const status = await prep.cleanup();
      expect(["removed", "cleanup_failed"]).toContain(status);
      expect(existsSync(newPath)).toBe(false);
    }
  });

  it("rejects when worktree_path already exists (no overwrite)", async () => {
    const existing = path.join(TMP, "already-here");
    mkdirSync(existing);
    await expect(
      prepareCreateWorktree({
        baseRepo: BASE_REPO,
        worktreePath: existing,
        baseRef: "HEAD",
        allowEphemeral: true,
      }),
    ).rejects.toMatchObject({
      name: "WorktreeValidationError",
      code: "worktree_already_exists",
    });
  });

  it("propagates not_git_repo when baseRepo isn't git", async () => {
    const notGit = path.join(TMP, "create-not-git");
    mkdirSync(notGit);
    const target = path.join(TMP, "create-target");
    await expect(
      prepareCreateWorktree({
        baseRepo: notGit,
        worktreePath: target,
        baseRef: "HEAD",
        allowEphemeral: true,
      }),
    ).rejects.toMatchObject({ code: "not_git_repo" });
  });
});

describe("recheckWorktreeTarget — TOCTOU", () => {
  it("passes when paths are unchanged", async () => {
    const v = await validateWorktreeTarget({
      baseRepo: BASE_REPO,
      worktreePath: LINKED_WT,
      allowEphemeral: true,
    });
    expect(() => recheckWorktreeTarget(v)).not.toThrow();
  });

  it("throws code='toctou' when the worktree directory vanishes", async () => {
    const ephemeralBase = path.join(TMP, "vanish-base");
    const ephemeralWt = path.join(TMP, "vanish-wt");
    mkdirSync(ephemeralBase);
    execSync(`git init -q -b main "${ephemeralBase}"`);
    execSync(`git -C "${ephemeralBase}" config user.email t@t.com`);
    execSync(`git -C "${ephemeralBase}" config user.name t`);
    execSync(`git -C "${ephemeralBase}" commit -q --allow-empty -m boot`);
    execSync(`git -C "${ephemeralBase}" worktree add -q -B vanish "${ephemeralWt}"`);

    const v = await validateWorktreeTarget({
      baseRepo: ephemeralBase,
      worktreePath: ephemeralWt,
      allowEphemeral: true,
    });

    execSync(`git -C "${ephemeralBase}" worktree remove --force "${ephemeralWt}"`);

    try {
      recheckWorktreeTarget(v);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorktreeValidationError);
      expect((err as WorktreeValidationError).code).toBe("toctou");
    }
  });
});

describe("finishExistingWorktreeChecks", () => {
  it("accepts a clean registered worktree", async () => {
    const v = await validateWorktreeTarget({
      baseRepo: BASE_REPO,
      worktreePath: LINKED_WT,
      allowEphemeral: true,
    });
    const out = await finishExistingWorktreeChecks({
      validated: v,
      allowDirty: false,
    });
    expect(out.branch).toBe("refs/heads/feature");
  });

  it("rejects an unregistered path", async () => {
    const orphan = path.join(TMP, "orphan");
    mkdirSync(orphan, { recursive: true });
    execSync(`git init -q -b main "${orphan}"`);
    const v = await validateWorktreeTarget({
      baseRepo: BASE_REPO,
      worktreePath: orphan,
      allowEphemeral: true,
    });
    await expect(
      finishExistingWorktreeChecks({ validated: v, allowDirty: false }),
    ).rejects.toMatchObject({ code: "worktree_not_registered" });
  });

  it("rejects a dirty worktree unless allowDirty=true", async () => {
    writeFileSync(path.join(LINKED_WT, "scratch.txt"), "dirty\n");
    try {
      const v = await validateWorktreeTarget({
        baseRepo: BASE_REPO,
        worktreePath: LINKED_WT,
        allowEphemeral: true,
      });
      await expect(
        finishExistingWorktreeChecks({ validated: v, allowDirty: false }),
      ).rejects.toMatchObject({ code: "worktree_dirty" });

      const out = await finishExistingWorktreeChecks({
        validated: v,
        allowDirty: true,
      });
      expect(out.branch).toBe("refs/heads/feature");
    } finally {
      rmSync(path.join(LINKED_WT, "scratch.txt"), { force: true });
    }
  });
});
