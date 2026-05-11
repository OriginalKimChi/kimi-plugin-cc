import { z } from "zod";
import { runKimiSafe } from "../adapter/run-safe.js";
import type { PathConstraints, RunKimiContext } from "../adapter/runner.js";
import type {
  SubprocessOptions,
  SubprocessResult,
} from "../adapter/subprocess-runner.js";
import {
  errorEnvelope,
  textResultEnvelope,
  type MCPToolResponse,
} from "./mcp-response.js";

export type { MCPToolResponse } from "./mcp-response.js";

export const ANALYZE_DEFAULT_TIMEOUT_SECONDS = 300;
export const ANALYZE_MAX_TIMEOUT_SECONDS = 600;

export const KimiAnalyzeInputSchema = z
  .object({
    prompt: z.string().min(1).max(50_000),
    model: z.string().min(1).max(256).optional(),
    work_dir: z.string().optional(),
    add_dirs: z.array(z.string()).max(10).optional(),
    max_steps_per_turn: z.number().int().positive().max(100).optional(),
    timeout_seconds: z
      .number()
      .int()
      .positive()
      .max(ANALYZE_MAX_TIMEOUT_SECONDS)
      .optional(),
    session_id: z.string().uuid().optional(),
  })
  .strict();

export type KimiAnalyzeInput = z.infer<typeof KimiAnalyzeInputSchema>;

export interface KimiAnalyzeContext {
  parentEnv: NodeJS.ProcessEnv;
  pluginVersion: string;
  binary?: string;
  pathConstraints?: PathConstraints;
  authFailurePatterns?: ReadonlyArray<RegExp>;
  _runSubprocess?: (opts: SubprocessOptions) => Promise<SubprocessResult>;
}

export async function runKimiAnalyze(
  rawInput: unknown,
  ctx: KimiAnalyzeContext,
): Promise<MCPToolResponse> {
  const parsed = KimiAnalyzeInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return errorEnvelope("validation_error", parsed.error.message, {
      issues: parsed.error.issues,
    });
  }
  const input = parsed.data;

  const adapterCtx: RunKimiContext = {
    parentEnv: ctx.parentEnv,
    pluginVersion: ctx.pluginVersion,
    binary: ctx.binary,
    pathConstraints: ctx.pathConstraints,
    _runSubprocess: ctx._runSubprocess,
  };

  const outcome = await runKimiSafe(
    {
      prompt: input.prompt,
      outputFormat: "text",
      finalMessageOnly: true,
      model: input.model,
      workDir: input.work_dir,
      addDirs: input.add_dirs,
      maxStepsPerTurn: input.max_steps_per_turn,
      sessionId: input.session_id,
      timeoutSeconds: input.timeout_seconds ?? ANALYZE_DEFAULT_TIMEOUT_SECONDS,
    },
    adapterCtx,
    { authFailurePatterns: ctx.authFailurePatterns },
  );

  if (!outcome.ok) {
    return errorEnvelope(outcome.error.code, outcome.error.message, outcome.error.details);
  }
  return textResultEnvelope(outcome.result);
}
