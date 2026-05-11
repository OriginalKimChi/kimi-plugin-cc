# P0-E — Auth bootstrap UX

## Problem

The kimi CLI authenticates by reading an API key. The legacy flow is:

1. Run `kimi` interactively on first install.
2. CLI prompts for the API key, stores it (typically `~/.config/kimi-cli/` or similar).
3. Subsequent CLI invocations read the stored key.

This works for a human at a terminal but **breaks for a stdio MCP server**: Claude Code spawns the server, the server spawns `kimi`, the CLI tries to prompt → there's no terminal, the call hangs, and Claude Code eventually times out the tool.

We must replace the interactive bootstrap with a non-interactive flow that:

- Asks the user for keys at install time (via Claude Code's `userConfig`).
- Stores them securely (keychain, via `sensitive: true`).
- Passes them to the kimi CLI as environment variables on every invocation.
- Handles two keys (Kimi Code recommended, Moonshot fallback) cleanly.
- Surfaces clear errors when both are missing.

## Two key types — user's directive

| Key | Source | Role |
|---|---|---|
| **`kimi_code_api_key`** | kimi.moonshot.cn — Kimi Code product key | **Recommended.** Used first. |
| **`moonshot_api_key`** | platform.moonshot.cn — generic Moonshot platform key | Fallback if Kimi Code key is missing. |

If both are set, **Kimi Code wins**. If neither is set, all tools except `kimi_status` return a structured error (no CLI call).

## Manifest (already in place from P0-B)

```jsonc
"userConfig": {
  "kimi_code_api_key": {
    "type": "string",
    "title": "Kimi Code API key",
    "description": "Recommended. Get one at kimi.moonshot.cn. Stored in the OS keychain.",
    "sensitive": true,
    "required": false
  },
  "moonshot_api_key": {
    "type": "string",
    "title": "Moonshot API key (fallback)",
    "description": "Alternative. Generic Moonshot platform API key. Stored in the OS keychain.",
    "sensitive": true,
    "required": false
  }
}
```

Both `required: false` so the user can install and run `kimi_status` to verify wiring before committing a key.

## Runtime flow

```
1.  Claude Code installs the plugin.
2.  Claude Code prompts the user for `kimi_code_api_key` and `moonshot_api_key` (sensitive → keychain).
3.  When Claude Code spawns the MCP server, it injects the two values as env vars per `mcpServers.env`.
4.  The MCP server, on startup, picks the preferred key:
       preferred = KIMI_CODE_API_KEY ?? MOONSHOT_API_KEY ?? null
5.  For each subprocess spawn (per P0-D allowlist):
       - If preferred is null and the tool is anything other than `kimi_status`, return:
           { error: "auth_missing", message: "...", remediation_url: "..." }
       - Else, pass both KIMI_CODE_API_KEY and MOONSHOT_API_KEY through to the kimi CLI.
6.  The kimi CLI reads whichever env var it expects. If the CLI only knows one env var name, the server maps:
       - prefer KIMI_CODE_API_KEY into whatever env var the CLI actually reads (e.g., MOONSHOT_API_KEY=<kimi_code_value>)
       - the exact CLI-side env var name is captured in the P0-F golden-transcript pass and locked into the adapter (P0-G).
```

## What we explicitly do NOT do

- **No interactive prompting from the MCP server.** Ever.
- **No `kimi auth login` subprocess call during plugin startup.** The CLI may store a key in `~/.config/kimi-cli/`, but we ignore that path entirely and rely only on env vars.
- **No fallback to reading the existing kimi-cli config file.** That's the legacy install's storage and we don't want our plugin's behavior to drift based on it.
- **No env var passthrough beyond the two API keys.** See P0-D allowlist.

## Edge cases

| Case | Behavior |
|---|---|
| User installs plugin, skips both prompts | `kimi_status` returns ok with `preferred: "none"`. Other tools return `auth_missing` error. |
| User updates one key via Claude Code | Server restart picks up new value (Claude Code reinjects env on server restart). |
| Key is invalid (kimi CLI returns auth error) | Server returns the kimi CLI's auth error verbatim, prefixed with `auth_invalid:`. Logs key fingerprint (first 4 chars + length), never the full key. |
| Kimi Code key set, but call fails with auth error | Server does NOT auto-fall-back to Moonshot key (silent fallback hides which key is broken). User must clear Kimi Code key in `userConfig` to use Moonshot. |
| Both keys set, both invalid | Server reports both attempts and which one was tried first (Kimi Code). |

## Open questions (resolve in P0-F when probing the CLI)

1. What env var name does the `kimi` CLI actually read? `KIMI_API_KEY`? `MOONSHOT_API_KEY`? Different per subcommand? — captured in golden transcript.
2. Does the CLI have a `--api-key` flag that bypasses env entirely? If so, prefer flag over env to avoid leaking the key into the CLI's child processes.
3. Is there a way to ask the CLI "is the key valid?" without burning a real model call? — needed for `kimi_status` to optionally report `auth_valid: true|false`.

## Test cases (TDD)

- Both env vars unset, call `kimi_query` → returns `auth_missing` error, never spawns subprocess.
- Both env vars unset, call `kimi_status` → returns ok with `preferred: "none"`.
- Only `MOONSHOT_API_KEY` set → `preferred: "moonshot"`, subprocess receives env.
- Both set → `preferred: "kimi_code"`, both env vars are forwarded to subprocess.
- Invalid key, CLI returns auth error → server returns `auth_invalid:<cli message>`.
- Server logs an error → API key value is replaced with `***REDACTED***` (key length and first 4 chars logged separately for debugging).
