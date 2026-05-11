---
date: 2026-05-11
summary: "Add Context layer map — slow→fast cache-stability ranking + known imperfections"
---

# Add Context layer map — slow→fast cache-stability ranking + known imperfections

New section in design.md `## Context layer map（slow→fast cache-stability ranking）`. Single-page reference covering every wire slot (L0 driver → L10 prompt_cache_key) and where each OpenCode asset (driver, RoleIdentity, SYSTEM.md, agent overlay, AGENTS.md global/project, EnvironmentContext, conversation history, tools, client_metadata) lands.

Highlights:

- **Slow-first ordering IS respected within each bundle** (developer: RoleIdentity → SYSTEM → AgentInstructions; user: AGENTS.md-global → AGENTS.md-project → EnvironmentContext). Daily-churn EnvironmentContext sits last in user bundle so currentDate flip truncates minimum tail bytes.
- **Known imperfection L3**: `user.system` (per-turn lazy catalog / quota-low / structured-output extras) currently sits inside the developer bundle as fragment #3. If `user.system` changes between turns, the developer bundle hash breaks even though L1+L2 are byte-stable. Future option: pull it out into its own bundle position or move into a trailing user-role message after history.
- **Skills (SKILL.md catalog) are NOT in the bundle** on the upstream-wire codex path — they ride through the `skill` tool description. This is upstream-faithful and correct.
- **MCP schemas** ride the `tools` field, parallel to `input[]`. Separate cache dimension.
- **L6 EnvironmentContext could split currentDate** into a trailing micro-fragment to shrink daily-flip blast radius. Low priority.

Added a quick checklist for new context additions to guard against re-introducing slow-first violations.
