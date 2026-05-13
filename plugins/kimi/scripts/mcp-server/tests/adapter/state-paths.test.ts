import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveStateDir,
  resolveWorkspaceRoot,
  sessionsDir,
} from "../../src/adapter/state-paths.js";

let tmp: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "kimi-state-paths-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of ["CLAUDE_PLUGIN_DATA", "KIMI_STATE_DIR"]) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("resolveWorkspaceRoot", () => {
  it("walks up to the nearest .git directory", () => {
    const repo = mkdirSync(path.join(tmp, "repo"), { recursive: true })!;
    mkdirSync(path.join(repo, ".git"));
    mkdirSync(path.join(repo, "a", "b"), { recursive: true });
    expect(resolveWorkspaceRoot(path.join(repo, "a", "b"))).toBe(repo);
  });

  it("falls back to the input cwd when no .git is found", () => {
    const sub = path.join(tmp, "no-git");
    mkdirSync(sub, { recursive: true });
    expect(resolveWorkspaceRoot(sub)).toBe(sub);
  });
});

describe("resolveStateDir", () => {
  it("honors KIMI_STATE_DIR over everything else", () => {
    process.env.KIMI_STATE_DIR = path.join(tmp, "forced");
    process.env.CLAUDE_PLUGIN_DATA = path.join(tmp, "should-be-ignored");
    const dir = resolveStateDir(tmp);
    expect(dir.startsWith(path.join(tmp, "forced"))).toBe(true);
  });

  it("uses CLAUDE_PLUGIN_DATA/state when KIMI_STATE_DIR is unset", () => {
    delete process.env.KIMI_STATE_DIR;
    process.env.CLAUDE_PLUGIN_DATA = path.join(tmp, "cpd");
    const dir = resolveStateDir(tmp);
    expect(dir.startsWith(path.join(tmp, "cpd", "state"))).toBe(true);
  });

  it("falls back to os.tmpdir()/kimi-companion when neither env is set", () => {
    delete process.env.KIMI_STATE_DIR;
    delete process.env.CLAUDE_PLUGIN_DATA;
    const dir = resolveStateDir(tmp);
    expect(dir.startsWith(path.join(os.tmpdir(), "kimi-companion"))).toBe(true);
  });

  it("returns the same dir for the same workspace (slug+hash stable)", () => {
    process.env.KIMI_STATE_DIR = path.join(tmp, "root");
    mkdirSync(path.join(tmp, "repo", ".git"), { recursive: true });
    const a = resolveStateDir(path.join(tmp, "repo"));
    const b = resolveStateDir(path.join(tmp, "repo"));
    expect(a).toBe(b);
  });

  it("returns different dirs for different workspaces", () => {
    process.env.KIMI_STATE_DIR = path.join(tmp, "root");
    mkdirSync(path.join(tmp, "repo-a", ".git"), { recursive: true });
    mkdirSync(path.join(tmp, "repo-b", ".git"), { recursive: true });
    const a = resolveStateDir(path.join(tmp, "repo-a"));
    const b = resolveStateDir(path.join(tmp, "repo-b"));
    expect(a).not.toBe(b);
  });

  it("matches the kimi-companion.mjs layout exactly (slug-sha256[:16])", () => {
    process.env.KIMI_STATE_DIR = path.join(tmp, "root");
    const repo = path.join(tmp, "my repo!");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    const dir = resolveStateDir(repo);
    // slug = sanitized basename: "my repo!" -> "my-repo"
    const base = path.basename(dir);
    expect(base.startsWith("my-repo-")).toBe(true);
    // suffix is 16 hex chars of sha256
    expect(base).toMatch(/^my-repo-[0-9a-f]{16}$/);
  });
});

describe("sessionsDir", () => {
  it("is <stateDir>/sessions", () => {
    process.env.KIMI_STATE_DIR = path.join(tmp, "root");
    const dir = sessionsDir(tmp);
    expect(dir).toBe(path.join(resolveStateDir(tmp), "sessions"));
  });
});
