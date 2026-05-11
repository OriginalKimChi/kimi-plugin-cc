# CLI probe — clean-room behavioural observation

Captured to lock in what `kimi` CLI 1.41.0 looks like *before* any plugin code is written. This is the provenance trail for the clean-room rewrite: we observed CLI **behaviour**, not source.

## Provenance

- Probe timestamp (UTC): see `meta.txt` line 1
- Probed binary: `/Users/hwan/.local/bin/kimi` (uv tool installed `kimi-cli` 1.41.0)
- Probed by: OriginalKimChi (sole consumer)
- Host: macOS Darwin 25.3.0
- Python runtime (inside CLI): 3.13.13
- Wire protocol: 1.9
- Agent spec versions: 1

## Files

| File | Content |
|---|---|
| `meta.txt` | `kimi --version` + `kimi info` |
| `help-top.txt` | Full `kimi --help` |
| `subcommand-helps.txt` | `kimi <subcmd> --help` for all 11 subcommands (login, logout, info, export, mcp, plugin, acp, term, web, vis, ...) |
| `sample-stream-json.txt` | One `--output-format stream-json` invocation (simple math query) |
| `sample-resume.txt` | Resume via `-r <session_id>` (continuation of the above) |

## Key behaviour findings (locked-in contract for the MCP adapter)

1. **Invocation shape**: `kimi [OPTIONS] [<prompt-arg>]` — interactive by default; non-interactive with `--print` or `--quiet`. `--quiet` is an alias for `--print --output-format text --final-message-only`.

2. **stdin or arg prompt**: prompt can be passed as the final positional arg OR piped via stdin. Both work in `--print` mode.

3. **`--output-format`**: `text` (default, plain assistant message) or `stream-json` (one JSON object per line — observed: `{"role":"assistant","content":"..."}`).

4. **Trailing session marker on stdout**: every non-interactive invocation ends with a non-JSON line:
   ```
   To resume this session: kimi -r <UUID>
   ```
   This is NOT part of the JSON stream. The adapter must split it off before parsing.

5. **Session ID format**: UUID v4 — `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`. Our `session_id` regex `^[A-Za-z0-9_-]+$` accepts this.

6. **Resume**: `kimi -r <id>` (alias `--session`/`--resume`). Same ID is reused across calls.

7. **Step caps**: `--max-steps-per-turn <N>` is enforced. Useful as a defense-in-depth alongside our timeouts.

8. **Working directory**: `--work-dir <DIR>` (alias `-w`). Defaults to cwd. `--add-dir` adds extra scope dirs (repeatable).

9. **Auth — NOT via env**: CLI reads `~/.kimi/credentials/<provider>.json` (OAuth tokens) and `~/.kimi/config.toml` (`api_key` field). Env vars (`KIMI_*`, `MOONSHOT_*`) are NOT consulted by the CLI (confirmed empirically — the CLI works with both unset). This **invalidates the original P0-E plan** of "inject env vars from userConfig". See updated P0-E.

10. **`--config-file <FILE>`** and **`--config <TOML/JSON-string>`** options exist. These should let us inject auth without touching the user's main `~/.kimi/config.toml`.

11. **Default model**: `kimi-code/kimi-for-coding` (display name "Kimi-k2.6"). Provider type `kimi`, base URL `https://api.kimi.com/coding/v1`.

12. **`kimi mcp` subcommand exists** — CLI itself can act as an MCP client (manages MCP server configs to connect to). NOT an MCP server mode for us to consume. Out of scope.

13. **`kimi acp` subcommand** — Runs an ACP server. ACP ≠ MCP. Not relevant for our plugin.

## What we deliberately did NOT capture (and why)

| Skipped fixture | Reason |
|---|---|
| Auth-failure transcript | Can be synthesized in tests by pointing `--config-file` at an empty config. No need for a real failed call. |
| Timeout transcript | Synthesizable in tests by spawning `sleep` and applying our own kill ladder. |
| Malformed-output transcript | Synthesizable by feeding garbage to the adapter's parser directly. |
| Huge-output transcript | Wasteful of API tokens. Generate synthetic 5 MB stdout in tests. |

This keeps the API token cost of the probe near zero while still giving the adapter enough surface to unit-test against.

## Clean-room status

- We did NOT read the source of `howardpen9/kimi-code-mcp` while authoring this probe or any downstream code.
- We DID observe CLI behaviour (--help text, stdout shape, exit codes).
- The fixtures here are our own captures. They are derivative of the `kimi` CLI itself, not of any prior third-party wrapper.
- The CLI's `--help` text is © Moonshot AI; we redistribute small excerpts here for interoperability documentation (fair-use style, like an SDK author copying signature lines from a vendor's docs).
