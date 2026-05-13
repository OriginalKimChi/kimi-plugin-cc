# P1-D — `kimi-companion` background runtime

> **Status:** Shipped in 0.3.0 (2026-05-13). Written alongside the
> implementation, not as a forward-looking draft.

## Problem

Until 0.3.0, `/kimi:rescue` forwarded into the MCP server
(`mcp__plugin_kimi_kimi__kimi_implement` or `kimi_query`). MCP tool calls
travel over the JSON-RPC request/response cycle, which is synchronous: the
client (Claude Code) blocks until the tool returns. For a long Kimi run that
holds the parent turn hostage. There is no way for the user to keep working,
poll progress, or cancel without killing the whole turn.

The Codex plugin solved the same problem differently — `codex-rescue` is a
subagent with `tools: Bash`, and it shells out to a Node companion script
that spawns the actual Codex CLI as a detached process. The subagent
immediately returns a job id and the user polls `/codex:status <id>` for
progress. This works because OS-level process detachment isn't bound to the
MCP lifecycle.

We need the same shape for Kimi.

## Goal

A single-file Node ESM companion (`scripts/kimi-companion.mjs`) that:

1. Runs `kimi` either foreground (block until done, print final message) or
   background (return a job id, fire-and-forget a detached worker).
2. Persists job state per workspace so users can later look up status,
   read the final output, or cancel.
3. Is invoked exclusively through `Bash` from the `kimi-rescue` subagent and
   the `/kimi:status` / `/kimi:result` / `/kimi:cancel` slash commands —
   no MCP coupling.
4. Mirrors `codex-companion`'s subcommand surface and rendering so the two
   plugins feel symmetric to the user.

## Non-goals

- **Worktree isolation.** The MCP `kimi_implement` tool keeps doing that
  (and is unchanged by this spec). The companion runs `kimi` in the
  caller's cwd. If a user needs an isolated worktree for a write task,
  they call the MCP tool directly; `/kimi:rescue` users accept that
  background mode edits the live tree.
- **Structured event stream.** v1 captures `kimi --print --output-format
  text --quiet` stdout only. Progress is the raw stderr tailed into the
  per-job log file. Stream-json adoption is a follow-up.
- **Concurrent-job linearisation.** Two simultaneous `task` invocations
  race on the index file. Per-job JSON records don't collide; the index
  may transiently miss an entry. Same model as Codex's companion today.

## Subcommand surface

```
node scripts/kimi-companion.mjs task [--background] [--write|--read-only]
                                     [--resume <session-id>|--fresh]
                                     [--model <m>] [--cwd <dir>]
                                     [--timeout-seconds <n>] [--json]
                                     [prompt]

node scripts/kimi-companion.mjs status [job-id] [--cwd <dir>] [--all] [--json]
node scripts/kimi-companion.mjs result <job-id|latest> [--cwd <dir>] [--json]
node scripts/kimi-companion.mjs cancel <job-id> [--cwd <dir>] [--json]

# Internal — invoked only by the parent task command:
node scripts/kimi-companion.mjs task-worker --cwd <dir> --job-id <id>
```

Routing flags (`--write`, `--read-only`, `--resume`, `--fresh`, `--model`,
`--background`) are stripped from the prompt before forwarding by the
`kimi-rescue` subagent — the same contract `codex-rescue` already enforces.

## State model

```
${CLAUDE_PLUGIN_DATA}/state/<slug>-<hash>/      # primary location
$TMPDIR/kimi-companion/<slug>-<hash>/           # fallback when env var unset
    state.json                                   # index of recent jobs
    jobs/
        <jobId>.json                             # full record (request, result)
        <jobId>.log                              # raw stderr tail + lifecycle log
```

- `<slug>` is `basename(workspaceRoot)` scrubbed to `[A-Za-z0-9._-]+`.
- `<hash>` is `sha256(realpath(workspaceRoot)).slice(0, 16)`. This isolates
  state per workspace and survives symlink / mv.
- `workspaceRoot` is the nearest ancestor of `--cwd` (or `process.cwd()`)
  that contains a `.git` entry. Falls back to the cwd itself if none.
- The index keeps the **50 most recent** jobs by `updatedAt`. Older job
  JSON + log files are garbage-collected on every `saveState` call.
- `jobId` shape: `kimi-task-<base36(epochMs)>-<6 random base36>`.

Per-job JSON record:

