---
description: Delegate investigation, a fix, or a substantial coding task to Kimi via the shared MCP runtime
argument-hint: '[--read-only|--write] [what Kimi should investigate, solve, or implement]'
allowed-tools: Agent, AskUserQuestion
---

Invoke the `kimi:kimi-rescue` subagent via the `Agent` tool (`subagent_type: "kimi:kimi-rescue"`), forwarding the raw user request as the prompt.
`kimi:kimi-rescue` is a subagent, not a skill — do not call `Skill(kimi:kimi-rescue)` or `Skill(kimi:rescue)` (the latter re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be Kimi's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- `--read-only` and `--write` are routing flags for the subagent. Preserve them when forwarding, but do not treat them as part of the natural-language task text.
- If neither flag is present, default to write-capable (i.e. forward without `--read-only`). The subagent maps that to `kimi_implement`.
- If the user did not supply a task, ask what Kimi should investigate or implement before forwarding.

Operating rules:

- The subagent is a thin forwarder only. It invokes one MCP tool (`mcp__plugin_kimi_kimi__kimi_implement` or `mcp__plugin_kimi_kimi__kimi_query`) and returns the result as-is.
- Return the subagent's stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files yourself, monitor progress, poll `/kimi:status`, summarize output, or do follow-up work. Those are separate flows.
- If the MCP tool reports that Kimi is missing or unauthenticated, stop and tell the user to run `/kimi:setup`.
