import { describe, expect, it } from "vitest";
import {
  parseWorktreeList,
  type WorktreeEntry,
} from "../../src/adapter/worktree-list.js";

describe("parseWorktreeList", () => {
  it("parses a single main worktree with a branch", () => {
    const stdout = [
      "worktree /Users/x/repo",
      "HEAD abcdef0123456789abcdef0123456789abcdef01",
      "branch refs/heads/main",
      "",
    ].join("\n");

    const out = parseWorktreeList(stdout);

    expect(out).toHaveLength(1);
    expect(out[0]).toEqual<WorktreeEntry>({
      path: "/Users/x/repo",
      head: "abcdef0123456789abcdef0123456789abcdef01",
      branch: "refs/heads/main",
      detached: false,
      bare: false,
      locked: false,
      prunable: false,
    });
  });

  it("parses a main + linked + detached worktree set; first entry is main", () => {
    const stdout = [
      "worktree /Users/x/repo",
      "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "branch refs/heads/main",
      "",
      "worktree /Users/x/repo-feature",
      "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "branch refs/heads/feature/abc",
      "",
      "worktree /Users/x/repo-detached",
      "HEAD cccccccccccccccccccccccccccccccccccccccc",
      "detached",
      "",
    ].join("\n");

    const out = parseWorktreeList(stdout);

    expect(out).toHaveLength(3);
    expect(out[0]!.path).toBe("/Users/x/repo");
    expect(out[1]!.branch).toBe("refs/heads/feature/abc");
    expect(out[2]!.detached).toBe(true);
    expect(out[2]!.branch).toBeUndefined();
  });

  it("parses bare / locked / prunable flags", () => {
    const stdout = [
      "worktree /Users/x/bare-repo",
      "bare",
      "",
      "worktree /Users/x/locked",
      "HEAD dddddddddddddddddddddddddddddddddddddddd",
      "branch refs/heads/locked",
      "locked",
      "",
      "worktree /Users/x/prunable",
      "HEAD eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      "branch refs/heads/old",
      "prunable",
      "",
    ].join("\n");

    const out = parseWorktreeList(stdout);

    expect(out).toHaveLength(3);
    expect(out[0]!.bare).toBe(true);
    expect(out[1]!.locked).toBe(true);
    expect(out[2]!.prunable).toBe(true);
  });

  it("tolerates a missing trailing blank line", () => {
    const stdout = [
      "worktree /a",
      "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "branch refs/heads/main",
    ].join("\n");

    expect(parseWorktreeList(stdout)).toHaveLength(1);
  });

  it("returns [] for empty input", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });

  it("ignores leading blank lines between entries", () => {
    const stdout = [
      "",
      "",
      "worktree /a",
      "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "branch refs/heads/main",
      "",
      "",
      "worktree /b",
      "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "detached",
      "",
    ].join("\n");

    const out = parseWorktreeList(stdout);
    expect(out.map((e) => e.path)).toEqual(["/a", "/b"]);
  });
});
