import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { executeGit, type ExecuteGit } from "./git-runner.js";
import {
  PathValidationError,
  recheckPath,
  validatePath,
  type ValidatedPath,
} from "./path-validator.js";
import { parseWorktreeList, type WorktreeEntry } from "./worktree-list.js";

export type WorktreeValidationCode =
  | "path_validation"
  | "inside_base_repo"
  | "not_git_repo"
  | "equals_main_worktree"
  | "worktree_list_failed"
  | "worktree_not_registered"
  | "worktree_dirty"
  | "worktree_already_exists"
  | "worktree_add_failed"
  | "toctou";

export class WorktreeValidationError extends Error {
  readonly code: WorktreeValidationCode;
  readonly field?: string;
  readonly cause?: unknown;
  constructor(
    code: WorktreeValidationCode,
    message: string,
    extras: { field?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "WorktreeValidationError";
    this.code = code;
    this.field = extras.field;
    this.cause = extras.cause;
  }
}

export interface ValidateWorktreeTargetOptions {
  baseRepo: string;
  worktreePath: string;
  allowedRoots?: ReadonlyArray<string>;
  allowEphemeral?: boolean;
  _executeGit?: ExecuteGit;
}

export interface ValidatedWorktreeTarget {
  baseRepo: ValidatedPath;
  worktree: ValidatedPath;
  mainWorktreePath: string;
}

export async function validateWorktreeTarget(
  opts: ValidateWorktreeTargetOptions,
): Promise<ValidatedWorktreeTarget> {
  const gitExec: ExecuteGit = opts._executeGit ?? executeGit;
  const constraints = {
    allowedRoots: opts.allowedRoots,
    allowEphemeral: opts.allowEphemeral,
  };

  let baseRepo: ValidatedPath;
  try {
    baseRepo = validatePath({ path: opts.baseRepo, field: "base_repo", ...constraints });
  } catch (err) {
    throw toWorktreeValidationError(err, "base_repo");
  }

  let worktree: ValidatedPath;
  try {
    worktree = validatePath({
      path: opts.worktreePath,
      field: "worktree_path",
      ...constraints,
    });
  } catch (err) {
    throw toWorktreeValidationError(err, "worktree_path");
  }

  if (isSubpath(worktree.resolved, baseRepo.resolved) && worktree.resolved !== baseRepo.resolved) {
    throw new WorktreeValidationError(
      "inside_base_repo",
      `worktree_path must not live under base_repo (got ${worktree.resolved} ⊂ ${baseRepo.resolved})`,
      { field: "worktree_path" },
    );
  }

  const revParse = await gitExec({
    cwd: baseRepo.resolved,
    args: ["rev-parse", "--git-dir"],
  });
  if (revParse.exitCode !== 0) {
    throw new WorktreeValidationError(
      "not_git_repo",
      `base_repo is not a git repository: ${baseRepo.resolved}`,
      { field: "base_repo" },
    );
  }

  const list = await gitExec({
    cwd: baseRepo.resolved,
    args: ["worktree", "list", "--porcelain"],
  });
  if (list.exitCode !== 0) {
    throw new WorktreeValidationError(
      "worktree_list_failed",
      `'git worktree list' failed: ${list.stderr.trim()}`,
      { cause: list },
    );
  }
  const entries = parseWorktreeList(list.stdout);
  if (entries.length === 0) {
    throw new WorktreeValidationError(
      "worktree_list_failed",
      "'git worktree list' returned no entries",
    );
  }
  const mainWorktreePath = entries[0]!.path;

  if (worktree.resolved === mainWorktreePath) {
    throw new WorktreeValidationError(
      "equals_main_worktree",
      `worktree_path is the main worktree of base_repo (${mainWorktreePath})`,
      { field: "worktree_path" },
    );
  }

  return { baseRepo, worktree, mainWorktreePath };
}

export function recheckWorktreeTarget(v: ValidatedWorktreeTarget): void {
  try {
    recheckPath(v.baseRepo);
    recheckPath(v.worktree);
  } catch (err) {
    throw toWorktreeValidationError(err);
  }
}

export type CleanupStatus = "removed" | "left_in_place" | "cleanup_failed";

export interface PreparedWorktree {
  validated: ValidatedWorktreeTarget;
  branch: string | null;
  createdByUs: boolean;
  cleanup: () => Promise<CleanupStatus>;
}

export interface PrepareCreateWorktreeOptions {
  baseRepo: string;
  worktreePath: string;
  baseRef: string;
  allowedRoots?: ReadonlyArray<string>;
  allowEphemeral?: boolean;
  _executeGit?: ExecuteGit;
}

export async function prepareCreateWorktree(
  opts: PrepareCreateWorktreeOptions,
): Promise<PreparedWorktree> {
  const gitExec: ExecuteGit = opts._executeGit ?? executeGit;
  const constraints = {
    allowedRoots: opts.allowedRoots,
    allowEphemeral: opts.allowEphemeral,
  };

  let baseRepo: ValidatedPath;
  try {
    baseRepo = validatePath({ path: opts.baseRepo, field: "base_repo", ...constraints });
  } catch (err) {
    throw toWorktreeValidationError(err, "base_repo");
  }

  // worktree_path must NOT exist yet — partial path checks only (absolute + no NUL).
  const wtPath = opts.worktreePath;
  if (typeof wtPath !== "string" || wtPath.length === 0) {
    throw new WorktreeValidationError("path_validation", "worktree_path is required", {
      field: "worktree_path",
    });
  }
  if (wtPath.includes(String.fromCharCode(0))) {
    throw new WorktreeValidationError(
      "path_validation",
      "worktree_path must not contain NUL bytes",
      { field: "worktree_path" },
    );
  }
  if (!path.isAbsolute(wtPath)) {
    throw new WorktreeValidationError(
      "path_validation",
      "worktree_path must be an absolute path",
      { field: "worktree_path" },
    );
  }
  if (existsSync(wtPath)) {
    throw new WorktreeValidationError(
      "worktree_already_exists",
      `worktree_path already exists: ${wtPath}`,
      { field: "worktree_path" },
    );
  }

  // Confirm baseRepo is a git repo before we try to add a worktree off it.
  const revParse = await gitExec({ cwd: baseRepo.resolved, args: ["rev-parse", "--git-dir"] });
  if (revParse.exitCode !== 0) {
    throw new WorktreeValidationError(
      "not_git_repo",
      `base_repo is not a git repository: ${baseRepo.resolved}`,
      { field: "base_repo" },
    );
  }

  const branch = generateBranchName(opts.baseRef);
  const add = await gitExec({
    cwd: baseRepo.resolved,
    args: ["worktree", "add", "-b", branch, wtPath, opts.baseRef],
  });
  if (add.exitCode !== 0) {
    throw new WorktreeValidationError(
      "worktree_add_failed",
      `git worktree add failed: ${add.stderr.trim() || add.stdout.trim()}`,
      { cause: add },
    );
  }

  // Now the worktree exists — finish validation with the full validator and
  // confirm it isn't somehow the main worktree (shouldn't be, but defense in depth).
  let validated: ValidatedWorktreeTarget;
  try {
    validated = await validateWorktreeTarget({
      baseRepo: baseRepo.original,
      worktreePath: wtPath,
      allowedRoots: opts.allowedRoots,
      allowEphemeral: opts.allowEphemeral,
      _executeGit: gitExec,
    });
  } catch (err) {
    // Best-effort cleanup of the worktree we just created before bubbling up.
    await runCleanup(gitExec, baseRepo.resolved, wtPath);
    throw err;
  }

  let cleanedUp = false;
  return {
    validated,
    branch,
    createdByUs: true,
    cleanup: async () => {
      if (cleanedUp) return "removed";
      cleanedUp = true;
      return runCleanup(gitExec, baseRepo.resolved, wtPath);
    },
  };
}

export interface FinishExistingWorktreeOptions {
  validated: ValidatedWorktreeTarget;
  allowDirty: boolean;
  _executeGit?: ExecuteGit;
}

export async function finishExistingWorktreeChecks(
  opts: FinishExistingWorktreeOptions,
): Promise<{ branch: string | null }> {
  const gitExec: ExecuteGit = opts._executeGit ?? executeGit;
  const v = opts.validated;

  const list = await gitExec({
    cwd: v.baseRepo.resolved,
    args: ["worktree", "list", "--porcelain"],
  });
  if (list.exitCode !== 0) {
    throw new WorktreeValidationError(
      "worktree_list_failed",
      `'git worktree list' failed: ${list.stderr.trim()}`,
      { cause: list },
    );
  }
  const entries = parseWorktreeList(list.stdout);
  const matched: WorktreeEntry | undefined = entries.find(
    (e) => e.path === v.worktree.resolved,
  );
  if (!matched) {
    throw new WorktreeValidationError(
      "worktree_not_registered",
      `worktree_path is not a registered worktree of base_repo: ${v.worktree.resolved}`,
      { field: "worktree_path" },
    );
  }

  if (!opts.allowDirty) {
    const status = await gitExec({
      cwd: v.worktree.resolved,
      args: ["status", "--porcelain"],
    });
    if (status.exitCode !== 0) {
      throw new WorktreeValidationError(
        "worktree_list_failed",
        `'git status --porcelain' failed: ${status.stderr.trim()}`,
        { cause: status },
      );
    }
    if (status.stdout.trim().length > 0) {
      throw new WorktreeValidationError(
        "worktree_dirty",
        "worktree has uncommitted changes; pass allow_dirty=true to override",
        { field: "worktree_path" },
      );
    }
  }

  return { branch: matched.branch ?? null };
}

async function runCleanup(
  gitExec: ExecuteGit,
  baseRepo: string,
  worktreePath: string,
): Promise<CleanupStatus> {
  try {
    const r = await gitExec({
      cwd: baseRepo,
      args: ["worktree", "remove", "--force", worktreePath],
    });
    return r.exitCode === 0 ? "removed" : "cleanup_failed";
  } catch {
    return "cleanup_failed";
  }
}

function generateBranchName(baseRef: string): string {
  const sha7 = createHash("sha1").update(baseRef).digest("hex").slice(0, 7);
  return `kimi-impl-${sha7}-${Date.now()}`;
}

function isSubpath(child: string, parent: string): boolean {
  if (child === parent) return true;
  const parentWithSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(parentWithSep);
}

function toWorktreeValidationError(err: unknown, field?: string): WorktreeValidationError {
  if (err instanceof WorktreeValidationError) return err;
  if (err instanceof PathValidationError) {
    const code: WorktreeValidationCode = err.code === "toctou" ? "toctou" : "path_validation";
    return new WorktreeValidationError(code, err.message, { field: field ?? err.field, cause: err });
  }
  return new WorktreeValidationError(
    "path_validation",
    err instanceof Error ? err.message : String(err),
    { field, cause: err },
  );
}
