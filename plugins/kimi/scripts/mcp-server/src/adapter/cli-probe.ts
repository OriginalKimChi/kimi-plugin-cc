import {
  CLI_COMPAT,
  parseKimiVersion,
  selectCompatEntry,
  type CompatEntry,
} from "./compat-table.js";
import { KimiError } from "./errors.js";
import { buildSubprocessEnv } from "./security.js";
import {
  runSubprocess,
  type SubprocessOptions,
  type SubprocessResult,
} from "./subprocess-runner.js";

export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export interface ProbeContext {
  parentEnv: NodeJS.ProcessEnv;
  pluginVersion: string;
  binary?: string;
  _runSubprocess?: (opts: SubprocessOptions) => Promise<SubprocessResult>;
}

export interface CliProbeResult {
  ok: boolean;
  version: string | null;
  rawStdout: string;
  rawStderr: string;
  entry: CompatEntry;
  unsupported: boolean;
  error?: KimiError;
}

export async function probeKimiVersion(
  ctx: ProbeContext,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<CliProbeResult> {
  const env = buildSubprocessEnv({
    parentEnv: ctx.parentEnv,
    pluginVersion: ctx.pluginVersion,
  });
  const spawn = ctx._runSubprocess ?? runSubprocess;

  let sub: SubprocessResult;
  try {
    sub = await spawn({
      command: ctx.binary ?? "kimi",
      argv: ["--version"],
      env,
      timeoutMs,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e && e.code === "ENOENT") {
      return {
        ok: false,
        version: null,
        rawStdout: "",
        rawStderr: "",
        entry: fallbackEntry(),
        unsupported: true,
        error: new KimiError(
          "cli_not_found",
          `kimi CLI binary not found on PATH: ${e.message}`,
          {
            stdout_excerpt: "",
            stderr_excerpt: "",
            argv_redacted: ["--version"],
            duration_ms: 0,
          },
        ),
      };
    }
    throw err;
  }

  const version = parseKimiVersion(sub.stdout);
  const entry = selectCompatEntry(version);
  const unsupported = !entry.supported;

  return {
    ok: sub.exitCode === 0 && version !== null && entry.supported,
    version,
    rawStdout: sub.stdout,
    rawStderr: sub.stderr,
    entry,
    unsupported,
  };
}

function fallbackEntry(): CompatEntry {
  const newest = CLI_COMPAT[CLI_COMPAT.length - 1]!;
  return { ...newest, supported: false };
}
