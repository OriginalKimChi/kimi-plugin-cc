import {
  probeAuth,
  type AuthSource,
  type AuthState,
} from "../adapter/auth-probe.js";
import {
  probeKimiVersion,
  type CliProbeResult,
} from "../adapter/cli-probe.js";

export type StatusState = "ok" | "degraded" | "missing";

export interface StatusAuth {
  state: AuthState;
  source: AuthSource;
  kimi_code_api_key_present: boolean;
  moonshot_api_key_present: boolean;
  preferred: "kimi_code" | "moonshot" | "none";
  remediation: string | null;
}

export interface StatusCli {
  binary: string;
  version: string | null;
  compat_entry: string | null;
  supported: boolean;
  unsupported: boolean;
  error: { code: string; message: string } | null;
}

export interface StatusPayload {
  plugin: "kimi";
  version: string;
  state: StatusState;
  node: string;
  plugin_root: string | null;
  auth: StatusAuth;
  cli: StatusCli;
}

export interface StatusContext {
  parentEnv: NodeJS.ProcessEnv;
  pluginVersion: string;
  pluginRoot: string | null;
  binary?: string;
  _probe?: () => Promise<CliProbeResult>;
}

export async function runStatusTool(ctx: StatusContext): Promise<StatusPayload> {
  const auth = buildAuth(ctx.parentEnv);

  const probe = ctx._probe
    ? await ctx._probe()
    : await probeKimiVersion({
        parentEnv: ctx.parentEnv,
        pluginVersion: ctx.pluginVersion,
        binary: ctx.binary,
      });

  const cli: StatusCli = {
    binary: ctx.binary ?? "kimi",
    version: probe.version,
    compat_entry: probe.entry.supported ? probe.entry.id : null,
    supported: probe.entry.supported,
    unsupported: probe.unsupported,
    error: probe.error
      ? { code: probe.error.code, message: probe.error.message }
      : null,
  };

  return {
    plugin: "kimi",
    version: ctx.pluginVersion,
    state: deriveState(auth, probe),
    node: process.version,
    plugin_root: ctx.pluginRoot,
    auth,
    cli,
  };
}

function buildAuth(env: NodeJS.ProcessEnv): StatusAuth {
  const kimi = Boolean(env.KIMI_CODE_API_KEY);
  const moonshot = Boolean(env.MOONSHOT_API_KEY);
  const auth = probeAuth({ env, home: env.HOME ?? "" });
  return {
    state: auth.state,
    source: auth.source,
    kimi_code_api_key_present: kimi,
    moonshot_api_key_present: moonshot,
    preferred: kimi ? "kimi_code" : moonshot ? "moonshot" : "none",
    remediation:
      auth.state === "missing"
        ? "Run `kimi login` in a terminal (recommended), or set KIMI_CODE_API_KEY / MOONSHOT_API_KEY in the environment."
        : null,
  };
}

function deriveState(auth: StatusAuth, probe: CliProbeResult): StatusState {
  if (auth.state === "missing") return "missing";
  if (probe.error?.code === "cli_not_found") return "missing";
  if (probe.unsupported || probe.version === null) return "degraded";
  return "ok";
}
