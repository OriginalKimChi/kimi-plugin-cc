# P0-D — Security guards (env allowlist, output caps, kill ladder, TOCTOU)

## Threat model (per the Codex + Kimi reviews)

The `kimi` CLI is treated as **untrusted from a confidentiality standpoint**: it's an LLM-driven code execution engine running on the user's machine. We're not sandboxing arbitrary malicious code — we trust the binary not to be hostile — but we DO want to:

- Not leak the parent Claude/git/SSH/cloud credentials into it.
- Not let its output overrun the MCP transport (DoS the host process or hide control sequences in logs).
- Cleanly kill it when it hangs or runs past a timeout.
- Defend against trivial path tricks the caller might attempt.

These guards apply to **every** kimi-CLI subprocess (analyze, query, implement, review, resume).

---

## 1. Environment allowlist

### Rule

Spawn the kimi CLI with `env: { ...allowlist }` only. Never pass `process.env` directly. Never inherit.

### Allowlist (v1)

| Variable | Source | Why |
|---|---|---|
| `PATH` | minimum: `/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:${HOME}/.local/bin` (Mac) | so `kimi` resolves |
| `HOME` | parent `HOME` | needed by CLI for config / keyring |
| `LANG`, `LC_ALL` | parent value if set, else `en_US.UTF-8` | UTF-8 output |
| `KIMI_CODE_API_KEY` | `${user_config.kimi_code_api_key}` | auth (recommended) |
| `MOONSHOT_API_KEY` | `${user_config.moonshot_api_key}` | auth (fallback) |
| `KIMI_PLUGIN_VERSION` | injected by server | observability / debugging |

### Explicitly stripped (even if present in parent env)

`GITHUB_TOKEN`, `GH_TOKEN`, `NPM_TOKEN`, `AWS_*`, `GOOGLE_APPLICATION_CREDENTIALS`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_*`, `SSH_AUTH_SOCK`, `SSH_AGENT_PID`, anything matching `/_TOKEN$|_KEY$|_SECRET$/i` not in the allowlist.

### Implementation

```ts
function buildSubprocessEnv(): NodeJS.ProcessEnv {
  const allow = ["PATH", "HOME", "LANG", "LC_ALL"];
  const out: NodeJS.ProcessEnv = {};
  for (const k of allow) {
    if (process.env[k]) out[k] = process.env[k];
  }
  if (!out.PATH) out.PATH = "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin";
  if (!out.LANG) out.LANG = "en_US.UTF-8";
  const auth = process.env.KIMI_CODE_API_KEY || process.env.MOONSHOT_API_KEY;
  if (process.env.KIMI_CODE_API_KEY) out.KIMI_CODE_API_KEY = process.env.KIMI_CODE_API_KEY;
  if (process.env.MOONSHOT_API_KEY) out.MOONSHOT_API_KEY = process.env.MOONSHOT_API_KEY;
  out.KIMI_PLUGIN_VERSION = PLUGIN_VERSION;
  return out;
}
```

---

## 2. Output caps + control-char scrub

### Rule

Each subprocess has hard byte caps on **both** stdout and stderr. Past the cap, the stream is truncated with a marker and the process is killed (see kill ladder).

| Stream | Cap (v1) | After cap |
|---|---|---|
| stdout | 4 MB per call | truncate + append `\n\n[truncated: stdout exceeded 4 MB]` + SIGTERM |
| stderr | 1 MB per call | truncate + append `\n\n[truncated: stderr exceeded 1 MB]` + SIGTERM |

### Control-character scrub (applied before returning to MCP client)

- Strip ANSI CSI sequences: `/\x1b\[[0-?]*[ -/]*[@-~]/g`
- Strip ANSI OSC sequences: `/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g`
- Strip raw `\x00`-`\x08`, `\x0b`-`\x1f`, `\x7f` (preserve `\t`, `\n`, `\r`)
- Reject any string that, after scrub, still contains unrenderable bytes — return as base64 with a `binary_truncated: true` flag.

### Why

- DoS: an LLM that loops can generate gigabytes. We don't want the MCP transport's JSON-RPC reader to choke.
- Log injection: ANSI escapes can hide / rewrite later lines in a terminal log.
- Security review evasion: scrubbing happens **before** redaction, so a control-char-encoded token can't sneak past the redactor.

---

## 3. Timeouts + kill ladder

### Per-tool timeouts (v1)

| Tool | Default | Override |
|---|---|---|
| `kimi_status` | 5 s | not user-configurable |
| `kimi_query` | 120 s | `timeout_seconds` arg, capped at 300 |
| `kimi_analyze` | 300 s | `timeout_seconds` arg, capped at 600 |
| `kimi_review` | 300 s | same |
| `kimi_implement` | 600 s | same, capped at 1200 |
| `kimi_resume` | 300 s | same |

### Kill ladder

```
T+timeout:        SIGTERM
T+timeout+5s:     SIGINT
T+timeout+10s:    SIGKILL
T+timeout+15s:    abandon (subprocess.unref()) + log warning
```

Implement with `setTimeout` chained on the prior signal's exit handler.

---

## 4. TOCTOU defense

For any path argument (`work_dir`, `worktree_path`, `base_repo`, `files_glob`):

1. Resolve `realpath` once during validation.
2. Reject relative paths, paths containing `..` after resolution that escape the allowed root, symlinks pointing outside HOME, and any path with NUL bytes.
3. Pass the **resolved** path to the subprocess, not the original.
4. Immediately before `spawn()`, re-resolve `realpath` and compare to step 1. Abort if changed.
5. Reject paths whose resolved form is under `/Volumes/`, `/private/var/folders/`, `/tmp/...` unless explicitly opted in (these are common races against external storage).

---

## 5. Log redaction

Server logs (stderr of the MCP server itself, not the subprocess) MUST redact:

- Any string that equals or contains `process.env.KIMI_CODE_API_KEY` or `MOONSHOT_API_KEY` (use case-insensitive substring match on the raw values, replace with `***REDACTED***`).
- Any value of an env var whose name matches `/_TOKEN$|_KEY$|_SECRET$/i`.
- The full env block of the spawned subprocess: log only the keys, never the values.

Redaction runs on the final string before write, after control-char scrub.

---

## 6. Resource limits (POSIX, best-effort)

Apply on macOS/Linux via `process_options.detached: false` + `rlimit` from `posix` package — if not available, document the gap and skip.

| Limit | Value |
|---|---|
| `RLIMIT_AS` (virtual mem) | 4 GB |
| `RLIMIT_CPU` | timeout + 60 s |
| `RLIMIT_NOFILE` | 1024 |
| `RLIMIT_NPROC` | 256 |

Out of scope for v1 if `posix` isn't a comfortable dep — track as a known gap.

---

## Test cases (TDD: write before implementation)

- env allowlist: `GITHUB_TOKEN` present in parent env → subprocess does not see it (assertable via a fixture binary that echoes `process.env`)
- output cap stdout: subprocess emits 5 MB → server returns truncated result + truncation marker, subprocess is killed
- output cap stderr: subprocess emits 2 MB to stderr → same
- ANSI scrub: subprocess emits `\x1b[2J` → stripped from response
- raw control bytes: subprocess emits `\x00\x07` → stripped
- timeout: subprocess sleeps 10 s with timeout=2 s → SIGTERM at T+2, SIGKILL at T+12, returned error includes `timed_out: true`
- TOCTOU: `realpath` valid at validate, swapped to symlink before spawn → spawn aborts
- log redaction: API key present in error message → written as `***REDACTED***`
- path with NUL byte → rejected
