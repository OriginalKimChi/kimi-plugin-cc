---
description: Run a Kimi code review against local git state and emit structured findings (findings_v1)
argument-hint: '[--base <ref>] [--scope auto|working-tree|branch] [--model <name>] [focus text ...]'
allowed-tools: Bash(git:*), Read, Grep, Glob, mcp__plugin_kimi_kimi__kimi_review
disable-model-invocation: true
---

Run a Kimi review of the current local git state and return structured findings that conform to `plugins/kimi/schemas/review-output.schema.json` (schema_version `findings_v1`).

Raw user request:
$ARGUMENTS

# Constraints

- This command is review-only. Do not modify files, fix issues, or run formatters.
- Your job is exactly: collect git context → ask Kimi to review against the schema → render the findings. Nothing more.
- If you cannot produce valid `findings_v1` JSON from Kimi's reply, emit a brief error message and stop.

# Step 1 — resolve scope

Parse `$ARGUMENTS` for `--base <ref>` and `--scope auto|working-tree|branch`. Everything that isn't a flag is "focus text" — pass it verbatim to Kimi.

Default scope is `auto`:

- If `git diff --shortstat` (working tree) is non-empty OR `git status --short --untracked-files=all` shows untracked files, scope is `working-tree`. Base = none.
- Otherwise scope is `branch`. Base defaults to `git merge-base HEAD origin/main` if that ref exists, else `origin/HEAD` symbolic ref, else `HEAD~1` as last resort.

If the user passed `--scope working-tree` or `--scope branch`, honor it.
If the user passed `--base <ref>`, use it directly (still requires `--scope branch`; reject otherwise).

# Step 2 — gather diff context

Run the appropriate single command:

- working-tree: `git status --short --untracked-files=all` + `git diff` + `git diff --cached`
- branch: `git diff <base>...HEAD`

Cap the diff at 100 KB. If it exceeds, truncate and note `(diff truncated at 100 KB)` in the prompt.

If there is genuinely nothing to review (empty diff and no untracked files), output a single line `Nothing to review.` and stop.

# Step 3 — call kimi_review with schema-enforced prompt

Build a single prompt for `mcp__plugin_kimi_kimi__kimi_review` with these sections in order:

1. A line: `Return ONLY a single JSON object that validates against the following schema. Do not include prose before or after the JSON.`
2. The schema verbatim, fenced in ```json … ``` — read from `plugins/kimi/schemas/review-output.schema.json`.
3. A short rules block:
   - `schema_version` MUST be the literal `"findings_v1"`.
   - `attack_round` MUST be `1` for this call.
   - Every finding's `id` MUST be unique within the response and match `/^f-[a-z0-9]{4,16}$/`.
   - `verdict` is `"approve"` when there are zero `critical` or `high` severity findings, otherwise `"needs-attention"`.
   - `file` paths must be repo-relative.
4. The focus text from `$ARGUMENTS` (if any), prefixed with `Reviewer focus: `.
5. The diff payload from step 2, fenced in ```diff … ```.

Call `mcp__plugin_kimi_kimi__kimi_review` with:
- `prompt` = the assembled string
- `work_dir` = repo root (from `git rev-parse --show-toplevel`)
- `output_format` = `"text"`
- `timeout_seconds` = `300` (default is 300, max 600 — only raise if the diff is genuinely large)
- `model` from `--model` if supplied

# Step 4 — parse and validate

- Extract the first balanced JSON object from Kimi's reply. Tolerate a leading ```json fence.
- Verify: `schema_version === "findings_v1"`, required top-level keys present, every finding has the 8 required fields, all `id`s unique, `attack_round === 1` (or absent — treat as 1).
- On parse/validate failure, output: `Kimi returned non-conforming review output. Raw response:` followed by the raw final message, and stop. Do not invent findings.

# Step 5 — render

Print the structured findings to the user in this exact form:

```
Verdict: <verdict>  (<n> findings)

Summary
  <summary>

Findings
  [<severity>] <title>   <file>:<line_start>-<line_end>   (id=<id>, conf=<confidence>)
    <body>
    → <recommendation>

Next steps
  - <next_steps[0]>
  - <next_steps[1]>
  …
```

Then on a final line, print the session id so the user can chain: `kimi session: <session_id_from_kimi_review_response>`.

Do not summarize further. Do not offer to fix anything. The user invokes `/kimi:adversarial-review` separately if they want a second pass.
