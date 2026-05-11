import { buildArgv } from "./argv.js";
import { probeAuth } from "./auth-probe.js";
import {
  KimiError,
  classifyKimiResult,
  type ClassifyContext,
} from "./errors.js";
import { PathValidationError } from "./path-validator.js";
import { runKimi, type KimiResult, type RunKimiContext, type RunKimiInvocation } from "./runner.js";

export interface KimiSuccess {
  ok: true;
  result: KimiResult;
}

export interface KimiFailure {
  ok: false;
  error: KimiError;
}

export type KimiOutcome = KimiSuccess | KimiFailure;

export interface RunKimiSafeOptions {
  authFailurePatterns?: ReadonlyArray<RegExp>;
}

export async function runKimiSafe(
  inv: RunKimiInvocation,
  ctx: RunKimiContext,
  opts: RunKimiSafeOptions = {},
): Promise<KimiOutcome> {
  const home = ctx.parentEnv.HOME ?? "";
  const auth = probeAuth({ env: ctx.parentEnv, home });
  if (auth.state === "missing") {
    return {
      ok: false,
      error: new KimiError(
        "auth_missing",
        "kimi CLI is not authenticated on this machine. Run `kimi login` in a terminal, then retry. Or set KIMI_CODE_API_KEY / MOONSHOT_API_KEY in the environment.",
        emptyDetails(),
      ),
    };
  }

  const secrets = collectSecrets(ctx.parentEnv);
  const plannedArgv = planArgv(inv);

  let result: KimiResult;
  try {
    result = await runKimi(inv, ctx);
  } catch (err) {
    return { ok: false, error: toKimiError(err, plannedArgv, secrets) };
  }

  const classifyCtx: ClassifyContext = {
    argv: plannedArgv,
    secrets,
    outputFormat: inv.outputFormat,
    authFailurePatterns: opts.authFailurePatterns,
  };
  const classified = classifyKimiResult(result, classifyCtx);
  if (classified !== null) return { ok: false, error: classified };
  return { ok: true, result };
}

function planArgv(inv: RunKimiInvocation): string[] {
  try {
    return buildArgv(inv);
  } catch {
    return [];
  }
}

function toKimiError(
  err: unknown,
  argv: ReadonlyArray<string>,
  secrets: ReadonlyArray<string>,
): KimiError {
  if (err instanceof KimiError) return err;
  const details = emptyDetailsWith(argv, secrets);
  if (err instanceof PathValidationError) {
    return new KimiError("path_validation", err.message, details);
  }
  const e = err as NodeJS.ErrnoException;
  if (e && e.code === "ENOENT") {
    return new KimiError(
      "cli_not_found",
      `kimi CLI binary not found on PATH: ${e.message}`,
      details,
    );
  }
  return new KimiError(
    "cli_exit_nonzero",
    err instanceof Error ? err.message : String(err),
    details,
  );
}

function emptyDetails() {
  return { stdout_excerpt: "", stderr_excerpt: "", argv_redacted: [] as string[], duration_ms: 0 };
}

function emptyDetailsWith(argv: ReadonlyArray<string>, secrets: ReadonlyArray<string>) {
  const redacted = secrets.filter((s) => typeof s === "string" && s.length >= 4);
  return {
    stdout_excerpt: "",
    stderr_excerpt: "",
    argv_redacted: argv.map((a) => (redacted.includes(a) ? "***REDACTED***" : a)),
    duration_ms: 0,
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
