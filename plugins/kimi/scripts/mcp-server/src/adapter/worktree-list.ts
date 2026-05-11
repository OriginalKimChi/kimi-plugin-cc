export interface WorktreeEntry {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

interface MutableEntry {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  if (stdout.length === 0) return [];
  const lines = stdout.split(/\r?\n/);
  const out: WorktreeEntry[] = [];
  let current: MutableEntry | null = null;

  const flush = () => {
    if (current !== null) {
      out.push(current);
      current = null;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      current = {
        path: line.slice("worktree ".length),
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      };
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    } else if (line === "detached") {
      current.detached = true;
    } else if (line === "bare") {
      current.bare = true;
    } else if (line.startsWith("locked")) {
      current.locked = true;
    } else if (line.startsWith("prunable")) {
      current.prunable = true;
    }
  }
  flush();
  return out;
}
