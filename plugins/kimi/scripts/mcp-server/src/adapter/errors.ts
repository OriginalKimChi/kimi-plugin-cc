import type { KimiOutputFormat } from "./types.js";
import type { KimiResult } from "./runner.js";

export type KimiErrorCode =
  | "validation_error"
  | "auth_missing"
  | "auth_invalid"
  | "timeout"
  | "cli_not_found"
  | "cli_version_unsupported"
  | "cli_shape_error"
  | "cli_exit_nonzero"
  | "subprocess_killed_external"
  | "path_validation";

export interface KimiErrorDetails {
  stdout_excerpt: string;
  stderr_excerpt: string;
  argv_redacted: string[];
  duration_ms: number;
}

export class KimiError extends Error {
  readonly code: KimiErrorCode;
  readonly details: KimiErrorDetails;
  constructor(code: KimiErrorCode, message: string, details: KimiErrorDetails) {
    super(message);
    this.name = "KimiError";
    this.code = code;
    this.details = details;
  }
}

export interface ClassifyContext {
  argv: ReadonlyArray<string>;
  secrets: ReadonlyArray<string>;
  outputFormat: KimiOutputFormat;
  /** Per-compat regexes that, if matched against stderr, mean auth failure. */
  authFailurePatterns?: ReadonlyArray<RegExp>;
}

const EXCERPT_CAP_BYTES = 2048;
const REDACTED = "***REDACTED***";

export function classifyKimiResult(
  result: KimiResult,
  ctx: ClassifyContext,
): KimiError | null {
  const details = buildDetails(result, ctx);

  if (
    result.killedBy === "timeout" ||
    result.killedBy === "stdout_cap" ||
    result.killedBy === "stderr_cap"
  ) {
    return new KimiError("timeout", `kimi CLI killed by ${result.killedBy}`, details);
  }

  if (matchesAuthFailure(result.stderr, ctx.authFailurePatterns)) {
    return new KimiError("auth_invalid", "kimi CLI reported an auth failure", details);
  }

  if (result.signal !== null && result.killedBy === "completed") {
    return new KimiError(
      "subprocess_killed_external",
      `kimi CLI exited from external signal ${result.signal}`,
      details,
    );
  }

  if (
    ctx.outputFormat === "stream-json" &&
    result.exitCode === 0 &&
    (result.rawEvents?.length ?? 0) === 0
  ) {
    return new KimiError(
      "cli_shape_error",
      "stream-json requested but no parseable events in stdout",
      details,
    );
  }

  if (
    typeof result.exitCode === "number" &&
    result.exitCode !== 0 &&
    result.killedBy === "completed"
  ) {
    return new KimiError(
      "cli_exit_nonzero",
      `kimi CLI exited with code ${result.exitCode}`,
      details,
    );
  }

  return null;
}

function matchesAuthFailure(
  stderr: string,
  patterns: ReadonlyArray<RegExp> | undefined,
): boolean {
  if (!patterns || patterns.length === 0 || stderr.length === 0) return false;
  return patterns.some((re) => re.test(stderr));
}

function buildDetails(result: KimiResult, ctx: ClassifyContext): KimiErrorDetails {
  return {
    stdout_excerpt: truncateExcerpt(result.stdout),
    stderr_excerpt: truncateExcerpt(result.stderr),
    argv_redacted: redactArgv(ctx.argv, ctx.secrets),
    duration_ms: result.durationMs,
  };
}

function truncateExcerpt(s: string): string {
  if (Buffer.byteLength(s, "utf8") <= EXCERPT_CAP_BYTES) return s;
  const head = Buffer.from(s, "utf8").subarray(0, EXCERPT_CAP_BYTES).toString("utf8");
  return `${head}\n\n[truncated: excerpt exceeded ${EXCERPT_CAP_BYTES} bytes]`;
}

function redactArgv(argv: ReadonlyArray<string>, secrets: ReadonlyArray<string>): string[] {
  if (secrets.length === 0) return [...argv];
  const filtered = secrets.filter((s) => typeof s === "string" && s.length >= 4);
  return argv.map((arg) => (filtered.includes(arg) ? REDACTED : arg));
}
