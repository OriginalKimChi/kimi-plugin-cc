import { z } from "zod";
import { executeGit, type ExecuteGit } from "../adapter/git-runner.js";
import { runKimiSafe } from "../adapter/run-safe.js";
import type { PathConstraints, RunKimiContext } from "../adapter/runner.js";
import type {
  SubprocessOptions,
  SubprocessResult,
} from "../adapter/subprocess-runner.js";
import {
  WorktreeValidationError,
  finishExistingWorktreeChecks,
  prepareCreateWorktree,
  recheckWorktreeTarget,
  validateWorktreeTarget,
  type CleanupStatus,
  type ValidatedWorktreeTarget,
} from "../adapter/worktree-guard.js";
import { errorEnvelope, type MCPToolResponse } from "./mcp-response.js";

export type { MCPToolResponse } from "./mcp-response.js";

export const IMPLEMENT_DEFAULT_TIMEOUT_SECONDS = 600;
export const IMPLEMENT_MAX_TIMEOUT_SECONDS = 1200;

export const KimiImplementInputSchema = z
  .object({
    task: z.string().min(1).max(50_000),
    worktree_path: z.string().min(1),
    base_repo: z.string().min(1),
    base_ref: z.string().min(1).default("HEAD"),
    create_worktree: z.boolean().default(true),
    allow_dirty: z.boolean().default(false),
    model: z.string().min(1).max(256).optional(),
    timeout_seconds: z
      .number()
      .int()
      .positive()
      .max(IMPLEMENT_MAX_TIMEOUT_SECONDS)
      .optional(),
  })
  .strict();

export type KimiImplementInput = z.infer<typeof KimiImplementInputSchema>;

export interface KimiImplementContext {
  parentEnv: NodeJS.ProcessEnv;
  pluginVersion: string;
  binary?: string;
  pathConstraints?: PathConstraints;
  authFailurePatterns?: ReadonlyArray<RegExp>;
  _runSubprocess?: (opts: SubprocessOptions) => Promise<SubprocessResult>;
  _executeGit?: ExecuteGit;
}

interface PreparedHandle {
  validated: ValidatedWorktreeTarget;
  branch: string | null;
  cleanup: () => Promise<CleanupStatus>;
  ownedByCaller: boolean;
}

export async function runKimiImplement(
  rawInput: unknown,
  ctx: KimiImplementContext,
): Promise<MCPToolResponse> {
  const parsed = KimiImplementInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return errorEnvelope("validation_error", parsed.error.message, {
      issues: parsed.error.issues,
    });
  }
  const input = parsed.data;
  const gitExec: ExecuteGit = ctx._executeGit ?? executeGit;
  const constraints = ctx.pathConstraints ?? {};

  // Phase 1 — get or create the worktree.
  let prepared: PreparedHandle;
  try {
    prepared = input.create_worktree
      ? await asPrepared(
          await prepareCreateWorktree({
            baseRepo: input.base_repo,
            worktreePath: input.worktree_path,
            baseRef: input.base_ref,
            allowedRoots: constraints.allowedRoots,
            allowEphemeral: constraints.allowEphemeral,
            _executeGit: gitExec,
          }),
          { ownedByCaller: false },
        )
      : await prepareExisting(input, gitExec, constraints);
  } catch (err) {
    return worktreeErrorEnvelope(err);
  }

  // Resolve baseRef → sha *before* kimi runs, so diff captures changes even
  // when kimi commits inside the worktree (HEAD moves after that point).
  const baseShaRes = await gitExec({
    cwd: prepared.validated.worktree.resolved,
    args: ["rev-parse", input.base_ref],
  });
  const baseSha = baseShaRes.exitCode === 0 ? baseShaRes.stdout.trim() : input.base_ref;

  // Phase 2 — TOCTOU recheck, then run kimi.
  try {
    recheckWorktreeTarget(prepared.validated);
  } catch (err) {
    await safeCleanup(prepared);
    return worktreeErrorEnvelope(err);
  }

  const adapterCtx: RunKimiContext = {
    parentEnv: ctx.parentEnv,
    pluginVersion: ctx.pluginVersion,
    binary: ctx.binary,
    pathConstraints: ctx.pathConstraints,
    tool: "kimi_implement",
    _runSubprocess: ctx._runSubprocess,
  };

  const outcome = await runKimiSafe(
    {
      prompt: input.task,
      outputFormat: "text",
      finalMessageOnly: true,
      model: input.model,
      timeoutSeconds: input.timeout_seconds ?? IMPLEMENT_DEFAULT_TIMEOUT_SECONDS,
      cwd: prepared.validated.worktree.resolved,
    },
    adapterCtx,
    { authFailurePatterns: ctx.authFailurePatterns },
  );

  // Phase 3 — capture diff regardless of outcome, then clean up.
  const capture = await captureChanges(
    gitExec,
    prepared.validated.worktree.resolved,
    baseSha,
  );
  const cleanupStatus = await safeCleanup(prepared);

  if (!outcome.ok) {
    const env = errorEnvelope(outcome.error.code, outcome.error.message, outcome.error.details);
    (env.structuredContent as Record<string, unknown>) = {
      ...(env.structuredContent as Record<string, unknown>),
      worktree_path: prepared.validated.worktree.resolved,
      branch: prepared.branch,
      cleanup_status: cleanupStatus,
    };
    return env;
  }

  const r = outcome.result;
  const structuredContent: Record<string, unknown> = {
    worktree_path: prepared.validated.worktree.resolved,
    branch: prepared.branch,
    commit_sha: capture.commitSha,
    diff: capture.diff,
    files_changed: capture.filesChanged,
    cleanup_status: cleanupStatus,
    kimi_stdout_excerpt: excerpt(r.stdout, 2048),
    session_id: r.sessionId,
    exit_code: r.exitCode,
    duration_ms: r.durationMs,
  };
  return {
    content: [{ type: "text", text: r.finalMessage }],
    structuredContent,
  };
}

