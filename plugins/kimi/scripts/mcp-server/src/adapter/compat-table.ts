export interface CompatEntry {
  id: string;
  matchMajorMinor: { major: number; minor: number };
  supported: boolean;
  trailingSessionLine: RegExp;
  notes?: string;
}

const TRAILING_LINE_V1_41 =
  /^[ \t]*To resume this session: kimi -r ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[ \t\r]*$/m;

export const CLI_COMPAT: CompatEntry[] = [
  {
    id: "v1.41",
    matchMajorMinor: { major: 1, minor: 41 },
    supported: true,
    trailingSessionLine: TRAILING_LINE_V1_41,
    notes: "Probed against kimi-cli 1.41.0 on 2026-05-11 (see docs/fixtures/cli-probe).",
  },
];

const VERSION_LINE = /kimi,\s+version\s+(\d+\.\d+\.\d+(?:[-+][\w.+-]+)?)/;

export function parseKimiVersion(stdout: string): string | null {
  const m = VERSION_LINE.exec(stdout);
  return m ? m[1]! : null;
}

export function selectCompatEntry(version: string | null): CompatEntry {
  const newest = CLI_COMPAT[CLI_COMPAT.length - 1]!;
  if (version === null) {
    return { ...newest, supported: false };
  }
  const m = /^(\d+)\.(\d+)\./.exec(version);
  if (m === null) {
    return { ...newest, supported: false };
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  for (const entry of CLI_COMPAT) {
    if (entry.matchMajorMinor.major === major && entry.matchMajorMinor.minor === minor) {
      return entry;
    }
  }
  return { ...newest, supported: false };
}
