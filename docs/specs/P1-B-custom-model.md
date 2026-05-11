# P1-B — Custom model support

> **Status:** Draft, 2026-05-11.

## Problem

The current `model` parameter is a free-text string with only a length cap (1–256 chars). The adapter passes whatever the caller supplied straight to `kimi -m <model>`. This works for the default `kimi-code/kimi-for-coding`, but:

- There's no signal back to the caller about *which* models are known to work with the running CLI version. A typo (`kimi-mocha-pro` vs `kimi-mocha`) silently surfaces as a `cli_exit_nonzero` deep inside the run.
- The compat-table mechanism (`CLI_COMPAT`) covers CLI versions but not model availability. Adding a new model means changing wire-protocol expectations (e.g., thinking mode default) but those aren't gated.
- `kimi_status` doesn't expose the **set of models the user can actually call** today. The caller has to guess.

## Goal

1. A versioned **model registry** alongside the CLI compat table. Each entry pins: model id (the value to pass to `-m`), display name, capabilities (thinking / streaming / max context), and provider.
2. `kimi_status` returns the active CLI's known-model list under `cli.models[]`.
3. Each text-mode tool validates `model` against the active registry. Mode chosen at install: `strict` (reject unknown), `warn` (accept + flag), or `passthrough` (accept silently — today's behaviour).
4. A new tool option `model_capabilities_required?: { thinking?: boolean; streaming?: boolean; context_at_least?: number }` lets the caller declare needs and lets the server pick a model. If `model` is set explicitly, this is validated against the chosen model. If `model` is unset, the server picks the first registry entry that satisfies the constraints.

## Registry shape

```ts
// src/adapter/model-registry.ts

export interface ModelEntry {
  id: string;
  displayName: string;
  provider: "kimi_code" | "moonshot";
  capabilities: {
    thinking: boolean;
    streaming: boolean;
    contextWindow: number;          // tokens
    inputModalities: ("text" | "image")[];
  };
  /** CLI version range this entry was last confirmed against (semver). */
  confirmedAgainst: string;
}

export const MODEL_REGISTRY_v1_41: ModelEntry[] = [
  {
    id: "kimi-code/kimi-for-coding",
    displayName: "Kimi-k2.6",
    provider: "kimi_code",
    capabilities: { thinking: true, streaming: true, contextWindow: 256_000, inputModalities: ["text"] },
    confirmedAgainst: "1.41.0",
  },
  // ... future entries added here per CLI version
];

export function pickModel(
  registry: ModelEntry[],
  required: ModelCapabilitiesRequired,
): ModelEntry | null;
```

Registry is keyed off the CLI's compat entry: `compat-table.ts` gains a `defaultRegistry: ModelEntry[]` field per entry; `selectCompatEntry` returns it; `runKimiSafe` uses the active entry's registry for validation.

## Validation modes

`userConfig.model_validation_mode` ∈ `'strict' | 'warn' | 'passthrough'`. Default `warn` (most ergonomic, surfaces issues without breaking).

| Mode | Unknown model behaviour |
|---|---|
| `strict` | `runKimiSafe` returns `validation_error` with `details.allowed_models` |
| `warn` | Spawn proceeds; response carries `model_unknown: true` flag; drift counter increments with kind `unknown_model` (new) |
| `passthrough` | Same as today (no signal) |

## `kimi_status` extension

```jsonc
{
  // existing fields ...
  "cli": {
    // ...
    "models": [
      {
        "id": "kimi-code/kimi-for-coding",
        "display_name": "Kimi-k2.6",
        "provider": "kimi_code",
        "thinking": true,
        "streaming": true,
        "context_window": 256000
      }
    ],
    "model_validation_mode": "warn"
  }
}
```

## Tool surface changes

Each text-mode tool's `model` field stays the same shape. New optional fields:

```ts
model_capabilities_required: z.object({
  thinking: z.boolean().optional(),
  streaming: z.boolean().optional(),
  context_at_least: z.number().int().positive().optional(),
}).optional();
```

When `model` is unset and `model_capabilities_required` is set, the server picks. When both are set, the chosen model is validated against the required caps; mismatch returns `validation_error` (regardless of validation mode — that's caller intent, not registry drift).

## Test cases (TDD)

- `pickModel(registry, { thinking: true })` returns the first thinking-capable entry.
- `pickModel(registry, { context_at_least: 1_000_000 })` returns `null`.
- Tool call with `model='kimi-code/kimi-for-coding'`, default mode → registry hit → spawn proceeds, no warning.
- Tool call with `model='unknown-model'`, `mode='strict'` → `validation_error`, no spawn, `details.allowed_models` populated.
- Same with `mode='warn'` → spawn proceeds, `structuredContent.model_unknown=true`, `drift-counter.recentKinds` gains `unknown_model`.
- Same with `mode='passthrough'` → today's behaviour, no flag.
- `model_capabilities_required` mismatching the explicit `model` → `validation_error` regardless of mode.
- `kimi_status` payload includes `cli.models[]` with the registry for the active compat entry.

## Migration

Pure additive. v0.1.0 → v0.2.0:

- Existing callers that pass `model: 'kimi-code/kimi-for-coding'` continue to work (registry hit, no warning).
- Existing callers that pass a typo'd model continue to work (default mode `warn`), now with a structured warning they can react to.
- `kimi_status` payload gains `cli.models` and `cli.model_validation_mode`. Stable additive.

## What we explicitly do NOT do

- **No fetching the model list from the CLI at startup.** kimi-cli 1.41 doesn't expose `kimi models list` (we'd need to invoke a private endpoint). The registry is hand-curated per compat entry — that's the price of clean-room.
- **No auto-fallback when a chosen model fails.** P0-E §"No silent fallback" still applies: a model failure is a model failure.
- **No model-specific pricing / cost surfacing.** Out of scope; that's a billing concern, not an adapter concern.

## Open questions

1. How do we detect a stale registry? Recommendation: when a `cli_exit_nonzero` stderr contains `unknown model` (or whatever the CLI's actual error string is — needs P0-F-style probe), increment `drift-counter` with a new kind `model_registry_stale`. Surface via `kimi_status`.
2. Should `pickModel` be deterministic across server restarts? Recommendation: yes — registry order in source defines preference; no randomness.
3. Where to store `userConfig.model_validation_mode`? The manifest's `userConfig` already supports `enum` types in newer Claude Code. v0.2.0 manifest adds it as an enum field with default `"warn"`.
