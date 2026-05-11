# P1-A — Workflow chaining: `kimi_workflow`

> **Status:** Draft, written 2026-05-11 after the P0 milestone closed at 234 unit + 4 integration tests, 6 tools, 0.1.0 shipped.

## Problem

The current tool surface is six independent calls. The high-value use case — "have Kimi analyse a repo, then review its own plan, then implement the change inside a worktree" — requires the caller (Claude Code) to orchestrate three round-trips, propagate `session_id` between them, build the implement-time worktree path, and reconcile the diff at the end.

That orchestration is the same every time. It belongs on the server side.

## Goal

A single MCP tool `kimi_workflow` that runs:

1. `kimi_analyze` (read-only) → captures the analysis as `analysis_message` and a `session_id`.
2. `kimi_review` (read-only) of the analysis → captures `review_message`, reusing the session.
3. `kimi_implement` (write, in a worktree) seeded with the analysis + review → returns the standard implement payload.

The caller gets one structured response with all three stages. Any stage failing aborts the chain and surfaces the partial result + error.

## Why not "just call them sequentially in Claude Code"?

| Friction today | After server-side chaining |
|---|---|
| Caller must thread `session_id` between calls | Server reuses the session automatically |
| Three independent timeouts → easy to drift past total budget | One outer budget; server splits |
| Implement step's `worktree_path` / `base_repo` must be re-supplied | Server reuses the same `base_repo`; auto-derives `worktree_path` |
| Partial failures leak inconsistent state (analysed but never reviewed) | Server returns `stage_reached` so caller knows where it died |
| Caller has to remember to clean up `~/.kimi/sessions` artifacts | Server already has the cleanup hook |

## Contract

```ts
const InputSchema = z.object({
  task: z.string().min(1).max(50_000)
    .describe("The high-level goal. Forwarded verbatim to analyze; review and implement see it framed."),
  base_repo: z.string().min(1)
    .describe("Absolute path to the source repo for the implement step."),
  worktree_path: z.string().min(1).optional()
    .describe("Where to put the disposable worktree. If omitted the server generates one under os.tmpdir()/kimi-wf-<sha>."),
  base_ref: z.string().default("HEAD"),

  // Per-stage overrides
  analyze_prompt: z.string().optional()
    .describe("Replace the default analyse prompt. Default: 'Analyse the repo at <base_repo> for <task>. Return a structured plan.'"),
  review_prompt: z.string().optional()
    .describe("Default: 'Review the plan above adversarially. Call out gaps, risks, and missing edge cases.'"),
  implement_prompt: z.string().optional()
    .describe("Default: 'Apply the plan above, taking the review feedback into account.'"),

  model: z.string().optional(),         // applied to all three stages
  allow_dirty: z.boolean().default(false),
  // total budget across all stages; server splits 25 / 25 / 50.
  timeout_seconds: z.number().int().positive().max(1800).optional(),
});
```

Default total timeout: **1200 s** (matches `kimi_implement` cap). Split: analyze 25%, review 25%, implement 50%.

## Response shape

```ts
type WorkflowResult = {
  stage_reached: "analyze" | "review" | "implement" | "complete";
  session_id: string | null;
  analysis: { final_message: string; duration_ms: number } | null;
  review:   { final_message: string; duration_ms: number } | null;
  implement: ImplementResult | null;   // shape from kimi_implement
  total_duration_ms: number;
  error: KimiError | null;             // present iff stage_reached < 'complete'
};
```

`structuredContent` mirrors this. The MCP `content[0].text` summarises stage outcomes ("✓ analyze ✓ review ✓ implement → 3 files changed").

## Behaviour rules

1. **Session continuity.** Stage 1 starts a fresh session (no `session_id`). Stages 2 and 3 pass the captured `session_id` so Kimi sees its own analysis + review in context. The implement step then writes inside the worktree; the session memory carries the plan in but file edits do not propagate back to the main repo (worktree isolation per P0-C still holds).

2. **Fail fast.** Any stage classifying as a `KimiError` aborts. `stage_reached` is set to the last stage that *started* (so the caller knows whether the implement step ever ran — important for diff capture). The worktree, if created, is still cleaned up.

3. **Timeout splitting.** If the total budget overruns during analyze or review, the implement stage is skipped (not started) and the response surfaces `stage_reached: 'review'` or `'analyze'` with a `timeout` error.

4. **Worktree on-demand.** If `worktree_path` is omitted, the server creates `os.tmpdir()/kimi-wf-<sha7(base_repo+task+ts)>` and cleans it on completion / failure. Caller-supplied `worktree_path` is honoured as-is (delegated to existing `kimi_implement` validation).

5. **No silent retries.** A stage failing is the workflow failing. The caller decides whether to retry the whole thing, possibly with a different `task`.

## What we explicitly do NOT do

- **No partial retry inside the workflow.** Re-running the workflow re-runs all three stages. (A future P1-A.1 could add per-stage resume.)
- **No streaming intermediate results.** v1 returns one consolidated payload at the end. Streaming would need MCP `notifications/progress` plumbing — deferred.
- **No automatic merge of the implement diff back to `base_repo`.** Same rule as `kimi_implement`: the caller (Claude Code or the human) decides.
- **No cross-workflow session reuse.** Each `kimi_workflow` call gets a fresh session. Users wanting continuity across workflows still use `kimi_resume` directly.

## Test cases (TDD)

- Happy path: 3 stages succeed → `stage_reached='complete'`, all three sub-payloads present.
- Analyze fails (e.g. `auth_missing`) → `stage_reached='analyze'`, `error.code='auth_missing'`, no worktree created.
- Review fails → `stage_reached='review'`, analysis preserved, no worktree created.
- Implement fails (e.g. `worktree_dirty` because `allow_dirty=false`) → `stage_reached='implement'`, worktree cleanup runs, analysis + review preserved.
- Total timeout splits: analyze takes 90% of budget → review + implement skipped with `timeout` error and the analysis still returned.
- `session_id` reuse: stage 2 and 3 are called with `session_id` returned by stage 1 (verified by inspecting the captured argv via `_runSubprocess`).
- Worktree auto-creation: no `worktree_path` provided → server-generated path under `os.tmpdir()/kimi-wf-...`, cleaned up after.

## Files this spec implies

```
src/tools/workflow.ts          # KimiWorkflowInputSchema, runKimiWorkflow
src/tools/mcp-response.ts      # add workflowResultEnvelope helper (or keep inline)
tests/tools/workflow.test.ts   # unit suite with injected _runSubprocess
tests/integration/             # opt-in 'workflow round-trip' smoke
```

## Open questions

1. Should the default prompts be configurable at install time via `userConfig`, or hard-coded? Recommendation: hard-coded for v1; user overrides go through the per-stage `*_prompt` args.
2. Should the implement step run with `create_worktree=true` always, or honour the input? Recommendation: always true for v1 (simpler contract); `create_worktree=false` is a `kimi_implement` direct-call feature.
3. Should we surface the worktree's `branch` name and `commit_sha` even when implement fails partway? Recommendation: yes, in the partial `implement` payload, so the user can recover manually.
