# kimi-plugin-cc

> **Status: 🧪 0.0.1 — full adapter + 6 MCP tools, integration-verified against kimi-cli 1.41.0.** Not yet published.

Unofficial Claude Code plugin that exposes the Kimi (Moonshot) coding model as MCP tools. Not affiliated with Moonshot AI.

## Tools

| Tool | Purpose | Default timeout / cap |
|---|---|---|
| `kimi_status` | Health: plugin version, auth state (env / oauth / config_file / missing), CLI version + compat entry, CLI shape-drift counter | 5 s |
| `kimi_query` | Single read-only prompt → final assistant message. `output_format=stream-json` returns `raw_events` too. | 120 s / 300 s |
| `kimi_resume` | Resume an existing kimi session (`session_id` required) | 300 s / 600 s |
| `kimi_analyze` | Prompt focused on repo / code-area analysis | 300 s / 600 s |
| `kimi_review` | Prompt focused on diff / branch review | 300 s / 600 s |
| `kimi_implement` | Edit-capable task inside a **disposable git worktree**. Refuses the main checkout. Returns captured diff + files_changed. | 600 s / 1200 s |

## Adapter hardening (per P0-D / P0-E / P0-G)

- **Env allowlist + control-char scrub + secret redaction** on every spawn (PATH/HOME/LANG/auth keys only; ANSI / NUL stripped; API-key values redacted from stderr).
- **Output caps** (4 MiB stdout / 1 MiB stderr) with truncation markers and immediate kill.
- **Kill ladder**: SIGTERM → +5 s SIGINT → +10 s SIGKILL → +15 s abandon.
- **Path validation + TOCTOU recheck**: every path argument is `realpath`-resolved, constrained to optional `allowedRoots`, ephemeral roots (`/tmp`, `/Volumes`, `/private/var/folders`) blocked by default, and re-resolved immediately before spawn.
- **Worktree guard** (P0-C): `kimi_implement` rejects `worktree_path` equal to the main worktree, inside `base_repo`, dirty (unless `allow_dirty`), or already-existing on create.
- **Auth bootstrap** (P0-E): 4-state probe (`env` / `oauth` / `config_file` / `missing`). When env-based, the plugin writes a 0600 temp config file under `os.tmpdir()` and invokes `kimi --config-file <tempfile>` (unlinked in `finally`); never mutates `~/.kimi/config.toml`.
- **CLI shape-drift counter**: missing trailing markers or zero-event stream-json runs increment a counter surfaced via `kimi_status.cli.shape_drift`.

## Install (local development)

```bash
# clone
git clone https://github.com/OriginalKimChi/kimi-plugin-cc.git
cd kimi-plugin-cc/plugins/kimi/scripts/mcp-server

# build the bundled MCP server (only the author needs to do this)
npm install
npm run build       # → dist/index.cjs

# inside Claude Code, from a project:
#   /plugin marketplace add OriginalKimChi/kimi-plugin-cc
#   /plugin install kimi@originalkimchi-kimi
#   Either run `kimi login` once (recommended OAuth) OR provide
#   kimi_code_api_key in the plugin's userConfig.
#
# Verify:
#   The kimi_status MCP tool should return state=ok with auth.state=oauth | env | config_file.
```

## Development

```bash
cd plugins/kimi/scripts/mcp-server
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run (unit + adapter; integration suite auto-skips)
npm run build       # → dist/index.cjs
```

### Integration tests (opt-in)

The `tests/integration/` suite hits the real `kimi` CLI binary and consumes API
quota. It is **skipped by default**. To run it you need:

- `kimi` on your `PATH`
- Either `KIMI_CODE_API_KEY` or `MOONSHOT_API_KEY` set in the environment

```bash
KIMI_CODE_API_KEY=... npm run test:integration
```

The suite covers the P0-G smoke matrix: `kimi --version` parsing, a `kimi_query`
round-trip, and a `kimi_resume` reuse of the returned session_id.

## License

MIT — see [LICENSE](LICENSE).
