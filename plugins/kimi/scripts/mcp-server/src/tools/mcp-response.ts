import type { KimiResult } from "../adapter/runner.js";

export interface MCPToolResponse {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function errorEnvelope(
  code: string,
  message: string,
  details: unknown,
): MCPToolResponse {
  return {
    isError: true,
    content: [
      { type: "text", text: JSON.stringify({ code, message, details }, null, 2) },
    ],
    structuredContent: { code, message, details: details as Record<string, unknown> },
  };
}

export function textResultEnvelope(r: KimiResult): MCPToolResponse {
  return {
    content: [{ type: "text", text: r.finalMessage }],
    structuredContent: {
      session_id: r.sessionId,
      exit_code: r.exitCode,
      duration_ms: r.durationMs,
      stdout_bytes: r.stdoutBytes,
      stderr_bytes: r.stderrBytes,
      trailing_marker_missing: r.trailingMarkerMissing,
    },
  };
}
