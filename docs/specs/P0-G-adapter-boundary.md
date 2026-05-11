# P0-G — CLI ↔ MCP adapter boundary

## Why this matters

The `kimi` CLI is a moving target. Its `--help` text, output format, and option names can change without notice across versions. Without an explicit boundary, drift in any of those will leak straight into our MCP tool schemas — and from there, into Claude Code's expectations.

The adapter is a thin, versioned layer that:
- Takes a stable MCP-tool-shaped input.
- Translates it to one specific `kimi` CLI command-line invocation.
- Parses the CLI's stdout/stderr into a stable, versioned response object.
- Fails loudly when the CLI's output shape doesn't match what the version's parser expects.

## Architecture

```
MCP request (tools/call)                           MCP response
       │                                                  ▲
       ▼                                                  │
┌─────────────────────────────┐         ┌─────────────────────────────┐
│  Zod-validated MCP schema    │         │  Zod-validated MCP schema    │
│  (stable across plugin vers) │         │  (stable across plugin vers) │
└─────────────────────────────┘         └─────────────────────────────┘
       │                                                  ▲
       ▼                                                  │
┌─────────────────────────────────────────────────────────────────────┐
│                       Adapter (this spec)                            │
│                                                                      │
│  - Maps MCP fields → CLI args (per kimi-cli version table)           │
│  - Builds argv array (never a shell string)                          │
│  - Spawns kimi via shared subprocess helper (P0-D guards)            │
│  - Parses stdout per output_format                                   │
│  - Splits off the trailing `To resume…` marker, extracts session_id  │
│  - Asserts response shape; on mismatch → throws CLIShapeError        │
└─────────────────────────────────────────────────────────────────────┘
       │                                                  ▲
       ▼                                                  │
                       child_process.spawn("kimi", argv)
```

## Adapter API (internal, not exposed to MCP)

```ts
type KimiInvocation = {
  prompt: string;
  workDir?: string;
  addDirs?: string[];
  sessionId?: string;            // for resume
  maxStepsPerTurn?: number;
  model?: string;
  thinking?: boolean;
  outputFormat: "text" | "stream-json";
  configFile?: string;           // temp file path for auth (P0-E)
  timeoutSeconds: number;        // upper bound for the kill ladder
};

type KimiResult = {
  sessionId: string | null;      // parsed from "To resume this session: kimi -r <id>"
  finalMessage: string;          // assistant's last message, stripped of control chars
  rawEvents?: StreamEvent[];     // present iff outputFormat === "stream-json"
  stdoutBytes: number;
  stderrBytes: number;
  exitCode: number;
  durationMs: number;
  truncated: { stdout: boolean; stderr: boolean };
  killedBy: "completed" | "timeout" | "stderr_cap" | "stdout_cap" | "caller";
};

async function runKimi(inv: KimiInvocation): Promise<KimiResult>;
```

The MCP tool implementations call `runKimi` and translate `KimiResult` into the tool-specific response. They do NOT spawn `kimi` directly.

## CLI version compatibility table

The adapter ships with a version table. Each entry pins:
- Which CLI version range is supported.
- Which flags are passed and how.
- The expected stdout shape regex/parser.

```ts
const CLI_COMPAT: Array<{
  range: string;             // semver range, e.g. ">=1.41.0 <2.0.0"
  flagMap: {
    quiet: ["--quiet"];
    workDir: ["--work-dir", "<path>"];
    addDir: ["--add-dir", "<path>"];  // repeatable
    session: ["-r", "<id>"];
    maxStepsPerTurn: ["--max-steps-per-turn", "<n>"];
    model: ["-m", "<id>"];
    noThinking: ["--no-thinking"];
    thinking: ["--thinking"];
    outputFormat: ["--output-format", "text|stream-json"];
    configFile: ["--config-file", "<path>"];
  };
  trailingSessionLine: RegExp;   // e.g. /^To resume this session: kimi -r ([0-9a-f-]{36})$/m
  streamJsonShape: ZodSchema;    // per-event JSON shape
}>;
```

Startup behaviour:
1. Run `kimi --version`. Parse `kimi, version X.Y.Z`.
2. Pick the matching compat entry. If none matches, log a warning and fall back to the highest entry, marking `kimi_status` to report `cli_version_unsupported: true`.
3. On every call, the adapter uses the active entry's flagMap to build argv.

## Output parsing

### `text` mode

stdout structure observed in P0-F:
```
<final assistant message>

To resume this session: kimi -r <UUID>
```

Parser:
1. Split stdout on the trailing-line regex.
2. If matched: `sessionId` = capture group; `finalMessage` = everything before the match, right-trimmed.
3. If not matched: `sessionId = null`, `finalMessage` = full stdout (we still return a result; the missing marker is logged as a soft warning, not an error).

