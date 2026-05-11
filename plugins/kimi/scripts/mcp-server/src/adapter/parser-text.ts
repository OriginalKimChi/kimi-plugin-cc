export interface ParsedTextStdout {
  finalMessage: string;
  sessionId: string | null;
  trailingMarkerMissing: boolean;
}

const SESSION_LINE = /^[ \t]*To resume this session: kimi -r ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[ \t\r]*$/gm;

export function parseTextStdout(stdout: string): ParsedTextStdout {
  if (stdout.length === 0) {
    return { finalMessage: "", sessionId: null, trailingMarkerMissing: true };
  }

  SESSION_LINE.lastIndex = 0;
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = SESSION_LINE.exec(stdout)) !== null) lastMatch = m;

  if (lastMatch === null) {
    return {
      finalMessage: stdout.replace(/[\r\n]+$/, ""),
      sessionId: null,
      trailingMarkerMissing: true,
    };
  }

  const before = stdout.slice(0, lastMatch.index).replace(/[\r\n]+$/, "");
  return {
    finalMessage: before,
    sessionId: lastMatch[1] ?? null,
    trailingMarkerMissing: false,
  };
}
