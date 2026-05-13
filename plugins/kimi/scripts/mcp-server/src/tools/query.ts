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

export const QUERY_DEFAULT_TIMEOUT_SECONDS = 120;
export const QUERY_MAX_TIMEOUT_SECONDS = 300;

export const KimiQueryInputSchema = z
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
      .max(QUERY_MAX_TIMEOUT_SECONDS)
      .optional(),
    session_id: z.string().uuid().optional(),
    output_format: z.enum(["text", "stream-json"]).optional(),
  })
  .strict();

export type KimiQueryInput = z.infer<typeof KimiQueryInputSchema>;

export interface KimiQueryContext {
  parentEnv: NodeJS.ProcessEnv;
  pluginVersion: string;
  binary?: string;
  pathConstraints?: PathConstraints;
  authFailurePatterns?: ReadonlyArray<RegExp>;
  _runSubprocess?: (opts: SubprocessOptions) => Promise<SubprocessResult>;
}

export async function runKimiQuery(
  rawInput: unknown,
  ctx: KimiQueryContext,
): Promise<MCPToolResponse> {
  const parsed = KimiQueryInputSchema.safeParse(rawInput);
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
    tool: "kimi_query",
    _runSubprocess: ctx._runSubprocess,
  };

  const outputFormat = input.output_format ?? "text";
  const outcome = await runKimiSafe(
    {
      prompt: input.prompt,
      outputFormat,
      // --quiet alias requires text mode; stream-json must NOT pair with it.
      finalMessageOnly: outputFormat === "text",
      model: input.model,
      workDir: input.work_dir,
      addDirs: input.add_dirs,
      maxStepsPerTurn: input.max_steps_per_turn,
      sessionId: input.session_id,
      timeoutSeconds: input.timeout_seconds ?? QUERY_DEFAULT_TIMEOUT_SECONDS,
    },
    adapterCtx,
    { authFailurePatterns: ctx.authFailurePatterns },
  );

  if (!outcome.ok) {
    return errorEnvelope(outcome.error.code, outcome.error.message, outcome.error.details);
  }

  return textResultEnvelope(outcome.result);
}