```jsonc
{
  "id": "kimi-task-...",
  "status": "queued | running | completed | failed | cancelled",
  "title": "Kimi Task",
  "summary": "first 80 chars of the prompt",
  "pid": 12345,                  // worker pid while running; null when done
  "write": true,                 // routing label; v1 does not change argv
  "cwd": "/abs/path",
  "logFile": "/.../jobs/<id>.log",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "completedAt": "ISO-8601",     // null while running
  "errorMessage": null,          // populated on failed / cancelled
  "request": {
    "cwd": "/abs/path",
    "prompt": "...",
    "model": null,
    "resumeSessionId": null,
    "write": true,
    "timeoutSeconds": 600
  },
  "result": {                    // present once finalized
    "finalMessage": "...",
    "exitCode": 0,
    "signal": null,
    "durationMs": 12345,
    "stderrTail": "...",         // last 2 KiB of stderr
    "stdoutTruncated": false
  }
}
```

## Lifecycle

```
   task (--background)                  task (foreground)
        │                                    │
        ▼                                    ▼
  upsert(queued)                       upsert(running, pid=self)
        │                                    │
        ▼                                    ▼
  spawn detached worker            runKimi (in-process)
        │                                    │
        │                                    ▼
        │                              finalizeJob → upsert(completed|failed)
        │                                    │
        ▼                                    ▼
  print jobId immediately           print finalMessage
        │
        ▼
  worker process:
    upsert(running, pid=worker)
    runKimi
    finalizeJob → upsert(completed|failed|cancelled)
```

- **Detachment.** The background worker is spawned with
  `{ detached: true, stdio: "ignore" }`. The parent `child.unref()`s it so
  Node can exit immediately. Because `detached: true` makes the worker a
  new process-group leader on Unix, `cancel` can SIGTERM the entire
  subtree via `process.kill(-pid, "SIGTERM")`.
- **Cancellation.** SIGTERM to `-pid`; falls back to plain `pid` if the
  negation fails. Mark `cancelled`, set `completedAt`, persist
  `errorMessage = "Cancelled by user."`. Already-finished jobs short-circuit
  and report current state.
- **Timeouts.** Soft defaults: 600 s foreground, 1800 s background. Hard
  ceiling 7200 s. On timeout the worker SIGTERMs, then SIGKILLs after 5 s;
  finalize marks `failed` with `errorMessage = "Timed out."`.
- **Auth failure.** After `kimi` exits non-zero, the finalizer regex-scans
  stdout + stderr for `not authenticated`, `please run kimi login`,
  `unauthorized`, `401`, etc. If matched, `errorMessage = "Kimi is not
  authenticated. Run `/kimi:setup`."`. The `kimi-rescue` agent surfaces
  that line verbatim.

## Argv assembly

The companion builds a minimal kimi argv:

```
kimi --print --output-format text --quiet
     [--work-dir <abs>]
     [-r <session-uuid>]
     [-m <model>]
     --prompt <prompt>
```

`--quiet` requires `--output-format text`; we do not enable stream-json in
this release (see Non-goals). The prompt is passed via `--prompt` to keep
kimi 1.41's positional behaviour from interpreting it as a subcommand name
(same reason `argv.ts` in the MCP adapter takes that shape — see
`src/adapter/argv.ts:54-56`).

## Trade-offs vs the MCP path

| dimension                 | MCP `kimi_implement` (unchanged)        | companion `task` (new)             |
|---------------------------|------------------------------------------|------------------------------------|
| isolation                 | disposable git worktree, auto-cleanup    | runs in caller's cwd               |
| transport                 | JSON-RPC, synchronous, blocks parent     | `Bash` spawn, can detach           |
| progress polling          | none — parent blocks                     | `/kimi:status`, log file tail      |
| cancel                    | only by ending the Claude turn           | `/kimi:cancel <id>`                |
| diff capture              | yes (`diff`, `files_changed`, sha)       | no — caller inspects working tree  |
| typical caller            | the MCP-aware main thread                | `kimi-rescue` subagent + slash cmd |

Both surfaces coexist: the MCP tools are still registered, still hit the
same `runKimiSafe` adapter, and still create worktrees. Users who want the
worktree contract call the MCP tool directly. Users who want backgrounding,
status, and cancel use `/kimi:rescue`.

## Verification

- 234/234 unit tests in `plugins/kimi/scripts/mcp-server/tests/` still
  green after the version sync.
- Smoke-tested with a fake-kimi stub (foreground completion, background
  queued → running → completed, cancel kills the worker process group,
  auth-failure stderr → `/kimi:setup` hint).

## Follow-ups (not in this spec)

- `--worktree` flag on `task` to optionally route writes through a
  disposable worktree before invoking kimi. Folds the MCP-side worktree
  guard into the companion.
- Stream-json adoption so `/kimi:status` can show in-flight tool calls,
  not just lifecycle timestamps.
- Resumable jobs: the companion already records `request.resumeSessionId`;
  a `--resume-last` flag (Codex-style) would inspect the latest finished
  job for this workspace and reuse its session_id.
