import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SIDECAR_MAX_FILES,
  SIDECAR_SCHEMA_VERSION,
  SIDECAR_TTL_MS,
  isValidSessionId,
  listSidecars,
  readSidecar,
  writeSidecar,
  type SidecarV1,
} from "../../src/adapter/state-sidecar.js";
import { sessionsDir } from "../../src/adapter/state-paths.js";

const UUID = "12345678-1234-1234-1234-123456789abc";
const savedEnv = { ...process.env };
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "kimi-sidecar-"));
  process.env.KIMI_STATE_DIR = path.join(tmp, "root");
  delete process.env.CLAUDE_PLUGIN_DATA;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of ["KIMI_STATE_DIR", "CLAUDE_PLUGIN_DATA"]) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function basePayload(overrides: Partial<SidecarV1> = {}): SidecarV1 {
  return {
    schema_version: SIDECAR_SCHEMA_VERSION,
    session_id: UUID,
    tool: "kimi_query",
    source: "mcp",
    job_id: null,
    cwd: tmp,
    phase: "completed",
    started_at: "2026-05-13T00:00:00.000Z",
    finished_at: "2026-05-13T00:00:01.000Z",
    exit_code: 0,
    duration_ms: 1000,
    killed_by: null,
    trailing_marker_missing: false,
    plugin_version: "0.3.0",
    ...overrides,
  };
}

describe("isValidSessionId", () => {
  it("accepts canonical UUIDs and slug-like ids 8..128 chars", () => {
    expect(isValidSessionId(UUID)).toBe(true);
    expect(isValidSessionId("abcd1234")).toBe(true);
    expect(isValidSessionId("A".repeat(128))).toBe(true);
  });

  it("rejects path traversal, empties, separators, too-short", () => {
    expect(isValidSessionId("../etc/passwd")).toBe(false);
    expect(isValidSessionId("")).toBe(false);
    expect(isValidSessionId("short")).toBe(false);
    expect(isValidSessionId("a/b/c/d/e/f/g")).toBe(false);
    expect(isValidSessionId("with space")).toBe(false);
    expect(isValidSessionId("A".repeat(129))).toBe(false);
  });
});

describe("writeSidecar", () => {
  it("writes <sessionsDir>/<session_id>.json and round-trips via readSidecar", () => {
    writeSidecar(basePayload());
    const dir = sessionsDir(tmp);
    const file = path.join(dir, `${UUID}.json`);
    expect(readFileSync(file, "utf8")).toContain(UUID);
    const round = readSidecar(tmp, UUID);
    expect(round?.session_id).toBe(UUID);
    expect(round?.tool).toBe("kimi_query");
    expect(round?.phase).toBe("completed");
  });

  it("creates the sessions directory if missing", () => {
    writeSidecar(basePayload());
    const dir = sessionsDir(tmp);
    expect(readdirSync(dir).length).toBeGreaterThan(0);
  });

  it("overwrites an existing sidecar for the same session_id", () => {
    writeSidecar(basePayload({ phase: "running", exit_code: null, finished_at: null }));
    writeSidecar(basePayload({ phase: "completed", exit_code: 0 }));
    const round = readSidecar(tmp, UUID);
    expect(round?.phase).toBe("completed");
    expect(round?.exit_code).toBe(0);
  });

  it("rejects writes when session_id is malformed", () => {
    expect(() => writeSidecar(basePayload({ session_id: "../evil" }))).toThrow();
  });

  it("is atomic — no .tmp file lingers after success", () => {
    writeSidecar(basePayload());
    const dir = sessionsDir(tmp);
    const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});

describe("listSidecars", () => {
  it("returns parsed sidecars sorted by started_at descending", () => {
    writeSidecar(basePayload({ session_id: "session-aaaaaaaa", started_at: "2026-05-13T00:00:00Z" }));
    writeSidecar(basePayload({ session_id: "session-bbbbbbbb", started_at: "2026-05-13T01:00:00Z" }));
    const list = listSidecars(tmp);
    expect(list.map((s) => s.session_id)).toEqual(["session-bbbbbbbb", "session-aaaaaaaa"]);
  });

  it("ignores corrupt / non-JSON files", () => {
    writeSidecar(basePayload());
    const dir = sessionsDir(tmp);
    writeFileSync(path.join(dir, "garbage.json"), "{ not json", "utf8");
    const list = listSidecars(tmp);
    expect(list.length).toBe(1);
  });

  it("returns [] when sessions dir does not exist", () => {
    expect(listSidecars(tmp)).toEqual([]);
  });
});

describe("garbage collection", () => {
  it("prunes sidecars older than SIDECAR_TTL_MS", () => {
    writeSidecar(basePayload({ session_id: "session-old00000" }));
    const dir = sessionsDir(tmp);
    const oldFile = path.join(dir, "session-old00000.json");
    const ancient = new Date(Date.now() - SIDECAR_TTL_MS - 60_000);
    utimesSync(oldFile, ancient, ancient);
    // Trigger GC by writing a new sidecar
    writeSidecar(basePayload({ session_id: "session-new00000" }));
    const remaining = readdirSync(dir);
    expect(remaining).toContain("session-new00000.json");
    expect(remaining).not.toContain("session-old00000.json");
  });

  it("caps the directory at SIDECAR_MAX_FILES, keeping newest by mtime", () => {
    const total = SIDECAR_MAX_FILES + 5;
    for (let i = 0; i < total; i++) {
      const id = `session-${String(i).padStart(8, "0")}`;
      writeSidecar(basePayload({ session_id: id }));
      // Force monotonically increasing mtime so order is deterministic
      const f = path.join(sessionsDir(tmp), `${id}.json`);
      const ts = new Date(Date.now() - (total - i) * 1000);
      utimesSync(f, ts, ts);
    }
    // Touch the newest write to re-trigger GC under the cap
    writeSidecar(basePayload({ session_id: "session-zzzzzzzz" }));
    const remaining = readdirSync(sessionsDir(tmp));
    expect(remaining.length).toBeLessThanOrEqual(SIDECAR_MAX_FILES);
    expect(remaining).toContain("session-zzzzzzzz.json");
  });
});