### `stream-json` mode

stdout structure observed in P0-F:
```
{"role":"assistant","content":"..."}
\n
To resume this session: kimi -r <UUID>
```

Parser:
1. Split on `\n`.
2. For each line: if it matches the trailing-line regex, extract sessionId and stop.
3. Otherwise: attempt JSON.parse. If valid → push to `rawEvents`. If invalid → log as malformed event, do NOT abort (one bad line ≠ whole-stream failure).
4. `finalMessage` = `rawEvents.findLast(e => e.role === "assistant")?.content ?? ""`.
5. If `rawEvents.length === 0`: throw `CLIShapeError` ("stream-json requested but no parseable events"), with the raw stdout attached.

## CLI shape drift detection

On every successful call:
1. If `trailingSessionLine` regex doesn't match the tail of stdout AND `outputFormat === "text"`, log:
   ```
   level=warn event=cli_shape_drift hint="trailing session line missing" cli_version=<v>
   ```
2. If `streamJsonShape.safeParse` fails on >50% of lines, log:
   ```
   level=warn event=cli_shape_drift hint="stream-json events not matching expected shape" cli_version=<v>
   ```
3. After 3 drift events in a single process lifetime, the adapter starts including a `cli_shape_drift: true` flag on subsequent tool responses, surfaced via `kimi_status`. This is observability, not a hard fail — the user gets a heads-up that the plugin needs updating.

## Error taxonomy (returned to MCP)

| MCP error code | When |
|---|---|
| `validation_error` | Zod schema rejects the MCP tool input |
| `auth_missing` | P0-E probe = `missing` |
| `auth_invalid` | CLI returns auth failure (parsed from stderr regex per compat entry) |
| `timeout` | Kill ladder fired |
| `cli_not_found` | `kimi` binary not in PATH |
| `cli_version_unsupported` | No compat-entry match AND user wants strict mode |
| `cli_shape_error` | Stdout/stderr couldn't be parsed at all |
| `cli_exit_nonzero` | Generic exit code != 0 with no more specific classification |
| `subprocess_killed_external` | SIGTERM/SIGKILL we didn't send |

Each error includes: `code`, `message` (human), `details` (object with `stdout_excerpt`, `stderr_excerpt`, `argv_redacted`, `duration_ms`).

## What changes per plugin minor version

| Plugin change | Adapter impact |
|---|---|
| New MCP tool added | New tool fn; uses existing `runKimi`. No adapter change. |
| `kimi` CLI gains a new flag | Add to flagMap of newest compat entry; bump plugin patch version. |
| `kimi` CLI changes existing flag name | Add a new compat entry for the new version range; old entries unchanged. Bump plugin minor version. |
| `kimi` CLI changes stdout shape | Add new compat entry with new parser. Bump plugin minor version. |

Old compat entries are kept indefinitely so users on older CLI versions don't break.

## Test cases (TDD)

- Pure unit (no real CLI):
  - text mode parser on captured `sample-stream-json.txt`'s stderr-style output (negative: should still return without sessionId) — wait, that's stream-json; clarify per fixture
  - text mode parser on canned `<msg>\n\nTo resume this session: kimi -r <uuid>\n` → sessionId extracted, finalMessage clean
  - stream-json parser on canned multi-line JSON + trailing marker → events parsed, sessionId extracted
  - stream-json with 1 bad line in 5 → 4 events parsed, no error
  - stream-json with 0 valid lines → CLIShapeError
  - argv builder: workDir="/abs/path", model="X" → matches expected argv exactly per snapshot test
  - argv never includes raw user prompt as a flag value (it's the final positional arg or stdin)
- Integration (real CLI, opt-in via env flag KIMI_PLUGIN_INTEGRATION=1):
  - `kimi --version` parsed
  - Round-trip: simple query in text mode returns valid `finalMessage` and a UUID sessionId
  - Resume: second call with that sessionId reuses it (sessionId in result equals input)

## Files this spec implies

```
plugins/kimi/scripts/mcp-server/src/
  adapter/
    runner.ts              # runKimi(): the entry point
    argv.ts                # builds argv from KimiInvocation per compat entry
    parser-text.ts
    parser-stream-json.ts
    compat-table.ts        # CLI_COMPAT array, ordered newest-first
    errors.ts              # error code constants + factory
  tools/
    status.ts              # uses adapter directly + own probes
    query.ts               # thin wrapper → runKimi
    analyze.ts
    review.ts
    implement.ts           # also enforces P0-C worktree before calling runKimi
    resume.ts
```
