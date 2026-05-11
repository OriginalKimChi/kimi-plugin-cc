# P0-E — Auth bootstrap UX (revised after P0-F)

> **Revision note (2026-05-11):** The original P0-E assumed the `kimi` CLI reads `KIMI_CODE_API_KEY` / `MOONSHOT_API_KEY` env vars. P0-F probing showed this is **false** for kimi-cli 1.41.0 — auth lives in `~/.kimi/credentials/` (OAuth) and the `[providers."managed:kimi-code"].api_key` field of `~/.kimi/config.toml`. The flow below replaces the original.

## Authoritative auth surface (per P0-F)

1. **OAuth (default, recommended)** — user runs `kimi login` once in a terminal. CLI saves a token to `~/.kimi/credentials/kimi-code.json` and reuses it for all future invocations.
2. **API key (alternative)** — user pastes a key into the `api_key` field of `~/.kimi/config.toml`. The CLI reads it on each invocation.
3. **No env-var path.** Confirmed empirically.

Two CLI options let us inject auth without mutating the user's main config:
- `--config <TOML/JSON-string>` — small overrides inline
- `--config-file <FILE>` — replacement config file

## Recommended UX for our plugin

The plugin **does not handle auth itself**. It assumes the user has already authenticated `kimi` on this machine. Our role is:

1. At install time, **point the user at `kimi login`** via plugin description and post-install message.
2. At every tool call, before spawning the CLI, **probe auth state once and cache** (TTL 60 s). If not authed → return a structured error with the remediation command.
3. Provide an optional override path for advanced users: `userConfig.kimi_code_api_key` (sensitive). When set, the plugin writes a private one-call config to a 0600 temp file and invokes `kimi --config-file <tempfile>`.

### Manifest (revised `userConfig`)

```jsonc
"userConfig": {
  "kimi_code_api_key": {
    "type": "string",
    "title": "Kimi Code API key (optional override)",
    "description": "Leave empty if you ran `kimi login` already (recommended). Only set this if you prefer a static API key over OAuth. Stored in OS keychain.",
    "sensitive": true,
    "required": false
  },
  "moonshot_api_key": {
    "type": "string",
    "title": "Moonshot API key (fallback)",
    "description": "Alternative if Kimi Code key unavailable. Stored in OS keychain.",
    "sensitive": true,
    "required": false
  }
}
```

Both keys are still optional. The plugin works on a freshly-`kimi login`'d machine with both keys empty.

## Auth probe (every cold start, cached 60 s)

```ts
async function probeAuth(): Promise<AuthState> {
  // 1. If user_config.kimi_code_api_key is set → state = "user_config_override"
  // 2. Else if ~/.kimi/credentials/kimi-code.json exists and is readable → state = "oauth"
  // 3. Else if ~/.kimi/config.toml has non-empty api_key for managed:kimi-code → state = "config_file"
  // 4. Else → state = "missing"
}
```

`kimi_status` returns this state directly. All other tools refuse to spawn when `state === "missing"` and return:

```json
{
  "error": "auth_missing",
  "message": "kimi CLI is not authenticated on this machine.",
  "remediation": "Run `kimi login` in a terminal, then retry. Or set kimi_code_api_key in the plugin's userConfig."
}
```

## API key injection (when `kimi_code_api_key` is set in userConfig)

Per call:

1. Write a temp file `${os.tmpdir()}/kimi-plugin-<random>.toml` with mode `0600`:
   ```toml
   [providers."managed:kimi-code"]
   api_key = "<user_config.kimi_code_api_key>"
   ```
2. Spawn `kimi --config-file <tempfile> --quiet --max-steps-per-turn N <prompt>`.
3. Unconditionally `fs.unlink` the temp file in a `finally` block. Log only the file path, never the contents.
4. The temp file MUST NOT live in `~/.kimi/`; that's the user's own config namespace.

`moonshot_api_key` behaves the same but the temp config has the key inside the appropriate Moonshot provider stanza. Confirm the stanza shape by reading the user's existing `~/.kimi/config.toml` once at plugin startup. If the shape can't be inferred, fall back to OAuth-only and warn.

## What changed from the original P0-E

| Original assumption | Replaced by |
|---|---|
| CLI reads `KIMI_CODE_API_KEY` env | CLI reads `~/.kimi/credentials/` (OAuth) or `~/.kimi/config.toml` `api_key` field |
| userConfig is the primary auth path | OAuth via `kimi login` is the primary auth path; userConfig is an override |
| Env injection | `--config-file <tempfile>` injection |
| Server forwards env keys to subprocess | Server creates a 0600 temp config file, invokes with `--config-file`, unlinks immediately after |

## What we explicitly do NOT do

- **No silent fallback Kimi-Code → Moonshot.** If the user sets Kimi-Code and it fails, return that failure verbatim; don't try Moonshot.
- **No mutation of `~/.kimi/config.toml`.** That's the user's namespace.
- **No reading of the user's stored OAuth token.** We don't need to — we let the CLI handle that.
- **No interactive prompting from the MCP server.** Ever.

## Test cases (TDD)

- ~/.kimi/credentials/kimi-code.json exists, no userConfig keys → probe = `oauth`; all tools run.
- credentials file missing, config.toml api_key empty, no userConfig → probe = `missing`; non-status tools error out.
- userConfig.kimi_code_api_key set, OAuth file missing → probe = `user_config_override`; temp config file written 0600 and unlinked after call.
- Temp config file leaks (process crash) → next startup detects orphans in tmpdir matching `kimi-plugin-*.toml` and deletes any older than 1 minute.
- Both userConfig keys set → kimi_code wins (no silent fallback).
- userConfig key contains `\n` or NUL → reject at validation, never write to disk.
