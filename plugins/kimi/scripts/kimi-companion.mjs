#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)));
const SCRIPT_PATH = path.join(ROOT_DIR, "kimi-companion.mjs");

const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const STATE_DIR_ENV = "KIMI_STATE_DIR";
const FALLBACK_STATE_ROOT = path.join(os.tmpdir(), "kimi-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const SESSIONS_DIR_NAME = "sessions";
const SIDECAR_SCHEMA_VERSION = 1;
const SIDECAR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SIDECAR_MAX_FILES = 200;
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;
const PLUGIN_VERSION = "0.3.0";
const MAX_JOBS = 50;
const SESSION_LINE_RE =
  /^[ \t]*To resume this session: kimi -r ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[ \t\r]*$/gm;
const STDOUT_CAP_BYTES = 4 * 1024 * 1024;
const STDERR_CAP_BYTES = 1 * 1024 * 1024;
const FOREGROUND_DEFAULT_TIMEOUT_SECONDS = 600;
const BACKGROUND_DEFAULT_TIMEOUT_SECONDS = 1800;
const MAX_TIMEOUT_SECONDS = 7200;

const KIMI_BIN = process.env.KIMI_BIN || "kimi";

const AUTH_PATTERNS = [
  /not authenticated/i,
  /please run `?kimi login`?/i,
  /no credentials? found/i,
  /credentials? expired/i,
  /unauthorized/i,
  /401/,
];

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/kimi-companion.mjs task [--background] [--write|--read-only] [--resume <session>|--fresh] [--model <m>] [--cwd <dir>] [--timeout-seconds <n>] [--json] [prompt]",
      "  node scripts/kimi-companion.mjs status [job-id] [--cwd <dir>] [--all] [--json]",
      "  node scripts/kimi-companion.mjs result <job-id|latest> [--cwd <dir>] [--json]",
      "  node scripts/kimi-companion.mjs cancel <job-id> [--cwd <dir>] [--json]",
      "  node scripts/kimi-companion.mjs config [show] [--enable-review-gate|--disable-review-gate] [--cwd <dir>] [--json]",
      "",
    ].join("\n"),
  );
}

// --- arg parsing ------------------------------------------------------------

function parseArgs(argv, { booleans = [], values = [] }) {
  const options = {};
  const positionals = [];
  for (const k of booleans) options[k] = false;
  for (const k of values) options[k] = undefined;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!tok.startsWith("--")) {
      positionals.push(tok);
      continue;
    }
    const eq = tok.indexOf("=");
    const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
    if (booleans.includes(name)) {
      options[name] = true;
      continue;
    }
    if (values.includes(name)) {
      if (eq !== -1) {
        options[name] = tok.slice(eq + 1);
      } else {
        i += 1;
        if (i >= argv.length) throw new Error(`Missing value for --${name}`);
        options[name] = argv[i];
      }
      continue;
    }
    throw new Error(`Unknown option: --${name}`);
  }
  return { options, positionals };
}

// --- state directory --------------------------------------------------------

