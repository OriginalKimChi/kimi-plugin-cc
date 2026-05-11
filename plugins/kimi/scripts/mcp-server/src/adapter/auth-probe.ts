import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export type AuthState = "env" | "oauth" | "config_file" | "missing";

export type AuthSource = "kimi_code" | "moonshot" | null;

export interface AuthProbeInput {
  env: NodeJS.ProcessEnv;
  home: string;
}

export interface AuthProbeResult {
  state: AuthState;
  source: AuthSource;
  /** When state==='oauth' or 'config_file', the absolute path that signaled auth. */
  evidence: string | null;
}

const MANAGED_SECTION = 'providers."managed:kimi-code"';

export function probeAuth(input: AuthProbeInput): AuthProbeResult {
  // 1. env wins
  if (typeof input.env.KIMI_CODE_API_KEY === "string" && input.env.KIMI_CODE_API_KEY.length > 0) {
    return { state: "env", source: "kimi_code", evidence: null };
  }
  if (typeof input.env.MOONSHOT_API_KEY === "string" && input.env.MOONSHOT_API_KEY.length > 0) {
    return { state: "env", source: "moonshot", evidence: null };
  }

  // 2. OAuth credentials file — only when home is an absolute path; otherwise
  // we'd accidentally probe cwd-relative paths and pick up unrelated files.
  if (!path.isAbsolute(input.home) || input.home.length === 0) {
    return { state: "missing", source: null, evidence: null };
  }
  const oauthFile = path.join(input.home, ".kimi", "credentials", "kimi-code.json");
  if (isReadableFile(oauthFile)) {
    return { state: "oauth", source: "kimi_code", evidence: oauthFile };
  }

  // 3. config.toml api_key under managed:kimi-code
  const configToml = path.join(input.home, ".kimi", "config.toml");
  if (isReadableFile(configToml)) {
    const apiKey = readManagedApiKey(configToml);
    if (apiKey !== null && apiKey.length > 0) {
      return { state: "config_file", source: "kimi_code", evidence: configToml };
    }
  }

  return { state: "missing", source: null, evidence: null };
}

function isReadableFile(p: string): boolean {
  try {
    if (!existsSync(p)) return false;
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function readManagedApiKey(tomlPath: string): string | null {
  let content: string;
  try {
    content = readFileSync(tomlPath, "utf8");
  } catch {
    return null;
  }
  const lines = content.split(/\r?\n/);
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      const header = line.slice(1, -1).trim();
      inSection = header === MANAGED_SECTION;
      continue;
    }
    if (!inSection) continue;
    const m = /^api_key\s*=\s*"([^"]*)"\s*$/.exec(line);
    if (m !== null) {
      return m[1]!;
    }
  }
  return null;
}
