# P0-C — `kimi_implement` worktree enforcement (server-side)

## Problem

`kimi_implement` autonomously edits files. Running it against the user's working tree is unsafe — uncommitted work can be clobbered, partial edits become indistinguishable from the user's own, and reverting is painful. The legacy `kimi-rescue` agent enforces "always run in a fresh worktree" by **prompt convention**. Prompt conventions don't survive bad luck: a malformed agent call, a different client, or a future refactor bypasses them silently.

The MCP server itself must refuse to edit anywhere other than a disposable worktree. This is a **server-side invariant**, not a prompt-side hint.

## Threats this guards against

| # | Threat | Today (prompt convention) | After server enforcement |
|---|---|---|---|
| 1 | Caller forgets to create a worktree | Edits land in `cwd` | Hard-fail before any edit |
| 2 | Caller passes a bogus path that *looks* like a worktree | Edits land there | Verified via `git rev-parse --git-dir` + `--show-toplevel` cross-check |
| 3 | Worktree path is actually the main repo's primary working tree | Treated as worktree, edits land in primary | Reject if `worktree_path == main_worktree_path` |
| 4 | Worktree exists but is dirty / has untracked files we'd overwrite | Silent overwrite | Reject unless `allow_dirty: true` is explicitly set |
| 5 | Caller cleans up worktree mid-run (race) | Edits land in deleted dir | Re-check `realpath` before write; abort on mismatch |

## Contract

The `kimi_implement` MCP tool accepts (zod schema):

```ts
const InputSchema = z.object({
  task: z.string().min(1),
  worktree_path: z.string().min(1)
    .describe("Absolute path to a git worktree dedicated to this call. Must NOT be the primary working tree of the repository. The server creates this if `create_worktree` is set; otherwise it must already exist."),
  base_repo: z.string().min(1)
    .describe("Absolute path to the source repository. Used as the origin for created worktrees."),
  base_ref: z.string().default("HEAD")
    .describe("Branch or commit the worktree should start from."),
  create_worktree: z.boolean().default(true)
    .describe("If true, the server creates the worktree at `worktree_path` via `git worktree add` and removes it on success. If false, the path must already be a valid existing worktree."),
  allow_dirty: z.boolean().default(false),
  files_glob: z.array(z.string()).optional()
    .describe("If set, the server restricts the kimi CLI to only see/edit files matching these globs within the worktree."),
});
```

## Enforcement steps (executed in order, fail-closed)

```
1.  Validate `base_repo` and `worktree_path` are absolute. Reject relative paths.
2.  Compute realpath(base_repo) and realpath(worktree_path). Reject if either resolves outside the user's HOME (or an explicit allowlist root).
3.  Reject if realpath(worktree_path) is a subpath of realpath(base_repo). A worktree must live outside the source repo to avoid accidental cwd pollution.
4.  Confirm base_repo is a git repository: `git -C base_repo rev-parse --git-dir` must succeed.
5.  Resolve the main worktree of base_repo: `git -C base_repo worktree list --porcelain` → first entry's path. Reject if realpath(worktree_path) == realpath(main_worktree_path).
6.  Branch on create_worktree:
    6a. create_worktree=true:
        - Reject if worktree_path already exists (no overwrite).
        - Generate a unique branch name: `kimi-impl-<sha7-of-base_ref>-<unix_ts>`.
        - Run `git -C base_repo worktree add -b <branch> <worktree_path> <base_ref>`.
        - Register cleanup hook to remove the worktree on completion or failure (`git worktree remove --force`).
    6b. create_worktree=false:
        - Confirm worktree_path is a registered worktree of base_repo:
          parse `git -C base_repo worktree list --porcelain` and require an exact match.
        - If allow_dirty=false, reject when `git -C worktree_path status --porcelain` is non-empty.
7.  Re-stat realpath(worktree_path) immediately before spawning the kimi CLI. Abort if it changed from step 5 (TOCTOU defense).
8.  Spawn the kimi CLI with cwd=worktree_path and an env allowlist (see P0-D). Never set cwd=base_repo.
9.  On success: capture the diff (`git -C worktree_path diff base_ref...`) and return it in the tool response. The caller decides whether to merge it back.
10. On failure or process kill: best-effort cleanup. Log the worktree path so the user can recover.
```

## What the server returns

```ts
type ImplementResult = {
  worktree_path: string;
  branch: string | null;            // null if create_worktree=false
  commit_sha: string | null;        // if kimi committed inside the worktree
  diff: string;                     // git diff base_ref...HEAD
  files_changed: string[];
  cleanup_status: "removed" | "left_in_place" | "cleanup_failed";
  kimi_stdout_excerpt: string;      // truncated per P0-D output caps
};
```

The diff is the **only** way the change reaches the user's main repo — the server never merges automatically.

## What we explicitly do NOT do

- **No `--force` overwrites of an existing worktree path.** If `create_worktree=true` and the path exists, fail.
- **No chdir on the main process.** Only the spawned subprocess sees the worktree as cwd.
- **No suid / mount / chroot sandboxing.** Out of scope for v1 — the goal is "wrong target dir" defense, not malicious-kimi defense.

## Open questions (resolve before implementation)

1. Should `create_worktree=true` be the default, or required-explicit? Recommendation: default true (safer ergonomics, since forgetting it = unsafe legacy behavior).
2. Should the server commit inside the worktree before returning? Or leave the changes uncommitted and let the diff carry them? Recommendation: commit, so `git diff base_ref...HEAD` is stable.
3. How do we handle the kimi CLI deciding to `git push` from inside the worktree? Recommendation: env allowlist (P0-D) strips remote credentials so push fails cleanly.

## Test cases (must be written before implementation)

- worktree_path inside base_repo → reject
- worktree_path == main worktree → reject
- create_worktree=true with existing path → reject
- create_worktree=false with unregistered path → reject
- create_worktree=false with dirty worktree, allow_dirty=false → reject
- TOCTOU: worktree path swapped to symlink between step 5 and step 8 → abort
- Happy path with create_worktree=true → worktree created, kimi runs with correct cwd, diff returned, worktree removed
- kimi CLI crashes mid-run → worktree still cleaned up
