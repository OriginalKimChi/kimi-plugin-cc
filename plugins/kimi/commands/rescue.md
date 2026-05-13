---
description: Delegate investigation, a fix, or a substantial coding task to Kimi via the kimi-companion runtime
argument-hint: '[--read-only|--write] [--background] [--resume <session>|--fresh] [what Kimi should investigate, solve, or implement]'
allowed-tools: Agent, AskUserQuestion
---

Invoke the `kimi:kimi-rescue` subagent via the `Agent` tool (`subagent_type: "kimi:kimi-rescue"`), forwarding the raw user request as the prompt.
`kimi:kimi-rescue` is a subagent, not a skill — do not call `Skill(kimi:kimi-rescue)` or `Skill(kimi:rescue)` (the latter re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be Kimi's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- `--read-only`, `--write`, `--background`, `--resume <session>`, `--fresh`, and `--model <name>` are routing flags for the subagent. Preserve them when forwarding, but do not treat them as part of the natural-language task text.
- If neither `--read-only` nor `--write` is present, default to write-capable. The subagent maps that to `kimi-companion task --write`.
- If neither `--background` nor an obvious "wait for it" cue is present, leave the choice to the subagent. It uses a foreground/background heuristic based on task size.
- If the user did not supply a task, ask what Kimi should investigate or implement before forwarding.

Operating rules:

- The subagent is a thin forwarder only. It invokes a single Bash call to `kimi-companion task` and returns its stdout as-is.
- For background runs, kimi-companion returns a job id immediately; users can then run `/kimi:status <id>`, `/kimi:result <id>`, or `/kimi:cancel <id>`.
- Return the subagent's stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not inspect files yourself, monitor progress, poll `/kimi:status`, summarize output, or do follow-up work. Those are separate flows.
- If kimi-companion reports that Kimi is missing or unauthenticated, stop and tell the user to run `/kimi:setup`.
