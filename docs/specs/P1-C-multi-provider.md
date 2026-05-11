# P1-C — Multi-provider abstraction

> **Status:** Draft, 2026-05-11.

## Problem

The plugin's name, manifest, and code path are all kimi-specific:

- `src/adapter/runner.ts` calls `kimi` (via `ctx.binary ?? "kimi"`).
- `cli-probe.ts`, `compat-table.ts`, `parser-text.ts`, `parser-stream-json.ts` all encode CLI behaviour observed from `kimi-cli 1.41.0`.
- Tool names are `kimi_*`. The marketplace plugin is `kimi`.

Several adjacent LLM coding CLIs share the same shape:
- **Codex** (`codex` CLI) — same OAuth-or-key auth, same `--print` non-interactive mode, similar stream-json output.
- **Aider** (`aider --no-pretty --message ...`) — different invocation but parseable text mode.
- **opencode / continue-cli / ...** — emerging.

The hardening we built (P0-D output caps, kill ladder, env allowlist, path-validator, TOCTOU recheck, error taxonomy, drift counter, temp-config injection) is **provider-agnostic** — only the argv builder, version regex, and trailing-marker regex are CLI-specific.

## Goal

Refactor the adapter so adding a new provider is a single new file that implements a `Provider` interface, without touching the hardening layer. Keep the kimi-specific tool names and marketplace plugin as-is for v1; a second marketplace plugin (`codex-plugin-cc`?) can consume the same npm-published adapter package.

## Architecture sketch

```
@originalkimchi/llm-cli-adapter  (new package, extracted from current src/adapter/)
├── subprocess-runner.ts         (provider-agnostic, unchanged)
├── path-validator.ts            (provider-agnostic, unchanged)
├── security.ts                  (env allowlist becomes per-provider)
├── errors.ts                    (provider-agnostic taxonomy)
├── drift-counter.ts             (provider-agnostic)
├── temp-config.ts               (provider-agnostic; provider stanza injected by Provider)
├── runner.ts                    (orchestrator; calls into Provider)
└── providers/
    ├── types.ts                 (Provider interface)
    ├── kimi.ts                  (current behaviour moved here)
    └── codex.ts                 (future)

plugins/kimi/scripts/mcp-server/  (this repo)
└── src/                          (depends on @originalkimchi/llm-cli-adapter, picks Provider=kimi)
```

## Provider interface

```ts
export interface ProviderInvocation {
  prompt: string;
  workDir?: string;
  addDirs?: string[];
  sessionId?: string;
  model?: string;
  thinking?: boolean;
  noThinking?: boolean;
  maxStepsPerTurn?: number;
  outputFormat: "text" | "stream-json";
  finalMessageOnly?: boolean;
  configFile?: string;
}

export interface Provider {
  /** Display name + binary lookup. */
  readonly id: "kimi" | "codex" | string;
  readonly defaultBinary: string;

  /** ARGV-builder: how this CLI accepts options. */
  buildArgv(inv: ProviderInvocation): string[];

  /** Where does this CLI place the trailing session marker?
   *  Kimi 1.41: stderr in --quiet, stdout in --print --output-format=stream-json. */
  extractSessionId(stdout: string, stderr: string): string | null;

  /** How to parse the assistant's final message. */
  parseText(stdout: string): { finalMessage: string };
  parseStreamJson(stdout: string): { finalMessage: string; events: unknown[] };

  /** Where to write the temp config-file and what stanza to use.
   *  Returns the TOML body — provider-agnostic writer handles 0600 + path. */
  tempConfigBody(apiKey: string): string;

  /** Auth probe: which files / env vars signal authentication on this provider. */
  probeAuth(input: { env: NodeJS.ProcessEnv; home: string }): AuthProbeResult;

  /** CLI version probe: argv to pass and regex to extract version. */
  versionProbeArgv: readonly string[];
  versionRegex: RegExp;

  /** Per-version compat entries (replaces the current monolithic CLI_COMPAT). */
  compat: CompatEntry[];

  /** Per-compat auth-failure stderr patterns. */
  authFailurePatterns(compat: CompatEntry): readonly RegExp[];
}
```

