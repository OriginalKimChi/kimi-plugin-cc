# P0-F — CLI probe + clean-room provenance

## Summary

Captured `kimi` CLI 1.41.0 behaviour into `docs/fixtures/cli-probe/`. See [that README](../fixtures/cli-probe/README.md) for the full inventory and findings.

## What changed in the plan as a result

| Spec | What we now know that we didn't before | Action |
|---|---|---|
| P0-E (auth) | CLI reads `~/.kimi/credentials/` + `~/.kimi/config.toml`. **Does NOT read env vars** for auth. | Rewrite P0-E — pivot to `--config-file` injection or pass-through-to-existing-OAuth. See updated P0-E spec. |
| P0-G (adapter) | stream-json output is mixed with a trailing non-JSON `To resume…` line. Session IDs are UUIDv4. `--quiet` = `--print --output-format text --final-message-only`. | Adapter must: split off the trailing line, parse JSON lines (newline-delimited), accept UUID session IDs. |
| P0-D (security) | `--max-steps-per-turn` is a built-in CLI cap → defense-in-depth alongside our timeouts. | Pass an explicit `--max-steps-per-turn` on every call. |
| All tools | The CLI is one binary with options + an optional prompt arg. No per-tool subcommand. Our 5 MCP tools all reduce to different combinations of `--work-dir`, `--session`, `--quiet`, and the prompt content. | Adapter design becomes simpler: one "kimi runner" function with a small options struct. |

## What we explicitly do NOT plan to use

- `kimi mcp` (manages MCP **clients**, not a server we can consume)
- `kimi acp` (different protocol)
- `kimi term` / `kimi web` / `kimi vis` (interactive UIs)
- `kimi plugin` (manages CLI plugins; orthogonal to our Claude Code plugin)

## CLI → MCP tool mapping (locked in by this probe)

| MCP tool | CLI invocation |
|---|---|
| `kimi_status` | none — server reports its own state; optionally `kimi info` to assert binary is present |
| `kimi_query` | `kimi --quiet --max-steps-per-turn <N>` + prompt on stdin or arg. No `--work-dir`. |
| `kimi_analyze` | `kimi --quiet --work-dir <abs> [--add-dir <abs>...] --max-steps-per-turn <N>` + prompt |
| `kimi_review` | same as analyze, with the prompt template baked to a review framing |
| `kimi_implement` | same as analyze, but `--work-dir <worktree>` per P0-C enforcement, and `--max-steps-per-turn` higher |
| `kimi_resume` | `kimi --quiet -r <session_id> --max-steps-per-turn <N>` + prompt |

The MCP server returns `session_id` (parsed from the trailing line) for every call, so the caller can resume.
