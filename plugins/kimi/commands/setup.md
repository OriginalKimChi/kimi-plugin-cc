---
description: Check whether the local Kimi CLI is installed and authenticated
argument-hint: ''
allowed-tools: Bash(command:*), Bash(kimi:*), Bash(test:*), Bash(stat:*), AskUserQuestion
---

Run the following probe and report the result to the user.

```bash
if command -v kimi >/dev/null 2>&1; then
  KIMI_BIN="$(command -v kimi)"
  KIMI_VERSION="$(kimi --version 2>/dev/null || echo unknown)"
  if [ -s "$HOME/.kimi/credentials/kimi-code.json" ]; then
    echo "status=ready"
    echo "bin=$KIMI_BIN"
    echo "version=$KIMI_VERSION"
  else
    echo "status=unauthenticated"
    echo "bin=$KIMI_BIN"
    echo "version=$KIMI_VERSION"
  fi
else
  echo "status=missing"
fi
```

Interpret the output and act:

- `status=ready` — Kimi is installed and authenticated. Report the version and bin path. Do nothing else.

- `status=unauthenticated` — Kimi is installed but the user is not logged in. Do **not** ask. Tell the user to run:

  ```
  !kimi login
  ```

  Explain that the `!` prefix runs the command directly in this Claude Code session so the OAuth flow output lands here. Mention that `kimi logout` is available to sign out.

- `status=missing` — Kimi CLI is not on `PATH`. Use `AskUserQuestion` exactly once with these two options (install option first):
  - `Install kimi-cli via uv (Recommended)`
  - `Skip for now`

  If the user picks install, run:

  ```bash
  uv tool install kimi-cli
  ```

  Then rerun the probe block above and report the new status (continue down the same branches). If `uv` itself is missing, report that and point the user to `https://docs.astral.sh/uv/` for installation; do not try a fallback installer.

  If the user skips, just report that Kimi is unavailable and stop.

Output rules:

- Keep the final user-facing message terse: status + the single next step. No extra commentary.
- Never run `kimi login` for the user. Always surface `!kimi login` so the user types it.
- If the user is already authenticated, do not suggest re-running login.
