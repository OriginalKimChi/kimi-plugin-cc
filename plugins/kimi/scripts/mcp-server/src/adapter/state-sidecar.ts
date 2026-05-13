import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { sessionsDir } from "./state-paths.js";

export const SIDECAR_SCHEMA_VERSION = 1 as const;
export const SIDECAR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SIDECAR_MAX_FILES = 200;

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;

export type SidecarTool =
  | "kimi_query"
  | "kimi_resume"
  | "kimi_analyze"
  | "kimi_review"
  | "kimi_implement";

export type SidecarSource = "mcp" | "companion";

export type SidecarPhase = "running" | "completed" | "failed" | "cancelled";

export interface SidecarV1 {
  schema_version: typeof SIDECAR_SCHEMA_VERSION;
  session_id: string;
  tool: SidecarTool;
  source: SidecarSource;
  job_id: string | null;
  cwd: string;
  phase: SidecarPhase;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  killed_by: string | null;
  trailing_marker_missing: boolean;
  plugin_version: string;
}

export function isValidSessionId(id: unknown): boolean {
  return typeof id === "string" && SESSION_ID_RE.test(id);
}

export function writeSidecar(payload: SidecarV1): void {
  if (!isValidSessionId(payload.session_id)) {
    throw new Error(`invalid session_id: ${JSON.stringify(payload.session_id)}`);
  }
  const dir = sessionsDir(payload.cwd);
  mkdirSync(dir, { recursive: true });
  const final = path.join(dir, `${payload.session_id}.json`);
  const tmp = `${final}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, final);
  gc(dir);
}

export function readSidecar(cwd: string, sessionId: string): SidecarV1 | null {
  if (!isValidSessionId(sessionId)) return null;
  const dir = sessionsDir(cwd);
  const file = path.join(dir, `${sessionId}.json`);
  if (!existsSync(file)) return null;
  return parseFile(file);
}

export function listSidecars(cwd: string): SidecarV1[] {
  const dir = sessionsDir(cwd);
  if (!existsSync(dir)) return [];
  const out: SidecarV1[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json") || name.endsWith(".tmp")) continue;
    const parsed = parseFile(path.join(dir, name));
    if (parsed) out.push(parsed);
  }
  out.sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0));
  return out;
}

function parseFile(file: string): SidecarV1 | null {
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as SidecarV1;
    if (parsed.schema_version !== SIDECAR_SCHEMA_VERSION) return null;
    if (!isValidSessionId(parsed.session_id)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function gc(dir: string): void {
  const entries: Array<{ file: string; mtimeMs: number }> = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    try {
      const st = statSync(file);
      entries.push({ file, mtimeMs: st.mtimeMs });
    } catch {
      // skip
    }
  }
  const cutoff = Date.now() - SIDECAR_TTL_MS;
  const survivors: Array<{ file: string; mtimeMs: number }> = [];
  for (const e of entries) {
    if (e.mtimeMs < cutoff) {
      safeUnlink(e.file);
    } else {
      survivors.push(e);
    }
  }
  if (survivors.length > SIDECAR_MAX_FILES) {
    survivors.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const dead of survivors.slice(SIDECAR_MAX_FILES)) {
      safeUnlink(dead.file);
    }
  }
}

function safeUnlink(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // best-effort
  }
}
