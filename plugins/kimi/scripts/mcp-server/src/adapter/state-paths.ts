import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const STATE_DIR_ENV = "KIMI_STATE_DIR";
const FALLBACK_STATE_ROOT = path.join(os.tmpdir(), "kimi-companion");
const SESSIONS_SUBDIR = "sessions";

export function resolveWorkspaceRoot(cwd: string): string {
  const start = path.resolve(cwd);
  const stop = path.parse(start).root;
  let cursor = start;
  while (true) {
    try {
      if (existsSync(path.join(cursor, ".git"))) return cursor;
    } catch {
      // ignore — keep walking
    }
    if (cursor === stop) return start;
    const parent = path.dirname(cursor);
    if (parent === cursor) return start;
    cursor = parent;
  }
}

export function resolveStateDir(cwd: string): string {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonical = workspaceRoot;
  try {
    canonical = realpathSync.native
      ? realpathSync.native(workspaceRoot)
      : realpathSync(workspaceRoot);
  } catch {
    canonical = workspaceRoot;
  }
  const slugSrc = path.basename(workspaceRoot) || "workspace";
  const slug =
    slugSrc.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);

  const root = resolveStateRoot();
  return path.join(root, `${slug}-${hash}`);
}

export function sessionsDir(cwd: string): string {
  return path.join(resolveStateDir(cwd), SESSIONS_SUBDIR);
}

function resolveStateRoot(): string {
  const forced = process.env[STATE_DIR_ENV];
  if (forced && forced.length > 0) return forced;
  const dataDir = process.env[PLUGIN_DATA_ENV];
  if (dataDir && dataDir.length > 0) return path.join(dataDir, "state");
  return FALLBACK_STATE_ROOT;
}