function resolveWorkspaceRoot(cwd) {
  let dir = path.resolve(cwd || process.cwd());
  const stop = path.parse(dir).root;
  // Walk up looking for .git; fall back to the original cwd if not found.
  let cursor = dir;
  while (true) {
    try {
      if (fs.existsSync(path.join(cursor, ".git"))) return cursor;
    } catch {}
    if (cursor === stop) return dir;
    const parent = path.dirname(cursor);
    if (parent === cursor) return dir;
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

function sessionsDir(cwd) {
  return path.join(resolveStateDir(cwd), SESSIONS_DIR_NAME);
}

function extractSessionIdFromText(text) {
  if (!text) return null;
  SESSION_LINE_RE.lastIndex = 0;
  let last = null;
  let m;
  while ((m = SESSION_LINE_RE.exec(text)) !== null) last = m;
  return last ? last[1] ?? null : null;
}

function isValidSessionId(id) {
  return typeof id === "string" && SESSION_ID_RE.test(id);
}

function writeSessionSidecar(payload) {
  if (!isValidSessionId(payload.session_id)) return;
  const dir = sessionsDir(payload.cwd);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = path.join(dir, `${payload.session_id}.json`);
    const tmpPath = `${finalPath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmpPath, finalPath);
    gcSidecars(dir);
  } catch {
    // best-effort
  }
}

function gcSidecars(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  const records = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      records.push({ file, mtimeMs: st.mtimeMs });
    } catch {
      // skip
    }
  }
  const cutoff = Date.now() - SIDECAR_TTL_MS;
  const survivors = [];
  for (const r of records) {
    if (r.mtimeMs < cutoff) safeUnlink(r.file);
    else survivors.push(r);
  }
  if (survivors.length > SIDECAR_MAX_FILES) {
    survivors.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const dead of survivors.slice(SIDECAR_MAX_FILES)) safeUnlink(dead.file);
  }
}

function jobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

function ensureStateDir(cwd) {
  fs.mkdirSync(jobsDir(cwd), { recursive: true });
}

function stateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

function jobJsonPath(cwd, id) {
  ensureStateDir(cwd);
  return path.join(jobsDir(cwd), `${id}.json`);
}

function jobLogPath(cwd, id) {
  ensureStateDir(cwd);
  return path.join(jobsDir(cwd), `${id}.log`);
}

function nowIso() {
  return new Date().toISOString();
}

function loadState(cwd) {
  const f = stateFile(cwd);
  if (!fs.existsSync(f)) return { jobs: [], config: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(f, "utf8"));
    return {
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
      config: isPlainObject(parsed.config) ? parsed.config : {},
    };
  } catch {
    return { jobs: [], config: {} };
  }
}

function saveState(cwd, state) {
  ensureStateDir(cwd);
  const nextJobs = [...(state.jobs ?? [])]
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
  // GC files for jobs that no longer fit.
  const retained = new Set(nextJobs.map((j) => j.id));
  const prev = loadState(cwd).jobs;
  for (const j of prev) {
    if (retained.has(j.id)) continue;
    safeUnlink(jobJsonPath(cwd, j.id));
    safeUnlink(jobLogPath(cwd, j.id));
  }
  const nextConfig = isPlainObject(state.config) ? state.config : {};
  fs.writeFileSync(
    stateFile(cwd),
    `${JSON.stringify({ jobs: nextJobs, config: nextConfig }, null, 2)}\n`,
    "utf8",
  );
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function getConfig(cwd) {
  return loadState(cwd).config ?? {};
}

function setConfig(cwd, patch) {
  const state = loadState(cwd);
  const next = { ...(state.config ?? {}), ...patch };
  saveState(cwd, { ...state, config: next });
  return next;
}

function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch {}
}

function upsertJob(cwd, patch) {
  const state = loadState(cwd);
  const ts = nowIso();
  const idx = state.jobs.findIndex((j) => j.id === patch.id);
  if (idx === -1) {
    state.jobs.unshift({ createdAt: ts, updatedAt: ts, ...patch });
  } else {
    state.jobs[idx] = { ...state.jobs[idx], ...patch, updatedAt: ts };
  }
  saveState(cwd, state);
}

function writeJobJson(cwd, id, payload) {
  fs.writeFileSync(jobJsonPath(cwd, id), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function readJobJson(cwd, id) {
  const f = jobJsonPath(cwd, id);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}

function appendLog(cwd, id, line) {
  const p = jobLogPath(cwd, id);
  fs.appendFileSync(p, `[${nowIso()}] ${line}\n`, "utf8");
}

function generateJobId() {
  const random = Math.random().toString(36).slice(2, 8);
  return `kimi-task-${Date.now().toString(36)}-${random}`;
}

function resolveJob(cwd, ref) {
  const state = loadState(cwd);
  if (!ref || ref === "latest") {
    if (state.jobs.length === 0) return null;
    return state.jobs[0];
  }
  return state.jobs.find((j) => j.id === ref) ?? null;
}

// --- kimi invocation --------------------------------------------------------

function buildKimiArgv({ prompt, model, resumeSessionId, workDir }) {
  const argv = ["--print", "--output-format", "text", "--quiet"];
  if (workDir) argv.push("--work-dir", workDir);
  if (resumeSessionId) argv.push("-r", resumeSessionId);
  if (model) argv.push("-m", model);
  argv.push("--prompt", prompt);
  return argv;
}

function isAuthFailure(stdout, stderr) {
  const haystack = `${stdout}\n${stderr}`;
  return AUTH_PATTERNS.some((re) => re.test(haystack));
}

function runKimi({ cwd, prompt, model, resumeSessionId, timeoutSeconds, onStderr }) {
  return new Promise((resolve) => {
    const argv = buildKimiArgv({ prompt, model, resumeSessionId });
    const started = Date.now();
    let killed = false;
    let killReason = null;

    const child = spawn(KIMI_BIN, argv, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTrunc = false;
    let stderrTrunc = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes <= STDOUT_CAP_BYTES) stdout += chunk;
      else stdoutTrunc = true;
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += Buffer.byteLength(chunk, "utf8");
      if (stderrBytes <= STDERR_CAP_BYTES) stderr += chunk;
      else stderrTrunc = true;
      if (onStderr) onStderr(chunk);
    });

    const timeout = setTimeout(() => {
      killed = true;
      killReason = "timeout";
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
    }, Math.min(timeoutSeconds, MAX_TIMEOUT_SECONDS) * 1000);

    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve({
        exitCode: null,
        signal: null,
        durationMs: Date.now() - started,
        stdout,
        stderr,
        stdoutTrunc,
        stderrTrunc,
        killReason: "spawn_error",
        spawnError: err.message,
        pid: child.pid ?? null,
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({
        exitCode: code,
        signal,
        durationMs: Date.now() - started,
        stdout,
        stderr,
        stdoutTrunc,
        stderrTrunc,
        killReason,
        spawnError: null,
        pid: child.pid ?? null,
      });
    });
  });
}

// --- rendering --------------------------------------------------------------

function shortenPrompt(text, max = 80) {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

function renderQueued(job) {
  return (
    `Kimi Task started in the background as ${job.id}. ` +
    `Check \`/kimi:status ${job.id}\` for progress, ` +
    `\`/kimi:result ${job.id}\` for output, ` +
    `\`/kimi:cancel ${job.id}\` to stop.\n`
  );
}

function renderForegroundResult(job, result) {
  const lines = [];
  if (result.finalMessage) lines.push(result.finalMessage.trimEnd());
  if (result.exitCode !== 0 || result.killReason) {
    lines.push("");
    lines.push(
      `[kimi exited code=${result.exitCode ?? "null"}` +
        (result.signal ? ` signal=${result.signal}` : "") +
        (result.killReason ? ` reason=${result.killReason}` : "") +
        `]`,
    );
    if (result.stderr) lines.push(result.stderr.trimEnd());
  }
  return `${lines.join("\n")}\n`;
}

function renderStatusList(jobs) {
  if (jobs.length === 0) return "No Kimi jobs found.\n";
  const rows = jobs.map((j) => {
    const updated = j.updatedAt ?? j.createdAt ?? "";
    return `  ${j.id}  ${j.status.padEnd(9)}  ${updated}  ${j.summary ?? ""}`;
  });
  return `${rows.join("\n")}\n`;
}

function renderJobStatus(job) {
  const lines = [
    `Job ${job.id}`,
    `  status     ${job.status}`,
    `  title      ${job.title ?? "Kimi Task"}`,
    `  summary    ${job.summary ?? ""}`,
    `  pid        ${job.pid ?? "—"}`,
    `  created    ${job.createdAt ?? ""}`,
    `  updated    ${job.updatedAt ?? ""}`,
  ];
  if (job.completedAt) lines.push(`  completed  ${job.completedAt}`);
  if (job.errorMessage) lines.push(`  error      ${job.errorMessage}`);
  if (job.logFile) lines.push(`  log        ${job.logFile}`);
  return `${lines.join("\n")}\n`;
}

function renderResult(job, stored) {
  const lines = [`Job ${job.id} — ${job.status}`];
  if (job.title) lines.push(job.title);
  lines.push("");
  if (stored?.result?.finalMessage) {
    lines.push(stored.result.finalMessage.trimEnd());
  } else if (job.errorMessage) {
    lines.push(`(error) ${job.errorMessage}`);
  } else {
    lines.push("(no output captured yet)");
  }
  return `${lines.join("\n")}\n`;
}

// --- commands ---------------------------------------------------------------

async function cmdTask(rawArgs) {
  const { options, positionals } = parseArgs(rawArgs, {
    booleans: ["background", "write", "read-only", "fresh", "json"],
    values: ["resume", "model", "cwd", "timeout-seconds"],
  });

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const prompt = positionals.join(" ").trim();
  if (!prompt) throw new Error("Missing prompt.");

  if (options.write && options["read-only"]) {
    throw new Error("Cannot combine --write and --read-only.");
  }
  if (options.resume && options.fresh) {
    throw new Error("Cannot combine --resume and --fresh.");
  }

  const writeMode = options.write || !options["read-only"];
  const timeoutSeconds = parseTimeout(
    options["timeout-seconds"],
    options.background ? BACKGROUND_DEFAULT_TIMEOUT_SECONDS : FOREGROUND_DEFAULT_TIMEOUT_SECONDS,
  );

  const id = generateJobId();
  const summary = shortenPrompt(prompt);
  const logFile = jobLogPath(cwd, id);
  fs.writeFileSync(logFile, "", "utf8");

  const baseJob = {
    id,
    status: "queued",
    title: "Kimi Task",
    summary,
    pid: null,
    write: writeMode,
    cwd,
    logFile,
  };

  const request = {
    cwd,
    prompt,
    model: options.model ?? null,
    resumeSessionId: options.resume ?? null,
    write: writeMode,
    timeoutSeconds,
  };

  if (options.background) {
    upsertJob(cwd, baseJob);
    writeJobJson(cwd, id, { ...baseJob, request });
    appendLog(cwd, id, "Queued for background execution.");
    const child = spawnDetachedWorker(cwd, id);
    upsertJob(cwd, { id, pid: child.pid ?? null });
    const stored = readJobJson(cwd, id) ?? {};
    writeJobJson(cwd, id, { ...stored, pid: child.pid ?? null });
    const payload = {
      jobId: id,
      status: "queued",
      title: baseJob.title,
      summary,
      logFile,
      pid: child.pid ?? null,
    };
    process.stdout.write(options.json ? `${JSON.stringify(payload, null, 2)}\n` : renderQueued(baseJob));
    return;
  }

  // Foreground.
  upsertJob(cwd, { ...baseJob, status: "running", pid: process.pid });
  writeJobJson(cwd, id, { ...baseJob, status: "running", pid: process.pid, request });
  appendLog(cwd, id, "Foreground task started.");
  const result = await runKimi({
    cwd,
    prompt,
    model: request.model,
    resumeSessionId: request.resumeSessionId,
    timeoutSeconds,
    onStderr: (chunk) => {
      try { fs.appendFileSync(logFile, chunk); } catch {}
    },
  });
  finalizeJob(cwd, id, result);
  const stored = readJobJson(cwd, id) ?? {};
  const job = resolveJob(cwd, id);
  process.stdout.write(
    options.json
      ? `${JSON.stringify({ job, result: stored.result }, null, 2)}\n`
      : renderForegroundResult(job, { ...result, finalMessage: stored.result?.finalMessage ?? "" }),
  );
  if (result.exitCode !== 0) process.exitCode = result.exitCode ?? 1;
}

function parseTimeout(raw, fallback) {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--timeout-seconds must be a positive number, got ${raw}`);
  return Math.min(Math.floor(n), MAX_TIMEOUT_SECONDS);
}

function spawnDetachedWorker(cwd, jobId) {
  const child = spawn(process.execPath, [SCRIPT_PATH, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child;
}

async function cmdTaskWorker(rawArgs) {
  const { options } = parseArgs(rawArgs, {
    booleans: [],
    values: ["cwd", "job-id"],
  });
  if (!options["job-id"]) throw new Error("task-worker requires --job-id");
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const id = options["job-id"];
  const stored = readJobJson(cwd, id);
  if (!stored) throw new Error(`No stored job ${id}`);
  const request = stored.request;
  if (!request) throw new Error(`Stored job ${id} missing request`);

  appendLog(cwd, id, `Worker pid=${process.pid} started.`);
  upsertJob(cwd, { id, status: "running", pid: process.pid });
  writeJobJson(cwd, id, { ...stored, status: "running", pid: process.pid });

  const result = await runKimi({
    cwd: request.cwd,
    prompt: request.prompt,
    model: request.model,
    resumeSessionId: request.resumeSessionId,
    timeoutSeconds: request.timeoutSeconds,
    onStderr: (chunk) => {
      try { fs.appendFileSync(stored.logFile ?? jobLogPath(cwd, id), chunk); } catch {}
    },
  });
  finalizeJob(cwd, id, result);
  appendLog(cwd, id, `Worker finished exitCode=${result.exitCode} kill=${result.killReason ?? "—"}`);
}

function finalizeJob(cwd, id, result) {
  const stored = readJobJson(cwd, id) ?? {};
  const completedAt = nowIso();
  let status;
  let errorMessage = null;
  if (result.killReason === "timeout") {
    status = "failed";
    errorMessage = "Timed out.";
  } else if (result.killReason === "cancelled") {
    status = "cancelled";
    errorMessage = "Cancelled.";
  } else if (result.spawnError) {
    status = "failed";
    errorMessage = `Failed to spawn kimi: ${result.spawnError}`;
  } else if (result.exitCode === 0) {
    status = "completed";
  } else if (isAuthFailure(result.stdout, result.stderr)) {
    status = "failed";
    errorMessage = "Kimi is not authenticated. Run `/kimi:setup`.";
  } else {
    status = "failed";
    errorMessage = `kimi exited with code ${result.exitCode}.`;
  }
  const finalMessage = (result.stdout ?? "").trimEnd();
  const next = {
    ...stored,
    status,
    pid: null,
    completedAt,
    errorMessage,
    result: {
      finalMessage,
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
      stderrTail: tail(result.stderr ?? "", 2048),
      stdoutTruncated: result.stdoutTrunc,
    },
  };
  writeJobJson(cwd, id, next);
  upsertJob(cwd, { id, status, pid: null, completedAt, errorMessage });

  const sessionId =
    extractSessionIdFromText(result.stdout) ?? extractSessionIdFromText(result.stderr);
  if (sessionId) {
    const startedAt = stored.createdAt ?? completedAt;
    const sidecarPhase =
      status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed";
    writeSessionSidecar({
      schema_version: SIDECAR_SCHEMA_VERSION,
      session_id: sessionId,
      tool: "kimi_query",
      source: "companion",
      job_id: id,
      cwd,
      phase: sidecarPhase,
      started_at: startedAt,
      finished_at: completedAt,
      exit_code: result.exitCode ?? null,
      duration_ms: result.durationMs ?? null,
      killed_by: result.killReason ?? null,
      trailing_marker_missing: false,
      plugin_version: PLUGIN_VERSION,
    });
  }
}

function tail(text, bytes) {
  if (!text) return "";
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= bytes) return text;
  return `…${buf.subarray(buf.byteLength - bytes).toString("utf8")}`;
}

function cmdStatus(rawArgs) {
  const { options, positionals } = parseArgs(rawArgs, {
    booleans: ["all", "json"],
    values: ["cwd"],
  });
  const cwd = path.resolve(options.cwd ?? process.cwd());
  if (positionals.length > 0) {
    const job = resolveJob(cwd, positionals[0]);
    if (!job) {
      process.exitCode = 1;
      process.stdout.write(`No job ${positionals[0]} found.\n`);
      return;
    }
    process.stdout.write(options.json ? `${JSON.stringify(job, null, 2)}\n` : renderJobStatus(job));
    return;
  }
  const jobs = loadState(cwd).jobs;
  const shown = options.all ? jobs : jobs.slice(0, 10);
  process.stdout.write(options.json ? `${JSON.stringify(shown, null, 2)}\n` : renderStatusList(shown));
}

function cmdResult(rawArgs) {
  const { options, positionals } = parseArgs(rawArgs, {
    booleans: ["json"],
    values: ["cwd"],
  });
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const ref = positionals[0] ?? "latest";
  const job = resolveJob(cwd, ref);
  if (!job) {
    process.exitCode = 1;
    process.stdout.write(`No job ${ref} found.\n`);
    return;
  }
  const stored = readJobJson(cwd, job.id);
  process.stdout.write(
    options.json
      ? `${JSON.stringify({ job, result: stored?.result ?? null }, null, 2)}\n`
      : renderResult(job, stored),
  );
}

function cmdCancel(rawArgs) {
  const { options, positionals } = parseArgs(rawArgs, {
    booleans: ["json"],
    values: ["cwd"],
  });
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const ref = positionals[0];
  if (!ref) throw new Error("cancel requires a job id");
  const job = resolveJob(cwd, ref);
  if (!job) {
    process.exitCode = 1;
    process.stdout.write(`No job ${ref} found.\n`);
    return;
  }
  if (job.status !== "running" && job.status !== "queued") {
    process.stdout.write(
      options.json
        ? `${JSON.stringify({ jobId: job.id, status: job.status, cancelled: false }, null, 2)}\n`
        : `Job ${job.id} is already ${job.status}.\n`,
    );
    return;
  }
  let killed = false;
  if (job.pid) {
    try {
      process.kill(-job.pid, "SIGTERM");
      killed = true;
    } catch {
      try {
        process.kill(job.pid, "SIGTERM");
        killed = true;
      } catch {}
    }
  }
  appendLog(cwd, job.id, `Cancelled by user (kill=${killed}).`);
  const completedAt = nowIso();
  const stored = readJobJson(cwd, job.id) ?? {};
  const errorMessage = "Cancelled by user.";
  writeJobJson(cwd, job.id, {
    ...stored,
    status: "cancelled",
    pid: null,
    completedAt,
    errorMessage,
  });
  upsertJob(cwd, { id: job.id, status: "cancelled", pid: null, completedAt, errorMessage });
  const payload = { jobId: job.id, status: "cancelled", cancelled: killed };
  process.stdout.write(
    options.json
      ? `${JSON.stringify(payload, null, 2)}\n`
      : `Cancelled ${job.id}${killed ? "" : " (no live process to signal)"}.\n`,
  );
}

function cmdConfig(rawArgs) {
  const { options, positionals } = parseArgs(rawArgs, {
    booleans: ["json", "enable-review-gate", "disable-review-gate"],
    values: ["cwd"],
  });
  const cwd = path.resolve(options.cwd ?? process.cwd());

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Cannot combine --enable-review-gate and --disable-review-gate.");
  }
  if (options["enable-review-gate"]) {
    setConfig(cwd, { stopReviewGate: true });
  } else if (options["disable-review-gate"]) {
    setConfig(cwd, { stopReviewGate: false });
  } else if (positionals[0] === "show" || positionals.length === 0) {
    // fall through to print
  } else {
    throw new Error(`Unknown config args: ${positionals.join(" ")}`);
  }

  const cfg = getConfig(cwd);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(cfg, null, 2)}\n`);
    return;
  }
  process.stdout.write(`stopReviewGate: ${cfg.stopReviewGate ? "enabled" : "disabled"}\n`);
}

// --- entry ------------------------------------------------------------------

async function main() {
  const [, , subcommand, ...rest] = process.argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printUsage();
    return;
  }
  switch (subcommand) {
    case "task":
      await cmdTask(rest);
      return;
    case "task-worker":
      await cmdTaskWorker(rest);
      return;
    case "status":
      cmdStatus(rest);
      return;
    case "result":
      cmdResult(rest);
      return;
    case "cancel":
      cmdCancel(rest);
      return;
    case "config":
      cmdConfig(rest);
      return;
    default:
      printUsage();
      process.exitCode = 2;
      return;
  }
}

main().catch((err) => {
  process.stderr.write(`kimi-companion: ${err?.message ?? err}\n`);
  process.exitCode = 1;
});
