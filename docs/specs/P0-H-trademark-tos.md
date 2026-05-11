# P0-H — Trademark / Moonshot TOS quick-check

> **Disclaimer**: I am not a lawyer. This is a risk-triage memo, not legal advice. Before publishing the plugin or relying on this analysis for anything beyond personal use, consult counsel.

## Risk inventory

| # | Risk | Severity (today) | Mitigation in this plugin |
|---|---|---|---|
| 1 | "Kimi" / "Moonshot" are registered trademarks | Medium | Repo name uses the term as a *descriptive* identifier ("plugin for Kimi", not "Kimi-branded plugin"). README opens with an unofficial-affiliation disclaimer. |
| 2 | Reader could believe the plugin is endorsed by Moonshot AI | Medium | Explicit "Not affiliated with Moonshot AI" line at the top of README, on the marketplace description, and inside `kimi_status` response metadata. |
| 3 | Logo / icon usage | Low (none used) | Plugin ships no Moonshot/Kimi logos or wordmarks beyond the bare word "Kimi" in text. |
| 4 | Moonshot's CLI TOS prohibits wrappers | Low (no evidence of such clause as of 2026-05) | If discovered, the wrapper can fall back to a different name (e.g., "moonshot-cli-bridge") without losing functionality. |
| 5 | Data routed to Moonshot via the CLI counts as user data subject to their privacy policy | Medium | Plugin does not store or forward user prompts beyond what the CLI itself does. README points the user at Moonshot's privacy policy. |
| 6 | Re-distribution of Moonshot's CLI help text (we captured `--help` output as fixtures) | Low | Captured excerpts are interoperability documentation. Mark fixtures as third-party content under fair-use principles in the README. |

## Concrete mitigations baked into the plugin

### README header (mandatory text)

```markdown
> **Unofficial.** This is a community-built Claude Code plugin that talks to the
> `kimi` CLI by Moonshot AI. It is not affiliated with, endorsed by, or
> sponsored by Moonshot AI. "Kimi" and "Moonshot" are trademarks of their
> respective owners and are used here only to identify the upstream product
> this plugin integrates with.
```

### Marketplace metadata (`marketplace.json`)

The `description` field already includes "Unofficial Claude Code plugin that exposes Kimi (Moonshot) coding model as MCP tools. Not affiliated with Moonshot AI." Keep this exactly.

### `kimi_status` response

Include in every status payload:

```json
{
  "plugin": "kimi",
  "vendor_affiliation": "none",
  "upstream_brand": { "name": "Kimi", "owner": "Moonshot AI", "official": false }
}
```

So even programmatic consumers can tell this is a third-party plugin.

### Repo name

`kimi-plugin-cc` is descriptive (plugin **for** Kimi, **for** Claude Code). If Moonshot ever objects, the rename path is `moonshot-cli-bridge` or `kimi-mcp-bridge`. Captured here as a fallback, not adopted.

## Action items before public release

| When | Item |
|---|---|
| Before first GitHub Star or social-share | Re-read this file; confirm README disclaimer is present and unchanged. |
| Before submitting to a public marketplace (if ever) | Find and link Moonshot AI's official brand-use page (if it exists). Update this doc with the link. Confirm no clause forbids wrappers. |
| If Moonshot AI contacts directly | Engage in good faith. Renaming / restructuring is cheap; preserving relationship is more valuable than the name. |

## What we explicitly do NOT do

- Use Moonshot's logo or stylised wordmark.
- Claim "official" / "endorsed" / "certified" status anywhere.
- Charge money for the plugin while branding it as "Kimi".
- Reproduce more than minimal `--help` excerpts in our documentation; the captured fixtures stay in `docs/fixtures/cli-probe/` with a fair-use notice and are not redistributed elsewhere.

## Status

P0-H closes with: **acceptable for personal/portfolio use as currently designed**, with the unofficial disclaimer present in README + marketplace + status response. Re-triage before any wider distribution.
