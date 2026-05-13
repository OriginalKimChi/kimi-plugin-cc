---
description: Print the final output of a Kimi background job
argument-hint: '<job-id|latest>'
allowed-tools: Bash(node:*)
---

Run the kimi-companion result subcommand and return its stdout verbatim.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kimi-companion.mjs" result $ARGUMENTS
```

Output rules:

- Return stdout exactly as printed. Kimi's final message is the substance — do not paraphrase or summarize it.
- If no job id is given, the companion resolves to the most recent job (`latest`).
- If the job is still running, the result body shows "(no output captured yet)" — that is expected. Suggest the user check `/kimi:status` if needed, but only if they ask.
