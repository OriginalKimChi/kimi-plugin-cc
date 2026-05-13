---
description: Cancel a running Kimi background job
argument-hint: '<job-id>'
allowed-tools: Bash(node:*)
---

Run the kimi-companion cancel subcommand and return its stdout verbatim.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kimi-companion.mjs" cancel $ARGUMENTS
```

Output rules:

- Return stdout exactly as printed.
- The companion sends SIGTERM to the worker's process group, then marks the job `cancelled`. Already-completed or already-cancelled jobs report that state without re-killing.
- Do not retry or fall back to manual `kill` commands. If the companion reports "no live process to signal", surface that line.
