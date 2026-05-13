---
description: Show the status of Kimi background jobs started via /kimi:rescue --background
argument-hint: '[job-id] [--all]'
allowed-tools: Bash(node:*)
---

Run the kimi-companion status subcommand and return its stdout verbatim.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kimi-companion.mjs" status $ARGUMENTS
```

Output rules:

- Return stdout exactly as printed.
- Do not paraphrase, summarize, or add commentary.
- If no arguments are given, the companion lists recent jobs (most recent first, capped at 10 unless `--all` is passed).
- If a job id is given, the companion prints a single-job report. If the id does not exist, the companion exits non-zero with a short message — surface that line as-is.
