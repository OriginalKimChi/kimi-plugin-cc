import { buildArgv } from "./argv.js";
import { parseStreamJsonStdout, type KimiStreamEvent } from "./parser-stream-json.js";
import { parseTextStdout } from "./parser-text.js";
import {
  recheckPath,
  validatePath,
  type ValidatedPath,
} from "./path-validator.js";
import { buildSubprocessEnv, redactSecrets, scrubControlChars } from "./security.js";
import {
  runSubprocess,
  type KilledBy,
  type SubprocessOptions,
  type SubprocessResult,
} from "./subprocess-runner.js";
import type { KimiInvocation } from "./types.js";

export const STDOUT_CAP_BYTES = 4 * 1024 * 1024;
export const STDERR_CAP_BYTES = 1 * 1024 * 1024;

export interface RunKimiInvocation extends KimiInvocation {
  timeoutSeconds: number;
}

export interface PathConstraints {
  allowedRoots?: ReadonlyArray<string>;
  allowEphemeral?: boolean;
}

export interface RunKimiContext {
  parentEnv: NodeJS.ProcessEnv;
  pluginVersion: string;
  binary?: string;
  pathConstraints?: PathConstraints;
  _runSubprocess?: (opts: SubprocessOptions) => Promise<SubprocessResult>;
  /** Test seam: fires between validate and recheck so TOCTOU can be simulated. */
  _afterValidate?: () => void | Promise<void>;
}

export interface KimiResult {
  sessionId: string | null;
  finalMessage: string;
  rawEvents?: KimiStreamEvent[];
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  truncated: { stdout: boolean; stderr: boolean };
  killedBy: KilledBy;
  trailingMarkerMissing: boolean;
}

export async function runKimi(
  inv: RunKimiInvocation,
  ctx: RunKimiContext,
): Promise<KimiResult> {
  const constraints = ctx.pathConstraints ?? {};
  const validatedWorkDir =
    inv.workDir !== undefined
      ? validatePath({ path: inv.workDir, field: "workDir", ...constraints })
      : undefined;
  const validatedAddDirs: ValidatedPath[] = (inv.addDirs ?? []).map((p, i) =>
    validatePath({ path: p, field: `addDirs[${i}]`, ...constraints }),
  );
  const validatedConfigFile =
    inv.configFile !== undefined
      ? validatePath({ path: inv.configFile, field: "configFile", ...constraints })
      : undefined;

  const argv = buildArgv({
    ...inv,
    workDir: validatedWorkDir?.resolved,
    addDirs: validatedAddDirs.length > 0 ? validatedAddDirs.map((v) => v.resolved) : undefined,
    configFile: validatedConfigFile?.resolved,
  });
  const env = buildSubprocessEnv({
    parentEnv: ctx.parentEnv,
    pluginVersion: ctx.pluginVersion,
  });

  if (ctx._afterValidate) await ctx._afterValidate();

  if (validatedWorkDir) recheckPath(validatedWorkDir);
  for (const v of validatedAddDirs) recheckPath(v);
  if (validatedConfigFile) recheckPath(validatedConfigFile);

  const spawn = ctx._runSubprocess ?? runSubprocess;

  const sub = await spawn({
    command: ctx.binary ?? "kimi",
    argv,
    env,
    timeoutMs: inv.timeoutSeconds * 1000,
    stdoutCapBytes: STDOUT_CAP_BYTES,
    stderrCapBytes: STDERR_CAP_BYTES,
  });

  const secrets = collectSecrets(env);
  const stderr = redactSecrets(scrubControlChars(sub.stderr), secrets);
  const stdoutScrubbed = scrubControlChars(sub.stdout);

  const common = {
    stdout: stdoutScrubbed,
    stderr,
    stdoutBytes: sub.stdoutBytes,
    stderrBytes: sub.stderrBytes,
    exitCode: sub.exitCode,
    signal: sub.signal,
    durationMs: sub.durationMs,
    truncated: sub.truncated,
    killedBy: sub.killedBy,
  };

  if (inv.outputFormat === "text") {
    const parsed = parseTextStdout(sub.stdout);
    return {
      ...common,
      sessionId: parsed.sessionId,
      finalMessage: redactSecrets(scrubControlChars(parsed.finalMessage), secrets),
      trailingMarkerMissing: parsed.trailingMarkerMissing,
    };
  }

  const parsed = parseStreamJsonStdout(sub.stdout);
  return {
    ...common,
    sessionId: parsed.sessionId,
    finalMessage: redactSecrets(scrubControlChars(parsed.finalMessage), secrets),
    rawEvents: parsed.events,
    trailingMarkerMissing: parsed.trailingMarkerMissing,
  };
}

function collectSecrets(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  for (const key of ["KIMI_CODE_API_KEY", "MOONSHOT_API_KEY"]) {
    const v = env[key];
    if (typeof v === "string" && v.length > 0) out.push(v);
  }
  return out;
}
