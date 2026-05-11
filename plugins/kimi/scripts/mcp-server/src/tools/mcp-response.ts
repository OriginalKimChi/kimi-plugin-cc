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
  const structuredContent: Record<string, unknown> = {
    session_id: r.sessionId,
    exit_code: r.exitCode,
    duration_ms: r.durationMs,
    stdout_bytes: r.stdoutBytes,
    stderr_bytes: r.stderrBytes,
    trailing_marker_missing: r.trailingMarkerMissing,
  };
  // stream-json mode populates rawEvents; surface them so downstream callers
  // can inspect the full event stream alongside the final assistant message.
  if (r.rawEvents !== undefined) {
    structuredContent.raw_events = r.rawEvents;
  }
  return {
    content: [{ type: "text", text: r.finalMessage }],
    structuredContent,
  };
}
