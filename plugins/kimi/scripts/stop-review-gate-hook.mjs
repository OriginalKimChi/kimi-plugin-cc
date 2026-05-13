#!/usr/bin/env node
/**
 * Kimi plugin Stop hook — optional review gate.
 *
 * Reads stop hook input from stdin:
 *   { session_id, cwd, last_assistant_message, hook_event_name }
 *
 * If `config.stopReviewGate` (in the workspace's kimi-companion state.json) is
 * true, asks Kimi to review the previous Claude turn and emit a single first-line
 * verdict:
 *
 *     ALLOW: <optional rationale>
 *     BLOCK: <reason>
 *
 * On BLOCK or on any malformed/timeout/error path, emits a Claude Code hook
 * decision payload to stdout to block the Stop:
 *
 *     { "decision": "block", "reason": "<why>" }
 *
 * Empty stdout = permit. stderr is shown to the user as a note.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const STOP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const STATE_DIR_ENV = "KIMI_STATE_DIR";
const FALLBACK_STATE_ROOT = path.join(os.tmpdir(), "kimi-companion");
const STATE_FILE_NAME = "state.json";
const KIMI_BIN = process.env.KIMI_BIN || "kimi";

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

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) return;
  process.stderr.write(`${message}\n`);
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

function resolveStateDir(cwd) {
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
  return path.join(root, `${slug}-${hash}`);
}

function readConfig(cwd) {
  const file = path.join(resolveStateDir(cwd), STATE_FILE_NAME);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && parsed.config && typeof parsed.config === "object"
      ? parsed.config
      : {};
  } catch {
    return {};
  }
}

function buildPrompt(input) {
  const lastMessage = String(input.last_assistant_message ?? "").trim();
  const block = lastMessage ? `Previous Claude response:\n${lastMessage}\n` : "";
  return [
    "You are a stop-time gate reviewer. The user is about to end a Claude Code session.",
    "Decide whether the previous turn left obvious problems that should be fixed before the user walks away.",
    "",
    "Reply with EXACTLY ONE LINE as your final message:",
    "  ALLOW: <one-sentence rationale, optional>",
    "    or",
    "  BLOCK: <one-sentence concrete reason citing what is broken or unsafe>",
    "",
    "Do not output anything else on the first line. Anything after the first line is ignored.",
    "Block ONLY for clear regressions, broken builds, security issues, or visibly incomplete edits — not for style nits or future improvements.",
    "",
    block,
  ].join("\n");
}

function parseVerdict(raw) {
  const text = String(raw ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason:
        "The Kimi stop-time review returned no output. Run /kimi:review --wait manually or run `/kimi:setup --disable-review-gate` to bypass.",
    };
  }
  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:") || firstLine === "ALLOW") {
    return { ok: true, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      reason: `Kimi stop-time review flagged work to finish before ending the session: ${reason}`,
    };
  }
  return {
    ok: false,
    reason:
      "The Kimi stop-time review returned an unexpected verdict. Run /kimi:review --wait manually or `/kimi:setup --disable-review-gate` to bypass.",
  };
}

function runKimiReview(cwd, input) {
  const prompt = buildPrompt(input);
  const argv = ["--print", "--output-format", "text", "--quiet", "--prompt", prompt];
  const result = spawnSync(KIMI_BIN, argv, {
    cwd,
    env: process.env,
    encoding: "utf8",
    timeout: STOP_REVIEW_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });

  if (result.error?.code === "ETIMEDOUT") {
    return {
      ok: false,
      reason:
        "The Kimi stop-time review timed out after 15 minutes. Run /kimi:review --wait manually or `/kimi:setup --disable-review-gate` to bypass.",
    };
  }
  if (result.error?.code === "ENOENT") {
    return {
      ok: false,
      reason:
        "The Kimi CLI is not on PATH. Run `/kimi:setup` to install it or `/kimi:setup --disable-review-gate` to bypass.",
    };
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim().slice(0, 800);
    return {
      ok: false,
      reason: detail
        ? `The Kimi stop-time review failed (exit=${result.status}): ${detail}`
        : `The Kimi stop-time review failed (exit=${result.status}). Run /kimi:review --wait manually or \`/kimi:setup --disable-review-gate\` to bypass.`,
    };
  }
  return parseVerdict(result.stdout);
}

function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const cfg = readConfig(cwd);
  if (!cfg.stopReviewGate) {
    return; // gate disabled — permit silently
  }
  const review = runKimiReview(cwd, input);
  if (!review.ok) {
    emitDecision({ decision: "block", reason: review.reason });
    return;
  }
  // permit silently on ALLOW
}

try {
  main();
} catch (err) {
  // Fail-open: don't block stop just because the hook crashed; surface a note.
  process.stderr.write(`kimi stop-gate hook error: ${err instanceof Error ? err.message : String(err)}\n`);
}
