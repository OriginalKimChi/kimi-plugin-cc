# kimi-plugin-cc

> **Status: 🚧 0.0.1 packaging spike.** Only the `kimi_status` health tool is wired up. This is for verifying that the Claude Code plugin manifest, MCP server binding, and `userConfig` shape all work end-to-end. No real Kimi calls yet.

Unofficial Claude Code plugin that exposes the Kimi (Moonshot) coding model as MCP tools. Not affiliated with Moonshot AI.

## Spike scope

- ✅ `marketplace.json` + `plugin.json` with inline `mcpServers`
- ✅ `userConfig` for two API keys (Kimi Code recommended, Moonshot fallback) — `sensitive: true`, stored in the OS keychain
- ✅ Single TypeScript MCP server, bundled to a single `dist/index.cjs` (no user-side `npm install`)
- ✅ One health tool: `kimi_status`
- ❌ No real Kimi tool calls yet (analyze/query/implement/review/resume come in later milestones)

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
#   Then provide kimi_code_api_key (or moonshot_api_key as fallback) when prompted.
#
# Verify:
#   The kimi_status MCP tool should return state=ok and report which API key is present.
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
