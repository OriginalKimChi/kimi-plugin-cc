import { randomBytes } from "node:crypto";
import { promises as fsp, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const TEMP_CONFIG_PREFIX = "kimi-plugin-";
const NUL = String.fromCharCode(0);

export type TempConfigSource = "kimi_code" | "moonshot";

export interface WriteTempConfigOptions {
  apiKey: string;
  source: TempConfigSource;
}

export interface TempConfigHandle {
  filePath: string;
  cleanup: () => Promise<{ removed: boolean }>;
}

export function writeTempConfig(opts: WriteTempConfigOptions): TempConfigHandle {
  const { apiKey, source } = opts;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new Error("temp-config: apiKey must be a non-empty string");
  }
  if (apiKey.includes(NUL) || apiKey.includes("\n") || apiKey.includes("\r")) {
    throw new Error("temp-config: apiKey must not contain NUL or newline characters");
  }
  if (apiKey.includes('"') || apiKey.includes("\\")) {
    // Quote / backslash in the key would break the TOML string literal.
    throw new Error("temp-config: apiKey must not contain '\"' or '\\\\'");
  }

  const filePath = path.join(
    os.tmpdir(),
    `${TEMP_CONFIG_PREFIX}${randomBytes(12).toString("hex")}.toml`,
  );

  const stanza = source === "moonshot" ? '[providers."moonshot"]' : '[providers."managed:kimi-code"]';
  const content = `${stanza}\napi_key = "${apiKey}"\n`;

  // 0600 — owner read/write only.
  writeFileSync(filePath, content, { mode: 0o600 });

  let cleaned = false;
  return {
    filePath,
    cleanup: async () => {
      if (cleaned) return { removed: false };
      cleaned = true;
      try {
        await fsp.unlink(filePath);
        return { removed: true };
      } catch {
        return { removed: false };
      }
    },
  };
}

export interface CleanupOrphansOptions {
  maxAgeMs: number;
  dir?: string;
}

export interface CleanupOrphansResult {
  removed: string[];
  skipped: string[];
}

export async function cleanupOrphanedTempConfigs(
  opts: CleanupOrphansOptions,
): Promise<CleanupOrphansResult> {
  const dir = opts.dir ?? os.tmpdir();
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return { removed: [], skipped: [] };
  }
  const removed: string[] = [];
  const skipped: string[] = [];
  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith(TEMP_CONFIG_PREFIX) || !name.endsWith(".toml")) continue;
    const full = path.join(dir, name);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      if (now - st.mtimeMs >= opts.maxAgeMs) {
        await fsp.unlink(full);
        removed.push(full);
      } else {
        skipped.push(full);
      }
    } catch {
      skipped.push(full);
    }
  }
  return { removed, skipped };
}
