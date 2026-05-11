# Chapter 04: Context Fragment Assembly

> Status: **audited (2026-05-11)** | refs/codex SHA `76845d716b` | 12 claims / 12 anchors / 0 open questions

## Scope

The **most consequential chapter** for cache-related work. Covers how upstream codex-cli composes the `Vec<ResponseItem>` that gets prepended to `input[]` on every Responses API request — i.e. the developer-role + user-role messages carrying SYSTEM-like instructions, AGENTS.md, environment context, available skills, MCP-app instructions, permissions, and other per-session/per-turn directives.

Three things matter here for downstream OpenCode alignment:

1. **What fragments exist** and what wire-shape they take (markers + role + body).
2. **In what order** they get pushed into the bundle (this is the cache-critical question).
3. **Which fragments are conditional** (driven by Config flags, TurnContext fields, or feature gates).

What's **here**: `build_initial_context()` body order, `ContextualUserFragment` trait, all upstream fragment types (EnvironmentContext, UserInstructions/AGENTS.md, AppsInstructions, AvailableSkillsInstructions, PermissionsInstructions, PersonalitySpec, AvailablePlugins, CollaborationModeInstructions, ModelSwitch, RealtimeStart, MemoryTool, CommitMessage trailer, GuardianFollowup, etc.), and how they end up as `ResponseItem::Message` items via `build_developer_update_item` / `build_contextual_user_message`.

**Deferred**:
- Driver text (base_instructions) routing to top-level `instructions` field — Chapter 06 (request build).
- Tools field assembly — Chapter 05.
- Wire-level transport — Chapter 07 (HTTP) / 08 (WS).
- Subagent fragment variants — Chapter 10.
- Settings-diff replay during steady-state — Chapter 11 (cache).

## Module architecture

```mermaid
graph TB
  subgraph CoreSession["codex-rs/core/src/session/mod.rs"]
    bic["Session::build_initial_context()<br/>(~200 lines, async)"]
  end

  subgraph CoreContextManager["codex-rs/core/src/context_manager/updates.rs"]
    bdui["build_developer_update_item()<br/>(role=\"developer\")"]
    bcum["build_contextual_user_message()<br/>(role=\"user\")"]
    btm["build_text_message() (private)<br/>→ ResponseItem::Message"]
  end

  subgraph CoreContextFragments["codex-rs/core/src/context/"]
    frag_trait["fragment.rs<br/>::ContextualUserFragment trait"]
    env_ctx["environment_context.rs<br/>::EnvironmentContext (user)"]
    user_inst["user_instructions.rs<br/>::UserInstructions (user, AGENTS.md)"]
    apps["apps_instructions.rs<br/>::AppsInstructions (developer, MCP)"]
    skills["available_skills_instructions.rs<br/>::AvailableSkillsInstructions (developer)"]
    perms["permissions_instructions.rs<br/>::PermissionsInstructions (developer)"]
    coll_mode["collaboration_mode_instructions.rs"]
    pers_spec["personality_spec_instructions.rs"]
    plugins["plugin_instructions.rs::AvailablePluginsInstructions"]
    realtime_start["realtime_start_instructions.rs"]
    model_switch["model_switch_instructions.rs"]
  end

  subgraph Protocol["codex-rs/protocol/"]
    resp_item["models::ResponseItem<br/>(Message variant)"]
    content_item["models::ContentItem<br/>(InputText variant)"]
  end

  bic --> bdui
  bic --> bcum
  bdui --> btm
  bcum --> btm
  btm --> resp_item
  resp_item --> content_item

  bic -.pushes section text from.-> env_ctx
  bic -.pushes section text from.-> user_inst
  bic -.pushes section text from.-> apps
  bic -.pushes section text from.-> skills
  bic -.pushes section text from.-> perms
  bic -.pushes section text from.-> coll_mode
  bic -.pushes section text from.-> pers_spec
  bic -.pushes section text from.-> plugins
  bic -.pushes section text from.-> realtime_start
  bic -.pushes section text from.-> model_switch

  env_ctx -.impl.-> frag_trait
  user_inst -.impl.-> frag_trait
  apps -.impl.-> frag_trait
  skills -.impl.-> frag_trait
  perms -.impl.-> frag_trait
```