async function prepareExisting(
  input: KimiImplementInput,
  gitExec: ExecuteGit,
  constraints: PathConstraints,
): Promise<PreparedHandle> {
  const validated = await validateWorktreeTarget({
    baseRepo: input.base_repo,
    worktreePath: input.worktree_path,
    allowedRoots: constraints.allowedRoots,
    allowEphemeral: constraints.allowEphemeral,
    _executeGit: gitExec,
  });
  const { branch } = await finishExistingWorktreeChecks({
    validated,
    allowDirty: input.allow_dirty,
    _executeGit: gitExec,
  });
  return {
    validated,
    branch,
    ownedByCaller: true,
    cleanup: async () => "left_in_place",
  };
}

async function asPrepared(
  prep: { validated: ValidatedWorktreeTarget; branch: string | null; cleanup: () => Promise<CleanupStatus> },
  extras: { ownedByCaller: boolean },
): Promise<PreparedHandle> {
  return { ...prep, ownedByCaller: extras.ownedByCaller };
}

async function safeCleanup(prep: PreparedHandle): Promise<CleanupStatus> {
  try {
    return await prep.cleanup();
  } catch {
    return "cleanup_failed";
  }
}

interface ChangeCapture {
  diff: string;
  filesChanged: string[];
  commitSha: string | null;
}

async function captureChanges(
  gitExec: ExecuteGit,
  worktree: string,
  baseSha: string,
): Promise<ChangeCapture> {
  const diff = await gitExec({ cwd: worktree, args: ["diff", baseSha] });
  const names = await gitExec({ cwd: worktree, args: ["diff", "--name-only", baseSha] });
  const headSha = await gitExec({ cwd: worktree, args: ["rev-parse", "HEAD"] });

  const filesChanged =
    names.exitCode === 0
      ? names.stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];

  const commitSha =
    headSha.exitCode === 0 && headSha.stdout.trim() !== baseSha
      ? headSha.stdout.trim()
      : null;

  return {
    diff: diff.exitCode === 0 ? diff.stdout : "",
    filesChanged,
    commitSha,
  };
}

function excerpt(s: string, cap: number): string {
  if (Buffer.byteLength(s, "utf8") <= cap) return s;
  const head = Buffer.from(s, "utf8").subarray(0, cap).toString("utf8");
  return `${head}\n\n[truncated: excerpt exceeded ${cap} bytes]`;
}

function worktreeErrorEnvelope(err: unknown): MCPToolResponse {
  if (err instanceof WorktreeValidationError) {
    return errorEnvelope(err.code, err.message, { field: err.field });
  }
  return errorEnvelope(
    "cli_exit_nonzero",
    err instanceof Error ? err.message : String(err),
    {},
  );
}
