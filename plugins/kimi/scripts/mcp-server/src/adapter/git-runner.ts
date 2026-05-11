import { buildSubprocessEnv } from "./security.js";
import { runSubprocess, type SubprocessResult } from "./subprocess-runner.js";

const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const GIT_STDOUT_CAP_BYTES = 16 * 1024 * 1024;
const GIT_STDERR_CAP_BYTES = 4 * 1024 * 1024;

export interface ExecuteGitOptions {
  cwd: string;
  args: ReadonlyArray<string>;
  timeoutMs?: number;
  binary?: string;
  parentEnv?: NodeJS.ProcessEnv;
  pluginVersion?: string;
}

export interface ExecuteGitResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
}

export async function executeGit(opts: ExecuteGitOptions): Promise<ExecuteGitResult> {
  const env = buildSubprocessEnv({
    parentEnv: opts.parentEnv ?? process.env,
    pluginVersion: opts.pluginVersion ?? "git-runner",
  });
  const sub: SubprocessResult = await runSubprocess({
    command: opts.binary ?? "git",
    argv: ["-C", opts.cwd, ...opts.args],
    env,
    timeoutMs: opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    stdoutCapBytes: GIT_STDOUT_CAP_BYTES,
    stderrCapBytes: GIT_STDERR_CAP_BYTES,
  });
  return {
    stdout: sub.stdout,
    stderr: sub.stderr,
    exitCode: sub.exitCode,
    signal: sub.signal,
    durationMs: sub.durationMs,
  };
}

export type ExecuteGit = typeof executeGit;