`runKimi` becomes `runProvider(provider, inv, ctx)`. The 234 P0 unit tests largely stay green — they exercise the orchestration, which doesn't change.

## Migration plan

Two-stage, both backward-compatible.

### Stage 1 — refactor in-place (no new package)

1. Add `src/adapter/providers/types.ts` with the `Provider` interface.
2. Add `src/adapter/providers/kimi.ts` that wraps the existing `buildArgv` / `parseTextStdout` / `parseStreamJsonStdout` / `probeAuth` / `extractSessionId` / `compat-table` / `temp-config` into one object literal.
3. Replace `runKimi` callers to receive a `provider: Provider` param (default `kimiProvider`).
4. All existing tests pass with `provider=kimiProvider` injected. Adds maybe 30 tests for `kimiProvider` shape.

After stage 1: same npm artefacts, same tools, but the adapter is internally provider-keyed.

### Stage 2 — extract package (later, when a second provider lands)

1. Move `src/adapter/` minus `providers/` into a new `packages/llm-cli-adapter/` workspace (yarn / pnpm workspaces).
2. Publish to npm as `@originalkimchi/llm-cli-adapter`.
3. `plugins/kimi/scripts/mcp-server/` `npm install`s the package and re-exports `kimiProvider`.
4. Spin up `plugins/codex/...` with the same shape, depending on the same package + a new `codexProvider`.

Stage 2 is the heavy lift (workspace, publishing, CI). Defer until a second provider is actually wanted.

## What changes per plugin

| Plugin field | Per-provider value |
|---|---|
| Marketplace plugin name | `kimi` → `codex` |
| Tool names | `kimi_*` → `codex_*` (or rename to `llm_*`?) |
| userConfig API key fields | `kimi_code_api_key` / `moonshot_api_key` → `codex_api_key` etc. |
| Server name | `"kimi"` → `"codex"` |
| Default model in `pickModel` | per-provider registry |

## What we explicitly do NOT do

- **No single MCP server that exposes both kimi *and* codex tools.** Each provider gets its own marketplace plugin and its own MCP server binary. Sharing one server complicates auth, logging, and trust boundaries.
- **No provider auto-detection** ("if both `kimi login` and `codex login` work, pick one"). The caller picks the plugin they installed.
- **No common tool name namespace.** `kimi_query` and `codex_query` remain distinct; Claude Code can have both installed simultaneously without collision.
- **No "kimi-but-different-config" sub-providers** for now. The compat table inside `kimiProvider` already covers CLI version drift; multiple managed accounts on the same provider is out of scope.

## Test cases (TDD)

Stage 1 (refactor):

- All 234 P0 unit tests pass unchanged after threading `provider: kimiProvider` through.
- New `tests/adapter/providers/kimi.test.ts`: snapshot of `kimiProvider.buildArgv(...)` matches the historical argv. Same for `extractSessionId`, `parseText`, `parseStreamJson`, `tempConfigBody`.
- New `tests/adapter/provider-runner.test.ts`: a stub `Provider` implementing each method as a spy → `runProvider` calls each method exactly once per invocation, in the documented order.

Stage 2 (packaging):

- `llm-cli-adapter` package builds standalone (no kimi-specific code in the package).
- `kimiProvider` re-published from the consumer side.
- Integration smoke for kimi unchanged.
- New `codex-plugin-cc` smoke test gets first integration run.

## Open questions

1. Should the npm package be CJS, ESM, or dual? The current MCP server bundles into CJS via esbuild. Recommendation: package as ESM with a CJS fallback (`exports` field) — most modern tooling consumes ESM.
2. Should `kimi_status` mention the provider in its payload? Recommendation: yes, after stage 1 add `payload.provider: "kimi"` (free signal for cross-plugin tooling).
3. How do we keep version compatibility between the adapter package and the plugins? Recommendation: semver. Major bumps require coordinated updates across all consumer plugins. Document the version pin in each plugin's `package.json`.
4. What about non-CLI providers (e.g., HTTP API directly)? Recommendation: out of scope for `llm-cli-adapter` — the package name pins the contract to "wraps a CLI subprocess." HTTP-direct providers can grow a sibling `llm-http-adapter` later if useful.
