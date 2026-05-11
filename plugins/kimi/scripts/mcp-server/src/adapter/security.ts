const DEFAULT_PATH =
  "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:" +
  (process.env.HOME ? `${process.env.HOME}/.local/bin` : "");

const PASS_THROUGH_KEYS = ["PATH", "HOME", "LANG", "LC_ALL"] as const;

const AUTH_KEYS = ["KIMI_CODE_API_KEY", "MOONSHOT_API_KEY"] as const;
const AUTH_KEY_SET = new Set<string>(AUTH_KEYS);

const SECRET_SUFFIX = /(_TOKEN|_KEY|_SECRET)$/i;

export interface BuildSubprocessEnvOptions {
  parentEnv: NodeJS.ProcessEnv;
  pluginVersion: string;
}

export function buildSubprocessEnv(opts: BuildSubprocessEnvOptions): NodeJS.ProcessEnv {
  const { parentEnv, pluginVersion } = opts;
  const out: NodeJS.ProcessEnv = {};

  for (const key of PASS_THROUGH_KEYS) {
    const value = parentEnv[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  if (!out.PATH) out.PATH = DEFAULT_PATH;
  if (!out.LANG) out.LANG = "en_US.UTF-8";

  for (const key of AUTH_KEYS) {
    const value = parentEnv[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }

  out.KIMI_PLUGIN_VERSION = pluginVersion;
  return out;
}

const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
const RAW_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function scrubControlChars(input: string): string {
  if (input.length === 0) return input;
  return input
    .replace(ANSI_OSC, "")
    .replace(ANSI_CSI, "")
    .replace(RAW_CONTROL, "");
}

const MIN_SECRET_LENGTH = 4;
const REDACTION_PLACEHOLDER = "***REDACTED***";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactSecrets(input: string, secrets: ReadonlyArray<string>): string {
  if (input.length === 0) return input;
  let out = input;
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) continue;
    out = out.split(secret).join(REDACTION_PLACEHOLDER);
  }
  return out;
}

// Re-export rarely used internals for tests that want to assert allowlist composition.
export const __INTERNALS__ = {
  PASS_THROUGH_KEYS,
  AUTH_KEYS,
  SECRET_SUFFIX,
  REDACTION_PLACEHOLDER,
  MIN_SECRET_LENGTH,
} as const;

void AUTH_KEY_SET;
void SECRET_SUFFIX;
