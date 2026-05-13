#!/usr/bin/env node
/**
 * Kimi plugin session lifecycle hook.
 *
 *   SessionStart  — appends KIMI_SESSION_ID to CLAUDE_ENV_FILE so subprocesses
 *                   (stop hook, future tooling) see the Claude Code session id.
 *                   Best-effort: never fails the session start.
 *
 *   SessionEnd    — prunes sidecar files older than 7 days. Capped TTL handled
 *                   by writers; this is belt + suspenders.
 *
 * Reads a single JSON object from stdin: `{ session_id, cwd, hook_event_name }`.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const SESSION_ID_ENV = "KIMI_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const STATE_DIR_ENV = "KIMI_STATE_DIR";
const FALLBACK_STATE_ROOT = path.join(os.tmpdir(), "kimi-companion");
const SESSIONS_DIR_NAME = "sessions";
const SIDECAR_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function readHookInput() {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8").trim();
  } catch {
    return {};
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function appendEnvVar(name, value) {
  const file = process.env.CLAUDE_ENV_FILE;
  if (!file || value == null || value === "") return;
  try {
    fs.appendFileSync(file, `export ${name}=${shellEscape(value)}\n`, "utf8");
  } catch {
    // best-effort
  }
}

function resolveWorkspaceRoot(cwd) {
  const start = path.resolve(cwd);
  const stop = path.parse(start).root;
  let cursor = start;
  while (true) {
    try {
      if (fs.existsSync(path.join(cursor, ".git"))) return cursor;
    } catch {}
    if (cursor === stop) return start;
    const parent = path.dirname(cursor);
    if (parent === cursor) return start;
    cursor = parent;
  }
}

function sessionsDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonical = workspaceRoot;
  try {
    canonical = fs.realpathSync.native
      ? fs.realpathSync.native(workspaceRoot)
      : fs.realpathSync(workspaceRoot);
  } catch {
    canonical = workspaceRoot;
  }
  const slugSrc = path.basename(workspaceRoot) || "workspace";
  const slug =
    slugSrc.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const forced = process.env[STATE_DIR_ENV];
  const dataDir = process.env[PLUGIN_DATA_ENV];
  let root;
  if (forced && forced.length > 0) root = forced;
  else if (dataDir && dataDir.length > 0) root = path.join(dataDir, "state");
  else root = FALLBACK_STATE_ROOT;
  return path.join(root, `${slug}-${hash}`, SESSIONS_DIR_NAME);
}

function pruneStaleSidecars(cwd) {
  const dir = sessionsDir(cwd);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - SIDECAR_TTL_MS;
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs < cutoff) fs.rmSync(file, { force: true });
    } catch {
      // best-effort
    }
  }
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  pruneStaleSidecars(cwd);
}

function main() {
  const input = readHookInput();
  const event = process.argv[2] ?? input.hook_event_name ?? "";
  if (event === "SessionStart") {
    handleSessionStart(input);
    return;
  }
  if (event === "SessionEnd") {
    handleSessionEnd(input);
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  // never fail the session lifecycle
}
