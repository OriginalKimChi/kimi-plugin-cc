# Changelog

All notable changes to this plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-05-13

### Added

- **`/kimi:setup` slash command** — probes whether the local `kimi` CLI is on
  `PATH` and whether `~/.kimi/credentials/kimi-code.json` is populated. Guides
  `uv tool install kimi-cli` when the CLI is missing (one `AskUserQuestion`
  prompt, no auto-install otherwise) and surfaces `!kimi login` when the user
  is unauthenticated. Mirrors the `/codex:setup` UX.
- **`/kimi:rescue` slash command** — delegates a substantial coding,
  investigation, or fix task to Kimi via the shared MCP runtime. Accepts
  `--read-only` (routes to `kimi_query`) and `--write` (routes to
  `kimi_implement`, the default). Forwards the raw user request verbatim and
  returns Kimi's response verbatim.
- **`kimi:kimi-rescue` subagent** — thin forwarder used by `/kimi:rescue`.
  Strips routing flags, calls exactly one MCP tool, returns the result as-is.
  Falls back to a single line pointing at `/kimi:setup` if Kimi is missing or
  unauthenticated.

## [0.1.0] — 2026-05-11

First release with a working tool surface and a hardened adapter. Integration-
verified against `kimi-cli` 1.41.0 on macOS.

### Added

- **6 MCP tools**, each backed by `runKimiSafe`:
  - `kimi_status` — plugin / auth / CLI version / shape-drift health payload.
  - `kimi_query` — single read-only prompt → final assistant message. Optional
    `output_format=stream-json` returns `raw_events` in `structuredContent`.
    120 s default / 300 s cap.
  - `kimi_resume` — resume an existing session by UUID. Same options as
    `kimi_query`. 300 s default / 600 s cap.
  - `kimi_analyze` — repo / code-area analysis prompts. 300 s / 600 s.
  - `kimi_review` — diff / branch review prompts. 300 s / 600 s.
  - `kimi_implement` — edit-capable task inside a **disposable git worktree**.
    Refuses the main checkout, paths inside `base_repo`, already-existing
    targets on create, and dirty existing worktrees unless `allow_dirty`.
    Returns captured diff + `files_changed` + `commit_sha` + `cleanup_status`.
    600 s / 1200 s.

- **P0-D security guards**:
  - Env allowlist (`PATH`, `HOME`, `LANG/LC_ALL`, `KIMI_CODE_API_KEY`,
    `MOONSHOT_API_KEY`, `KIMI_PLUGIN_VERSION`), with `*_TOKEN` / `*_SECRET`
    / `GITHUB_TOKEN` / `AWS_*` / `SSH_AUTH_SOCK` etc. stripped from the child.
  - Output caps: 4 MiB stdout, 1 MiB stderr, truncation markers + immediate
    kill on overflow.
  - Kill ladder: SIGTERM → +5 s SIGINT → +10 s SIGKILL → +15 s abandon.
  - ANSI / control-char scrub on `finalMessage` and `stderr`.
  - API-key value redaction in all surfaced strings.

- **P0-C worktree enforcement**: `kimi_implement` runs the CLI with
  `cwd=worktree`. Validates `base_repo` is a git repository, generates a
  unique `kimi-impl-<sha7>-<ts>` branch, runs `git worktree add`, and
  unconditionally removes the worktree in `finally` (even on classifier
  failure). TOCTOU recheck immediately before spawn.

- **P0-E auth bootstrap**: 4-state probe (`env` / `oauth` / `config_file` /
  `missing`). When env-based, writes a 0600 temp config-file under
  `os.tmpdir()` and invokes `kimi --config-file <tempfile>`; never mutates
  `~/.kimi/config.toml`. Temp file unlinked in `finally`. Orphan sweeper
  available for process startup.

- **P0-G adapter boundary**: stable `KimiResult` shape, error taxonomy
  (`validation_error` / `auth_missing` / `auth_invalid` / `timeout` /
  `cli_not_found` / `cli_shape_error` / `cli_exit_nonzero` /
  `subprocess_killed_external` / `path_validation` / `cli_version_unsupported`),
  CLI version probe + compat-entry picking, CLI shape-drift counter surfaced
  via `kimi_status.cli.shape_drift`.

- **Integration smoke suite** (opt-in via `KIMI_PLUGIN_INTEGRATION=1`):
  `kimi --version` parse, `kimi_query` round-trip, `kimi_resume` reuse.
  Runs against the real binary; verified 3/3 on kimi-cli 1.41.0.

### Test surface

- 234 unit tests + 3 integration smoke tests (237 total).
- Adapter modules: 16. Tool modules: 6 (status, query, resume, analyze,
  review, implement) plus shared response/mcp-response helper.

### Known limitations

- `--output-format stream-json` is exposed on `kimi_query`, `kimi_analyze`,
  `kimi_review`, `kimi_resume`. `kimi_implement` stays text-only by design
  (the diff + cleanup metadata is the value).
- `userConfig` paths require either env injection (server creates the temp
  config-file) or that the user already ran `kimi login` on the host.
- Auth-failure stderr-pattern matching is plumbed in `runKimiSafe` but no
  per-compat patterns are populated yet (CLI shape would need cataloguing).

[0.1.0]: https://github.com/OriginalKimChi/kimi-plugin-cc/releases/tag/v0.1.0