Stack view (per-turn assembly):

```
┌────────────────────────────────────────────────────────────────┐
│ TurnContext + Session state                                    │
│   developer_instructions, user_instructions, config flags,     │
│   features, permission_profile, environments, ...              │
├────────────────────────────────────────────────────────────────┤
│ build_initial_context()                                        │
│  developer_sections: Vec<String> (capacity 8)                  │
│   ├─ model_switch (when previous_turn_settings.model differs)  │
│   ├─ PermissionsInstructions (if include_permissions_instr)    │
│   ├─ turn_context.developer_instructions  (unless guardian)    │
│   ├─ memory_tool prompt  (if MemoryTool feature + use_memories)│
│   ├─ CollaborationModeInstructions  (if non-empty)             │
│   ├─ realtime_update  (if reference item present)              │
│   ├─ PersonalitySpec  (if not baked into base_instructions)    │
│   ├─ AppsInstructions  (if include_apps_instructions enabled)  │
│   ├─ AvailableSkillsInstructions (if include_skill_instr)      │
│   ├─ AvailablePluginsInstructions  (if any plugins loaded)     │
│   └─ commit_message_trailer  (if CodexGitCommit feature)       │
│  contextual_user_sections: Vec<String> (capacity 2)            │
│   ├─ UserInstructions (AGENTS.md, when present)                │
│   └─ EnvironmentContext (if include_environment_context)       │
├────────────────────────────────────────────────────────────────┤
│ build_developer_update_item(developer_sections)                │
│ build_contextual_user_message(contextual_user_sections)        │
├────────────────────────────────────────────────────────────────┤
│ items: Vec<ResponseItem> (capacity 4)                          │
│   [0]? developer Message  (concatenated developer_sections)    │
│   [1]? multi-agent-v2 usage hint developer Message  (optional) │
│   [2]? user Message  (concatenated contextual_user_sections)   │
│   [3]? guardian-only separate developer Message  (optional)    │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
        Vec<ResponseItem> returned to caller (Session.run_turn)
                              │
                              ▼ (Chapter 06)
                input[] head of Responses API request
```

## IDEF0 decomposition

See [`idef0.04.json`](idef0.04.json). Activities:

- **A4.1** Aggregate developer_sections — push 8–11 conditional strings into a Vec; the **order** is fixed by source-line order in `build_initial_context`.
- **A4.2** Aggregate contextual_user_sections — push UserInstructions (AGENTS.md), then EnvironmentContext. Always in that order; both conditional.
- **A4.3** Compose developer ResponseItem — collapse Vec<String> into a single `ResponseItem::Message { role: "developer", content: Vec<ContentItem::InputText> }`. One ContentItem per section.
- **A4.4** Compose contextual user ResponseItem — same shape, role="user".
- **A4.5** Optional multi-agent v2 usage hint — separate developer message between [0] and [2] when feature applies.
- **A4.6** Optional guardian separate developer message — emitted at index [3] when session source is a guardian reviewer; otherwise the guardian's policy prompt collapses into [0]. Mutual exclusion governed by `separate_guardian_developer_message` flag.

## GRAFCET workflow

See [`grafcet.04.json`](grafcet.04.json). 12-step assembly with conditional branches per fragment toggle. Steps map A4.M activity ids.

## Controls & Mechanisms

A4.1 has 11 conditional mechanisms (one per fragment). Captured as ICOM Mechanism cells in `idef0.04.json` rather than a separate diagram — the relationships are flat conditionals not interlocked control flow.

## Protocol datasheet

### D4-1: `Vec<ResponseItem>` returned by `build_initial_context` (input[] prepend)

