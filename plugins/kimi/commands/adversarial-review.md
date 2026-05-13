---
description: Two-round Kimi review where round 2 actively attacks round 1's findings, surfacing what was missed, exaggerated, or wrong
argument-hint: '[--base <ref>] [--scope auto|working-tree|branch] [--model <name>] [focus text ...]'
allowed-tools: Bash(git:*), Read, Grep, Glob, mcp__plugin_kimi_kimi__kimi_review
disable-model-invocation: true
---

Run a Kimi review of local git state in TWO rounds. Round 1 is a normal review. Round 2 is a separate Kimi session that takes round 1's findings as an attack surface and tries to find what round 1 missed, exaggerated, or got wrong. This is NOT a simple "review again with harder prompt" — round 2 must explicitly reference round 1 findings by id.

Raw user request:
$ARGUMENTS

# Constraints

- Review-only. Do not modify files, fix issues, or run formatters in either round.
- Both rounds emit JSON that validates against `plugins/kimi/schemas/review-output.schema.json` (schema_version `findings_v1`).
- Round 2 MUST set `attack_round = 2` and SHOULD use the optional `responding_to` + `stance` fields on its findings.

# Step 1 — run round 1 (same as /kimi:review)

Follow steps 1-4 of `/kimi:review` exactly to produce round-1 structured findings. Use the same scope resolution, diff cap, schema-enforced prompt, parse, and validation. Call this object `R1`.

If round 1 yields no parseable JSON, emit `Round 1 failed to produce valid findings_v1. Raw:` + the raw reply, and stop. Do not proceed to round 2.

# Step 2 — build the adversarial round-2 prompt

Build a single new prompt for a SEPARATE `mcp__plugin_kimi_kimi__kimi_review` call (do NOT reuse `R1`'s session_id — adversarial round 2 is a fresh session so its judgment isn't anchored to round 1):

1. Header: `You are reviewing a code diff that has already been reviewed once. The previous reviewer's findings are below. Your job is to be adversarial: find what they got wrong, what they missed, what they exaggerated. Do NOT simply restate their findings.`
2. The schema verbatim (same as round 1), fenced in ```json … ```.
3. Adversarial rules:
   - `schema_version` = `"findings_v1"`.
   - `attack_round` MUST be `2`.
   - Every round-2 finding MUST include `responding_to` (an array of round-1 finding ids it engages with, possibly empty if reporting something round 1 missed entirely) and `stance` (one of `rebut`, `expand`, `missed`, `exaggerated`, `confirm`).
   - You may produce zero findings if round 1 was genuinely complete — but `summary` must still explain why.
   - `verdict`: `"needs-attention"` if you found anything round 1 missed at high/critical severity OR any round-1 finding you `rebut` or call `exaggerated`. Else `"approve"` if you genuinely agree with round 1.
4. Focus text from `$ARGUMENTS` (if any), prefixed `Reviewer focus: `.
5. Round 1 findings as JSON, fenced in ```json … ```. Pretty-print `R1` for legibility.
6. The original diff payload (same as round 1), fenced in ```diff … ```.

Call `mcp__plugin_kimi_kimi__kimi_review` with:
- `prompt` = the assembled string
- `work_dir` = repo root
- `output_format` = `"text"`
- `timeout_seconds` = `300`
- `model` from `--model` if supplied

# Step 3 — parse round 2

Extract and validate JSON the same way as round 1. Additionally:
- Reject if `attack_round !== 2`.
- For each round-2 finding with non-empty `responding_to`, every id must exist in `R1.findings[*].id`.
- On any validation failure, emit `Round 2 failed validation: <reason>. Raw:` + raw reply, and stop. Still render `R1` so the user has at least one perspective.

# Step 4 — render both rounds and the delta

Output in this exact form:

```
=== Round 1 ===
Verdict: <R1.verdict>  (<n> findings)

Summary
  <R1.summary>

Findings
  [<severity>] <title>   <file>:<line_start>-<line_end>   (id=<id>, conf=<confidence>)
    <body>
    → <recommendation>

=== Round 2 (adversarial) ===
Verdict: <R2.verdict>  (<n> findings)

Summary
  <R2.summary>

Findings
  [<severity>] <title>   <file>:<line_start>-<line_end>   (id=<id>, stance=<stance>, conf=<confidence>)
    responds to: <responding_to joined by ", ", or "(none — missed by round 1)">
    <body>
    → <recommendation>

=== Delta ===
  R1 confirmed by R2:    <list of R1 ids that R2 marked stance="confirm">
  R1 rebutted by R2:     <list of R1 ids R2 marked stance="rebut">
  R1 exaggerated per R2: <list of R1 ids R2 marked stance="exaggerated">
  R1 expanded by R2:     <list of R1 ids R2 marked stance="expand">
  Missed by R1:          <count of R2 findings with stance="missed">

kimi sessions: round1=<R1_session_id>, round2=<R2_session_id>
```

Do not editorialize further. Do not declare one round "right" — that judgment belongs to the user.
