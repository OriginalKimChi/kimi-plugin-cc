export interface KimiStreamEvent {
  role: string;
  content?: string;
  [k: string]: unknown;
}

export interface ParsedStreamJsonStdout {
  events: KimiStreamEvent[];
  finalMessage: string;
  sessionId: string | null;
  trailingMarkerMissing: boolean;
  malformedLines: number;
}

const SESSION_LINE = /^[ \t]*To resume this session: kimi -r ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[ \t\r]*$/;

export function parseStreamJsonStdout(stdout: string): ParsedStreamJsonStdout {
  if (stdout.length === 0) {
    return {
      events: [],
      finalMessage: "",
      sessionId: null,
      trailingMarkerMissing: true,
      malformedLines: 0,
    };
  }

  const lines = stdout.split(/\r?\n/);
  const events: KimiStreamEvent[] = [];
  let sessionId: string | null = null;
  let malformedLines = 0;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (line === "") continue;

    const m = SESSION_LINE.exec(line);
    if (m !== null) {
      sessionId = m[1] ?? null;
      continue;
    }

    try {
      const parsed = JSON.parse(line) as KimiStreamEvent;
      if (parsed && typeof parsed === "object" && typeof parsed.role === "string") {
        events.push(parsed);
      } else {
        malformedLines += 1;
      }
    } catch {
      malformedLines += 1;
    }
  }

  const lastAssistantWithContent = [...events]
    .reverse()
    .find((e) => e.role === "assistant" && typeof e.content === "string");
  const finalMessage = lastAssistantWithContent?.content ?? "";

  return {
    events,
    finalMessage,
    sessionId,
    trailingMarkerMissing: sessionId === null,
    malformedLines,
  };
}