**Transport**: This is **not** a wire-level message itself — it is the in-memory `Vec<ResponseItem>` that gets prepended to `input[]` in the Responses API request body (see Chapter 06 datasheet D6-2 for the full body).
**Triggered by**: A4.3 + A4.4 + A4.5 + A4.6 — first user turn of a session, OR on context-baseline re-establishment after compaction (`record_context_updates_and_set_reference_context_item`).
**Source**: [`refs/codex/codex-rs/core/src/session/mod.rs:2567`](refs/codex/codex-rs/core/src/session/mod.rs#L2567) (`Session::build_initial_context`).

| Position | Item | Role | Required | Source (file:line) | Stability | Notes |
|---|---|---|---|---|---|---|
| `[0]` | developer Message (aggregated) | `"developer"` | conditional (Some when `developer_sections` non-empty) | [`mod.rs:2742-2747`](refs/codex/codex-rs/core/src/session/mod.rs#L2742-L2747) | stable-per-session (mostly) | One `ResponseItem::Message`; content = N `ContentItem::InputText`, one per section. Section order is fixed by build_initial_context source order. |
| `[1]` | multi-agent v2 usage hint developer Message | `"developer"` | conditional (when multi_agent_v2 enabled + usage_hint_text present) | [`mod.rs:2749-2756`](refs/codex/codex-rs/core/src/session/mod.rs#L2749-L2756) | stable-per-session | Single section per message. |
| `[2]` | user Message (contextual sections aggregated) | `"user"` | conditional (Some when `contextual_user_sections` non-empty) | [`mod.rs:2758-2762`](refs/codex/codex-rs/core/src/session/mod.rs#L2758-L2762) | stable-per-session except EnvironmentContext.currentDate | UserInstructions (AGENTS.md) + EnvironmentContext concatenated as separate ContentItems. |
| `[3]` | guardian-only separate developer Message | `"developer"` | conditional (only when `separate_guardian_developer_message`) | [`mod.rs:2764-2774`](refs/codex/codex-rs/core/src/session/mod.rs#L2764-L2774) | stable-per-session | Used by guardian reviewer subagent path. Mutually exclusive with the developer_instructions branch inside [0] (lines 2620-2625). |

**ResponseItem::Message shape** (per item):

```rust
ResponseItem::Message {
    id: None,                    // Always None for build_initial_context-produced items
    role: "developer" | "user",  // String, not enum, on the wire
    content: Vec<ContentItem>,   // Each item below
    phase: None,                 // Always None
}
```

**ContentItem::InputText shape** (one per section pushed):

```rust
ContentItem::InputText { text: String }
```

**Example payload** (sanitized — `[0]` developer Message with three sections):

```json
{
  "type": "message",
  "role": "developer",
  "content": [
    { "type": "input_text", "text": "<permissions instructions>...</permissions instructions>" },
    { "type": "input_text", "text": "<apps_instructions>...</apps_instructions>" },
    { "type": "input_text", "text": "<skills_instructions>...</skills_instructions>" }
  ]
}
```

### D4-2: Fragment marker registry (recognition contract)

These constants govern how upstream-injected fragments can be **recognised** in arbitrary text (used by filtering and post-anchor-transform layers). Cache-hash is byte-exact; this table is a recognition aid, not a cache-key spec.

| Fragment | Role | START_MARKER | END_MARKER | Source (file:line) |
|---|---|---|---|---|
| EnvironmentContext | `user` | `<environment_context>` | `</environment_context>` | [`environment_context.rs:272-274`](refs/codex/codex-rs/core/src/context/environment_context.rs#L272-L274) |
| UserInstructions (AGENTS.md) | `user` | `# AGENTS.md instructions for ` | `</INSTRUCTIONS>` | [`user_instructions.rs:10-12`](refs/codex/codex-rs/core/src/context/user_instructions.rs#L10-L12) |
| PermissionsInstructions | `developer` | `<permissions instructions>` | `</permissions instructions>` | [`permissions_instructions.rs:170-172`](refs/codex/codex-rs/core/src/context/permissions_instructions.rs#L170-L172) |
| AppsInstructions (MCP) | `developer` | `APPS_INSTRUCTIONS_OPEN_TAG` constant | `APPS_INSTRUCTIONS_CLOSE_TAG` constant | [`apps_instructions.rs:21-23`](refs/codex/codex-rs/core/src/context/apps_instructions.rs#L21-L23) |
| AvailableSkillsInstructions | `developer` | `SKILLS_INSTRUCTIONS_OPEN_TAG` constant | `SKILLS_INSTRUCTIONS_CLOSE_TAG` constant | [`available_skills_instructions.rs:24-26`](refs/codex/codex-rs/core/src/context/available_skills_instructions.rs#L24-L26) |

Unmarked fragments (empty START/END strings) never match arbitrary text — `ContextualUserFragment::matches_text` defaults to `false` when markers are empty.

## Claims & anchors

| Claim | Anchor | Kind |
|---|---|---|
| **C1**: `Session::build_initial_context(turn_context)` returns `Vec<ResponseItem>` — the head items for `input[]`. Holds the session state lock briefly to read `reference_context_item / previous_turn_settings / collaboration_mode / base_instructions / session_source`. | [`refs/codex/codex-rs/core/src/session/mod.rs:2567`](refs/codex/codex-rs/core/src/session/mod.rs#L2567) | fn |
| **C2**: developer_sections is `Vec::<String>::with_capacity(8)`; contextual_user_sections is `Vec::<String>::with_capacity(2)`. Sizing hint = expected fragment count per role. | [`refs/codex/codex-rs/core/src/session/mod.rs:2572`](refs/codex/codex-rs/core/src/session/mod.rs#L2572) | local declarations |
| **C3**: developer_sections push order: `model_switch` → `PermissionsInstructions` → `developer_instructions` (TurnContext) → `memory_tool_developer_instructions` → `CollaborationModeInstructions` → `realtime_update` → `PersonalitySpec` → `AppsInstructions` → `AvailableSkillsInstructions` → `AvailablePluginsInstructions` → `commit_message_trailer`. All conditional; line order in `build_initial_context` body = wire order. | [`refs/codex/codex-rs/core/src/session/mod.rs:2589`](refs/codex/codex-rs/core/src/session/mod.rs#L2589) | sequence of pushes |
| **C4**: contextual_user_sections push order: `UserInstructions` (AGENTS.md, when `turn_context.user_instructions.is_some`) → `EnvironmentContext` (when `include_environment_context` flag set). Two-fragment max. | [`refs/codex/codex-rs/core/src/session/mod.rs:2719`](refs/codex/codex-rs/core/src/session/mod.rs#L2719) | two if-let blocks |
| **C5**: `build_developer_update_item(text_sections)` produces `ResponseItem::Message { id: None, role: "developer", content: Vec<ContentItem::InputText>, phase: None }`; one ContentItem per section. Returns `None` when sections vec is empty. Same shape via `build_contextual_user_message` with role="user". | [`refs/codex/codex-rs/core/src/context_manager/updates.rs:178`](refs/codex/codex-rs/core/src/context_manager/updates.rs#L178) | fn |
| **C6**: `ContextualUserFragment` trait declares `const ROLE: &'static str; const START_MARKER: &'static str; const END_MARKER: &'static str; fn body(&self) -> String;`. Marked fragments use non-empty markers; unmarked fragments leave both empty and never match arbitrary text via `matches_text`. | [`refs/codex/codex-rs/core/src/context/fragment.rs:39`](refs/codex/codex-rs/core/src/context/fragment.rs#L39) | **trait (TYPE)** |
| **C7**: `EnvironmentContext` fragment: `ROLE = "user"`, `START_MARKER = ENVIRONMENT_CONTEXT_OPEN_TAG` = `"<environment_context>"`, `END_MARKER = "</environment_context>"`. Carries cwd/shell/current_date/timezone/subagents in nested XML-like body. Byte-stable when inputs stable; current_date is the daily-flip slot. | [`refs/codex/codex-rs/core/src/context/environment_context.rs:272`](refs/codex/codex-rs/core/src/context/environment_context.rs#L272) | impl trait |
| **C8**: `UserInstructions` fragment (the AGENTS.md carrier): `ROLE = "user"`, `START_MARKER = "# AGENTS.md instructions for "`, `END_MARKER = "</INSTRUCTIONS>"`. Body composes the AGENTS.md text plus a directory path. | [`refs/codex/codex-rs/core/src/context/user_instructions.rs:10`](refs/codex/codex-rs/core/src/context/user_instructions.rs#L10) | impl trait |
| **C9**: `AppsInstructions` fragment (MCP-connector instructions): `ROLE = "developer"`, markers = `APPS_INSTRUCTIONS_OPEN_TAG` / `APPS_INSTRUCTIONS_CLOSE_TAG`. Body composed from accessible+enabled MCP connectors. | [`refs/codex/codex-rs/core/src/context/apps_instructions.rs:21`](refs/codex/codex-rs/core/src/context/apps_instructions.rs#L21) | impl trait |
| **C10**: `AvailableSkillsInstructions` fragment: `ROLE = "developer"`, markers = `SKILLS_INSTRUCTIONS_OPEN_TAG` / `SKILLS_INSTRUCTIONS_CLOSE_TAG`. Body composed from skill metadata budget; emits warning event when total exceeds budget. | [`refs/codex/codex-rs/core/src/context/available_skills_instructions.rs:24`](refs/codex/codex-rs/core/src/context/available_skills_instructions.rs#L24) | impl trait |
| **C11**: `PermissionsInstructions` fragment: `ROLE = "developer"`, `START_MARKER = "<permissions instructions>"`, `END_MARKER = "</permissions instructions>"`. Composed from PermissionProfile + ExecPolicy + approval policy + features. | [`refs/codex/codex-rs/core/src/context/permissions_instructions.rs:170`](refs/codex/codex-rs/core/src/context/permissions_instructions.rs#L170) | impl trait |
| **C12**: `EnvironmentContext::render()` byte shape pinned by `#[test] serialize_workspace_write_environment_context`. Expected literal body: `"<environment_context>\n  <cwd>{cwd}</cwd>\n  <shell>{shell}</shell>\n  <current_date>{date}</current_date>\n  <timezone>{tz}</timezone>\n</environment_context>"`. | [`refs/codex/codex-rs/core/src/context/environment_context_tests.rs:22`](refs/codex/codex-rs/core/src/context/environment_context_tests.rs#L22) | **test (TEST)** |

Anchor totals: 12 claims, 12 anchors. TEST/TYPE diversity: **1 trait TYPE** (C6 `ContextualUserFragment`) + **1 TEST** (C12 `serialize_workspace_write_environment_context`). 5 additional trait-impl anchors (C7–C11) verify concrete fragment wiring against the C6 trait contract.

## Cross-diagram traceability (per miatdiagram §4.7)

- `core/src/session/mod.rs::build_initial_context` → A4.1, A4.2, A4.3, A4.4, A4.5, A4.6 (verified C1–C5).
- `core/src/context/fragment.rs::ContextualUserFragment` → trait used by A4.1 / A4.2 push payloads (verified C6).
- Concrete fragment files → individual A4.1/A4.2 inputs (verified C7–C11).
- `context/environment_context_tests.rs` → C12 TEST pins byte-shape of the EnvironmentContext render output → connects to D4-1 example payload and D4-2 marker registry.
- D4-1 datasheet `Triggered by` line → A4.3 + A4.4 (verified).
- D4-2 marker registry rows → each fragment Source line resolves to the architecture box for that fragment file (verified).

## Open questions

None. The conditional-push order is mechanically explicit in `build_initial_context`; each fragment's marker is a const in its impl block. The only behavioural nuance worth flagging — the **guardian-message branch** (separate vs collapsed) — is captured in D4-1 row [3] and C3 narrative ("unless guardian").

## OpenCode delta map

The most consequential delta map of the spec. Compare upstream A4.* activities to OpenCode's `packages/opencode/src/session/llm.ts` codex upstream-wire branch:

- **A4.1 developer_sections aggregation** — OpenCode's equivalent assembles `fragments: ContextFragment[]` in [llm.ts:991](packages/opencode/src/session/llm.ts#L991). Push order: `RoleIdentity` (Main/Subagent label, OpenCode-only) → `OpencodeProtocolInstructions` (= SYSTEM.md text) → `OpencodeAgentInstructions` (= agent.prompt + user.system). **Aligned**: no — OpenCode's developer bundle is a subset of upstream's. Missing fragments: `model_switch`, `PermissionsInstructions`, `memory_tool`, `CollaborationModeInstructions`, `realtime_update`, `PersonalitySpec`, `AppsInstructions`, `AvailablePluginsInstructions`, `commit_message_trailer`. Most missing pieces are either non-applicable to OpenCode (CollaborationMode, Personality, Memory) or covered by OpenCode-equivalents (skills via the `skill` tool not via bundle).
- **A4.2 contextual_user_sections** — OpenCode assembles `agents_md:global` + `agents_md:project` + `environment_context` ([llm.ts:1017-1052](packages/opencode/src/session/llm.ts#L1017-L1052)). **Aligned**: yes structurally (UserInstructions + EnvironmentContext order). **Drift**: OpenCode splits AGENTS.md into TWO fragments (global + project) where upstream has only one UserInstructions fragment that the caller composes from multiple files. The OpenCode shape produces TWO `# AGENTS.md instructions for <dir>` blocks; upstream produces one (or none). Cache-impact: prefix bytes differ by ~50 bytes per split, but order is consistent → cache-friendly within OpenCode-only sessions.
- **A4.3 developer ResponseItem composition** — OpenCode wraps the developer bundle as a single ModelMessage with `role: "user"` (yes, "user"!) + `providerOptions.codex.kind = "developer-bundle"` marker; codex-provider's `convert.ts` rewrites `role: "user"` → `role: "developer"` on the wire ([packages/opencode-codex-provider/src/convert.ts](packages/opencode-codex-provider/src/convert.ts)). **Aligned**: result is correct (wire emits role=developer). **Drift**: internal representation uses the AI SDK's restrictive `ModelMessage` role union which doesn't include `"developer"`; the kind marker is the bridge.
- **A4.4 contextual user ResponseItem composition** — Same pattern as A4.3 but with `providerOptions.codex.kind = "user-bundle"`. **Aligned**: yes.
- **A4.5 multi-agent v2 usage hint** — OpenCode does not implement codex's multi-agent v2 feature. The hint developer message is **never emitted by OpenCode**. **Aligned**: no (by design; feature isn't built). **Drift**: OpenCode subagent semantics use its own task() bridge — Chapter 03 delta map already noted this.
- **A4.6 guardian separate developer message** — OpenCode has no guardian reviewer concept. **Aligned**: no (by design). **Drift**: feature gap, not a regression target.

**Cross-cutting drift findings for downstream specs:**

1. **PermissionsInstructions / AppsInstructions / AvailableSkillsInstructions are upstream-only.** OpenCode does not emit any of these three as `developer` bundle fragments. PermissionsInstructions covers approval-policy + sandbox semantics that OpenCode handles via its own UI flow. AppsInstructions duplicates what OpenCode's `tools` field provides (Chapter 05). AvailableSkillsInstructions is supplanted by OpenCode's `skill` tool description (no bundle injection). **These three deltas are intentional and the spec stays internally consistent.**
2. **`RoleIdentity` is OpenCode-only.** Upstream has no equivalent because codex-cli treats Main vs Subagent at the SessionSource layer (Chapter 02 C12) — server-side classification suffices. OpenCode pre-emptively names the role in the developer bundle for clarity, accepting the byte-cost.
3. **OpenCode bundles `agent.prompt + user.system` into one fragment.** Per the shelved [provider_codex-bundle-slow-first-refinement/](../../../plans/provider_codex-bundle-slow-first-refinement/) work, this is the **slow-first violation flagged in Chapter 04 delta**: `user.system` is per-turn churn-y; bundling it with the static `agent.prompt` invalidates the developer bundle hash whenever any `user.system` extra fires. The bundle-slow-first spec's resume gate (now satisfied for this chapter) can move forward citing **this section** rather than re-deriving from greps.
4. **`current_date` daily flip** — upstream `EnvironmentContext` includes `current_date` inline (C7, C12 confirm byte shape `<current_date>...</current_date>` between `<shell>` and `<timezone>`). OpenCode mirrors this exactly. **The daily cache-flip cost is upstream-aligned and accepted as the price of byte-alignment.** Do not split currentDate out; that would diverge from upstream.

Net for the bundle-slow-first refinement spec (currently SHELVED): **L3 split is justifiable per upstream chapter 04 delta finding #3; L6 currentDate split is rejected per finding #4. Resume gate for that spec is now satisfied.**
