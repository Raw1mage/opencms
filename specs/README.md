# opencode specs/ — product wiki

This directory used to hold plan-builder spec packages (`<slug>/proposal.md`,
`design.md`, `tasks.md`, `.state.json`, …). It has been converted into a
**descriptive product wiki** — the source of truth for each entry is the
**current code**, not a forward-looking plan. The 41 original spec
packages were merged into 11 wiki entries by topic, with the originals
preserved under `_archive/` for history.

## Wiki entries

| Entry | What it covers |
|---|---|
| [compaction](./compaction/README.md) | Context reduction, KV-cache hardening, anchor / journal / pinned-zone, idle gate, hybrid LLM compaction, codex server-side compaction. |
| [session](./session/README.md) | Session storage (SQLite), capability layer / rebind, HTTP poll cache, frontend lazyload, mobile tail-first, dialog stream. |
| [provider](./provider/README.md) | Provider abstraction (anthropic, codex, openai, gemini-cli, google-api), fingerprint alignment, account-decoupling boundary, lmv2 envelope. |
| [account](./account/README.md) | Account model, accounts.json, multi-account auth, OAuth flows, family-normalization, multi-user gateway model. |
| [attachments](./attachments/README.md) | Image / docx / repo-tracked attachment lifecycle, AI opt-in re-read, docxmcp HTTP-over-unix-socket transport. |
| [mcp](./mcp/README.md) | MCP framework, McpAppManifest + ManagedAppRegistry split, idle unload (proposed), Direct Render TODO. |
| [agent-runtime](./agent-runtime/README.md) | Agent loop & autonomy, subagent dispatch & quota, mandatory skills preload, question tool, scheduler / heartbeat. |
| [daemon](./daemon/README.md) | C gateway + per-user bun daemon, `webctl.sh`, `restart_self`, daemon.lock, DAEMON_SPAWN_DENYLIST. |
| [webapp](./webapp/README.md) | SolidJS SPA, Admin Panel `/admin`, route registration, voice input, rich rendering. |
| [app-market](./app-market/README.md) | Three-kind unified install surface (mcp-server / managed-app / mcp-app), Admin Panel installer. |
| [meta](./meta/README.md) | plan-builder skill, architecture documentation flow, config management (XDG, /etc/opencode/, tweaks.cfg). |

## Index / cross-cutting

- [architecture.md](./architecture.md) — cross-cutting architecture document.
  Per-feature detail lives in the wiki entries above; this remains the
  high-level index and decision-log narrative.

## Archive

- [_archive/](./_archive/) — the original 41 plan-builder spec packages,
  preserved verbatim. Historical references in `architecture.md`,
  `docs/events/**`, and inside the archive cross-link via
  `specs/_archive/<slug>/...`.

## Conventions for new entries

- Source of truth = the code, not the plan.
- Structure: `# topic` → blockquote naming source folders / scope →
  `## Status` → `## Current behavior` → `## Code anchors` → `## Notes`.
- No `proposal.md / design.md / tasks.md / .state.json` artefacts. If a
  new plan is in flight, run plan-builder under a separate folder
  (e.g. `_active/<slug>/`) and fold the result back into the relevant
  wiki entry on `living`.
- Cross-link freely between entries; treat the wiki as a graph.
