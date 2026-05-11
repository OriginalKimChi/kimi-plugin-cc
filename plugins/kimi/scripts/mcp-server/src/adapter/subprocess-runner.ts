import { spawn, type ChildProcess } from "node:child_process";

export type KilledBy =
  | "completed"
  | "timeout"
  | "stdout_cap"
  | "stderr_cap"
  | "caller";

export interface SubprocessOptions {
  command: string;
  argv: ReadonlyArray<string>;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  stdoutCapBytes?: number;
  stderrCapBytes?: number;
  cwd?: string;
  /** Test-only: shorten the kill ladder intervals. Defaults: 5s / 10s / 15s per P0-D. */
  _killLadderMs?: { sigint: number; sigkill: number; abandon: number };
}

export interface SubprocessResult {
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  truncated: { stdout: boolean; stderr: boolean };
  killedBy: KilledBy;
}

const DEFAULT_KILL_LADDER = { sigint: 5_000, sigkill: 10_000, abandon: 15_000 };

function truncationMarker(stream: "stdout" | "stderr", cap: number): string {
  return `\n\n[truncated: ${stream} exceeded ${cap} bytes]`;
}

export async function runSubprocess(opts: SubprocessOptions): Promise<SubprocessResult> {
  const start = Date.now();
  const stdoutCap = opts.stdoutCapBytes ?? Number.POSITIVE_INFINITY;
  const stderrCap = opts.stderrCapBytes ?? Number.POSITIVE_INFINITY;
  const ladder = opts._killLadderMs ?? DEFAULT_KILL_LADDER;

  const child = spawn(opts.command, [...opts.argv], {
    env: opts.env,
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const timeoutHandle = setTimeout(() => {
    scheduleKill("timeout");
  }, opts.timeoutMs);
  timeoutHandle.unref();

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let killedBy: KilledBy = "completed";
  let killScheduled = false;

  function scheduleKill(reason: KilledBy): void {
    if (killScheduled) return;
    killScheduled = true;
    killedBy = reason;
    if (!child.killed) child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed && child.exitCode === null) child.kill("SIGINT");
    }, ladder.sigint).unref();
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, ladder.sigkill).unref();
    setTimeout(() => {
      if (child.exitCode === null) {
        try {
          (child as ChildProcess).unref();
        } catch {
          /* ignore */
        }
      }
    }, ladder.abandon).unref();
  }

  child.stdout?.on("data", (chunk: Buffer) => {
    if (stdoutTruncated) return;
    const remaining = stdoutCap - stdoutBytes;
    if (chunk.length <= remaining) {
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
      return;
    }
    if (remaining > 0) {
      const head = chunk.subarray(0, remaining);
      stdoutChunks.push(head);
      stdoutBytes += head.length;
    }
    stdoutTruncated = true;
    scheduleKill("stdout_cap");
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderrTruncated) return;
    const remaining = stderrCap - stderrBytes;
    if (chunk.length <= remaining) {
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
      return;
    }
    if (remaining > 0) {
      const head = chunk.subarray(0, remaining);
      stderrChunks.push(head);
      stderrBytes += head.length;
    }
    stderrTruncated = true;
    scheduleKill("stderr_cap");
  });

  return new Promise<SubprocessResult>((resolve, reject) => {
    child.on("error", (err) => {
      clearTimeout(timeoutHandle);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeoutHandle);
      let stdout = Buffer.concat(stdoutChunks).toString("utf8");
      let stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (stdoutTruncated) {
        stdout += truncationMarker("stdout", stdoutCap);
      }
      if (stderrTruncated) {
        stderr += truncationMarker("stderr", stderrCap);
      }
      resolve({
        stdout,
        stderr,
        stdoutBytes,
        stderrBytes,
        exitCode: code,
        signal,
        durationMs: Date.now() - start,
        truncated: { stdout: stdoutTruncated, stderr: stderrTruncated },
        killedBy,
      });
    });
  });
}
