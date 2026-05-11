import path from "node:path";
import type { KimiInvocation } from "./types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function buildArgv(inv: KimiInvocation): string[] {
  if (inv.prompt.length === 0) {
    throw new Error("prompt: must be a non-empty string");
  }
  if (inv.sessionId !== undefined && !UUID_RE.test(inv.sessionId)) {
    throw new Error(`sessionId: must be a UUID v4, got ${JSON.stringify(inv.sessionId)}`);
  }
  if (inv.workDir !== undefined && !path.isAbsolute(inv.workDir)) {
    throw new Error(`workDir: must be an absolute path, got ${JSON.stringify(inv.workDir)}`);
  }
  if (inv.addDirs) {
    for (const dir of inv.addDirs) {
      if (!path.isAbsolute(dir)) {
        throw new Error(`addDirs: each entry must be an absolute path, got ${JSON.stringify(dir)}`);
      }
    }
  }
  if (inv.outputFormat === "stream-json" && inv.finalMessageOnly === true) {
    throw new Error("--final-message-only cannot combine with --output-format stream-json");
  }
  if (inv.thinking && inv.noThinking) {
    throw new Error("thinking and noThinking are mutually exclusive");
  }
  if (inv.configFile !== undefined && !path.isAbsolute(inv.configFile)) {
    throw new Error(`configFile: must be an absolute path, got ${JSON.stringify(inv.configFile)}`);
  }

  const argv: string[] = [];

  if (inv.outputFormat === "text" && inv.finalMessageOnly) {
    argv.push("--quiet");
  } else {
    argv.push("--print", "--output-format", inv.outputFormat);
  }

  if (inv.workDir) argv.push("--work-dir", inv.workDir);
  if (inv.addDirs) {
    for (const dir of inv.addDirs) argv.push("--add-dir", dir);
  }
  if (inv.sessionId) argv.push("-r", inv.sessionId);
  if (inv.maxStepsPerTurn !== undefined) {
    argv.push("--max-steps-per-turn", String(inv.maxStepsPerTurn));
  }
  if (inv.model) argv.push("-m", inv.model);
  if (inv.thinking) argv.push("--thinking");
  if (inv.noThinking) argv.push("--no-thinking");
  if (inv.configFile) argv.push("--config-file", inv.configFile);

  argv.push(inv.prompt);
  return argv;
}
