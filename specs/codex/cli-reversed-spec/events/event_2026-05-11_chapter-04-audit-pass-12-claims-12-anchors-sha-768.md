---
date: 2026-05-11
summary: "Chapter 04 audit pass — 12 claims / 12 anchors / SHA 76845d716b / 0 open questions / D4-1 + D4-2 datasheets"
---

# Chapter 04 audit pass — 12 claims / 12 anchors / SHA 76845d716b / 0 open questions / D4-1 + D4-2 datasheets

## Audit result: PASS

- **Submodule SHA pinned**: `76845d716b720ca701b2c91fec75431532e66c74` (unchanged).
- **Claims**: 12 (C1–C12).
- **Anchors**: 12.
- **TEST/TYPE diversity**: 1 trait TYPE (C6 ContextualUserFragment) + 1 TEST (C12 serialize_workspace_write_environment_context); plus 5 trait-impl anchors (C7-C11) verifying concrete fragment wiring against the C6 contract.
- **Open questions**: 0.

## Datasheets delivered

- **D4-1** — `Vec<ResponseItem>` returned by build_initial_context. 4 indexed positions (developer / multi-agent hint / contextual user / guardian-only); each ResponseItem::Message shape (role + content of ContentItem::InputText[]) documented; sanitized example payload.
- **D4-2** — Fragment marker registry (recognition contract). 5 concrete fragments enumerated with ROLE / START_MARKER / END_MARKER / file:line. Unmarked fragments noted (matches_text returns false when markers empty).

## Cross-diagram traceability (per miatdiagram §4.7)

Walked links:
- session/mod.rs::build_initial_context → A4.1-A4.6 → D4-1 datasheet ✓
- context/fragment.rs::ContextualUserFragment trait → A4.1/A4.2 push payloads ✓
- 5 fragment impl files → D4-2 marker rows + IDEF0 Mechanism cells ✓
- environment_context_tests.rs C12 → D4-1 example payload byte shape ✓

## Audit table

| Cn | Anchor | Kind | Verified |
|---|---|---|---|
| C1 | session/mod.rs:2567 | fn | ✓ build_initial_context returns Vec<ResponseItem> |
| C2 | session/mod.rs:2572 | local | ✓ capacities 8/2 |
| C3 | session/mod.rs:2589 | sequence | ✓ 11 conditional pushes in source order |
| C4 | session/mod.rs:2719 | two-if | ✓ UserInstructions then EnvironmentContext |
| C5 | context_manager/updates.rs:178 | fn | ✓ ResponseItem::Message { role, content: Vec<InputText>, phase: None } |
| C6 | context/fragment.rs:39 | trait | ✓ ROLE/START_MARKER/END_MARKER/body contract |
| C7 | context/environment_context.rs:272 | impl | ✓ user + <environment_context> markers |
| C8 | context/user_instructions.rs:10 | impl | ✓ user + "# AGENTS.md instructions for " markers |
| C9 | context/apps_instructions.rs:21 | impl | ✓ developer + APPS_INSTRUCTIONS_*_TAG |
| C10 | context/available_skills_instructions.rs:24 | impl | ✓ developer + SKILLS_INSTRUCTIONS_*_TAG |
| C11 | context/permissions_instructions.rs:170 | impl | ✓ developer + <permissions instructions> markers |
| C12 | context/environment_context_tests.rs:22 | TEST | ✓ byte-exact assertion of render() output |

## OpenCode delta — actionable for downstream specs

1. **Bundle-slow-first refinement** (currently shelved at `plans/provider_codex-bundle-slow-first-refinement/`): resume gate satisfied. L3 split (user.system out of agent_instructions) is justifiable; L6 currentDate split is rejected (would break upstream byte-alignment per C7/C12 EnvironmentContext fragment).
2. **OpenCode-only `RoleIdentity` fragment** has no upstream analogue — upstream uses SessionSource at Chapter 02 C12. OpenCode keeps its current behaviour.
3. **OpenCode does not emit** PermissionsInstructions, AppsInstructions, AvailableSkillsInstructions developer bundle fragments. Three independent gaps; each has its own OpenCode-equivalent (own UI flow / tools field / `skill` tool) so this is by-design, not regression target.
4. **`agent.prompt + user.system` mixing in OpenCode `opencode_agent_instructions`** is the slow-first violation; per upstream (no equivalent fragment) and per chapter-04 cross-link, the correct OpenCode fix is to split user.system to TAIL of user bundle (post-environment_context). This re-confirms the bundle-slow-first refinement spec's MVP path.

## Cumulative spec progress (4/12 chapters audited)

- 48 claims / 48 anchors total
- 4 TEST anchors + 17 TYPE anchors
- 4 datasheets delivered (D2-1, D2-2, D4-1, D4-2)
- 0 open questions across all 4 chapters
- All on submodule SHA 76845d716b

## Next

Chapter 05 — Tools & MCP. Lighter content density (tools field is structurally simple — JSON-schema array) but covers MCP client integration which is OpenCode-relevant.
