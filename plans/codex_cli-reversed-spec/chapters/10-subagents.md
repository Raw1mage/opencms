# Chapter 10: Subagents

> Status: **audited (2026-05-11)** | refs/codex SHA `76845d716b` | 12 claims / 12 anchors / 0 open questions

## Scope

Consolidated view of how upstream codex-cli encodes **subagent identity** on the wire. Pulls together the subagent-conditional fragments scattered across Ch02 (SessionSource at app-server boot), Ch03 (Session inheriting parent state), Ch06 (`build_subagent_headers` + identity headers), Ch08 (`build_ws_client_metadata` subagent + parent_thread keys), and Ch09 (compact endpoint also reuses identity headers).

What's **here**: `SessionSource` enum (8 variants), `SubAgentSource` enum (5 variants), `InternalSessionSource` enum (1 variant), `ThreadSource` enum (3 variants for thread persistence), the `subagent_header_value` label map, the `parent_thread_id_header_value` gate, `run_codex_thread_interactive` spawn semantics (identity inheritance), thread-depth tracking, and the cross-chapter table of which header / metadata key each subagent variant emits.

**Deferred**:
- Cache implications of subagent windows vs main session (Chapter 11).
- Per-subagent context-fragment subset (subagents skip AGENTS.md, Ch04 A4.2 already covered the gate).
- Rollout trace / telemetry per subagent (Chapter 12).

## Module architecture

```mermaid
graph TB
  subgraph Protocol["codex-rs/protocol/src/protocol.rs"]
    sess_src["SessionSource (enum, 8 variants, line 2500)"]
    int_src["InternalSessionSource (enum, 1 variant: MemoryConsolidation)"]
    sub_src["SubAgentSource (enum, 5 variants)"]
    thr_src["ThreadSource (enum, 3 variants for rollout/persistence)"]
  end

  subgraph CoreClient["codex-rs/core/src/client.rs"]
    bsv["subagent_header_value (fn line 1672)"]
    ptid["parent_thread_id_header_value (fn line 1693)"]
    build_sub["build_subagent_headers (Ch06 C10)"]
    build_id["build_responses_identity_headers (Ch06 C10)"]
    build_ws_meta["build_ws_client_metadata (Ch08 C5)"]
  end

  subgraph CoreSubagent["codex-rs/core/src/"]
    delegate["codex_delegate.rs::run_codex_thread_interactive (line 65)"]
    sess_new["session/session.rs::Session::new (Ch03 C5)"]
    thread_mgr["thread_manager.rs (depth tracking)"]
    agent_reg["agent/registry.rs::depth extract (line 65)"]
  end

  subgraph Guardian["codex-rs/core/src/guardian/"]
    review_sess["review_session.rs::run_review (line 294)"]
  end

  subgraph Memory["codex-rs/core/src/memories/"]
    memgen["memory consolidation drives Internal(MemoryConsolidation)"]
  end

  subgraph Compact["codex-rs/core/src/"]
    compact_remote["compact_remote.rs (Ch09)"]
  end

  sess_src --> bsv
  sess_src --> ptid
  sub_src --> sess_src
  int_src --> sess_src
  bsv --> build_sub
  ptid --> build_id
  build_sub --> build_id
  build_id --> build_ws_meta

  delegate --> sess_new
  delegate -->|inherits installation_id, services| sess_new
  delegate -->|SessionSource::SubAgent(...)| sess_src
  review_sess --> delegate
  memgen --> sess_src
  compact_remote --> sess_src
  thread_mgr --> sub_src
  agent_reg --> sub_src
```

Stack view (subagent spawn → wire identity):

```
┌─────────────────────────────────────────────────────────────┐
│ Parent Session (Main agent OR another subagent)             │
│   has: installation_id, services, conversation_id, ...      │
├─────────────────────────────────────────────────────────────┤
│ Trigger: review / compact / memory_consolidation / spawn     │
│   ↓                                                          │
│ run_codex_thread_interactive (codex_delegate.rs:65)         │
│   inherit parent_session.installation_id (line 79) ───►     │
│   inherit services (auth, models, env, skills, plugins, mcp)│
│   set SessionSource = SubAgent(subagent_source)             │
│   set ThreadSource  = Some(ThreadSource::Subagent)          │
├─────────────────────────────────────────────────────────────┤
│ Session::new (Ch03 C5) — child session with parent identity │
│   conversation_id = ThreadId::default() (new UUID for child)│
│   installation_id = (inherited, same UUID as parent)         │
│   window_generation = 0                                     │
├─────────────────────────────────────────────────────────────┤
│ Each turn → ModelClient builds headers/metadata             │
│   subagent_header_value(session_source) → label string      │
│   parent_thread_id_header_value(session_source) → Some only │
│                                                  for ThreadSpawn │
│   ↓                                                          │
│   HTTP path (Ch06): x-openai-subagent header + (optional)   │
│                     x-codex-parent-thread-id header         │
│   WS path (Ch08):   same keys appear in client_metadata     │
│   Compact path (Ch09): same keys appear in headers          │
├─────────────────────────────────────────────────────────────┤
│ Server sees per-request: x-openai-subagent + (when ThreadSpawn)│
│                          x-codex-parent-thread-id + window_id │
│   → routes / classifies the request as a subagent variant   │
└─────────────────────────────────────────────────────────────┘
```

## IDEF0 decomposition

See [`idef0.10.json`](idef0.10.json). Activities:

- **A10.1** Classify subagent variant — SessionSource enum holds the parent vs subagent vs internal distinction.
- **A10.2** Inherit identity at spawn — `run_codex_thread_interactive` copies parent's installation_id + services, sets `SessionSource::SubAgent(subagent_source)`.
- **A10.3** Map source → subagent label — `subagent_header_value` produces 5 distinct labels + None for non-subagent sources.
- **A10.4** Map source → parent_thread_id — `parent_thread_id_header_value` returns Some only on ThreadSpawn variant.
- **A10.5** Conditional header / metadata emission — `build_subagent_headers` (HTTP), `build_responses_identity_headers` (parent_thread_id), `build_ws_client_metadata` (WS metadata), all consume the two helpers above.
- **A10.6** Memory-consolidation special case — `Internal(MemoryConsolidation)` is not under SubAgent but still triggers `x-openai-subagent: memory_consolidation` + `x-openai-memgen-request: true`.

## GRAFCET workflow

See [`grafcet.10.json`](grafcet.10.json). Spawn → identity inherit → per-turn header emission → completion / cleanup.

## Controls & Mechanisms

A10.5 has 3 emission sites (HTTP / WS / Compact); cross-referenced in datasheet D10-1.

## Protocol datasheet

### D10-1: Subagent-variant → wire-identity matrix

| Source variant | `x-openai-subagent` label | `x-codex-parent-thread-id` | `x-openai-memgen-request` | Where emitted (HTTP / WS / Compact) |
|---|---|---|---|---|
| `SessionSource::Cli` | absent | absent | absent | All paths: clean main session. |
| `SessionSource::VSCode` (default) | absent | absent | absent | All paths: clean main session (default for app-server). |
| `SessionSource::Exec` | absent | absent | absent | All paths: non-interactive main. |
| `SessionSource::Mcp` | absent | absent | absent | All paths: MCP-launched main. |
| `SessionSource::Custom(label)` | absent | absent | absent | All paths: caller-customised; non-subagent. |
| `SessionSource::Unknown` (serde fallback) | absent | absent | absent | All paths: degraded. |
| `SessionSource::Internal(InternalSessionSource::MemoryConsolidation)` | `"memory_consolidation"` | absent | **`"true"`** | All paths. Memory consolidation is "internal subagent-like". |
| `SessionSource::SubAgent(SubAgentSource::Review)` | `"review"` | absent | absent | All paths. Guardian review subagent. |
| `SessionSource::SubAgent(SubAgentSource::Compact)` | `"compact"` | absent | absent | All paths. Compaction-driving subagent. |
| `SessionSource::SubAgent(SubAgentSource::MemoryConsolidation)` | `"memory_consolidation"` | absent | absent | All paths. Subagent-form memory consolidation. |
| `SessionSource::SubAgent(SubAgentSource::ThreadSpawn { parent_thread_id, depth, agent_path?, agent_nickname?, agent_role? })` | **`"collab_spawn"`** | **`Some(parent_thread_id)`** | absent | All paths. The only variant that emits parent_thread_id. |
| `SessionSource::SubAgent(SubAgentSource::Other(label))` | `label` (verbatim caller string) | absent | absent | All paths. Caller-controlled label. |

**Where each key surfaces** (cross-chapter consolidation):

- **HTTP streaming path** (Ch06): `x-openai-subagent` HTTP header via `build_subagent_headers` (Ch06 C10); `x-codex-parent-thread-id` HTTP header via `build_responses_identity_headers` (Ch06 C10); `x-openai-memgen-request: true` HTTP header (Ch06 D6-2 row).
- **WS path** (Ch08): same three keys appear in **`client_metadata` body** of the first frame, via `build_ws_client_metadata` (Ch08 C5). Plus the same keys also in handshake headers via `build_websocket_headers` (Ch08 C2).
- **Compact path** (Ch09): same three keys appear in HTTP headers via `build_responses_identity_headers` (reused by compact path at Ch09 C7).

### D10-2: Identity inheritance at spawn (parent → child)

**Triggered by**: A10.2 — `run_codex_thread_interactive`.
**Source**: [`refs/codex/codex-rs/core/src/codex_delegate.rs:65`](refs/codex/codex-rs/core/src/codex_delegate.rs#L65).

| Field | Inherited from parent? | Source (file:line) | Notes |
|---|---|---|---|
| `installation_id` | **yes — identical UUID** | [`codex_delegate.rs:79`](refs/codex/codex-rs/core/src/codex_delegate.rs#L79) | Per-install identity (Ch02 D2-2). Subagent and parent share. |
| `services.auth_manager` | yes (Arc clone) | [`codex_delegate.rs:80`](refs/codex/codex-rs/core/src/codex_delegate.rs#L80) | Same OAuth/AgentIdentity context. |
| `services.models_manager` | yes (Arc clone) | [`codex_delegate.rs:81`](refs/codex/codex-rs/core/src/codex_delegate.rs#L81) | Same model registry. |
| `services.environment_manager` | yes (Arc clone) | [`codex_delegate.rs:82`](refs/codex/codex-rs/core/src/codex_delegate.rs#L82) | Same env / cwd state. |
| `services.skills_manager` | yes (Arc clone) | [`codex_delegate.rs:83`](refs/codex/codex-rs/core/src/codex_delegate.rs#L83) | Same skills catalog. |
| `services.plugins_manager` | yes (Arc clone) | [`codex_delegate.rs:84`](refs/codex/codex-rs/core/src/codex_delegate.rs#L84) | Same plugin set. |
| `services.mcp_manager` | yes (Arc clone) | [`codex_delegate.rs:85`](refs/codex/codex-rs/core/src/codex_delegate.rs#L85) | Same MCP connections. |
| `agent_control` | yes (clone) | [`codex_delegate.rs:88`](refs/codex/codex-rs/core/src/codex_delegate.rs#L88) | Coordinates subagent-tree concurrency. |
| `exec_policy` | yes (Arc clone, marked `inherited_exec_policy`) | [`codex_delegate.rs:94`](refs/codex/codex-rs/core/src/codex_delegate.rs#L94) | Same execution policy. |
| `session_source` | **rewritten to `SubAgent(subagent_source)`** | [`codex_delegate.rs:86`](refs/codex/codex-rs/core/src/codex_delegate.rs#L86) | The single distinguishing field. |
| `thread_source` | set to `Some(ThreadSource::Subagent)` | [`codex_delegate.rs:87`](refs/codex/codex-rs/core/src/codex_delegate.rs#L87) | Rollout-classification field. |
| `conversation_id` (ThreadId) | **fresh UUID v7** (Ch03 C6) | [`session/session.rs:386`](refs/codex/codex-rs/core/src/session/session.rs#L386) | Child gets its own thread_id. |
| `window_generation` | starts at 0 | [`session/session.rs:392`](refs/codex/codex-rs/core/src/session/session.rs#L392) | Child window starts fresh. |

**Key invariant**: parent and child share `installation_id`; they have **distinct** `thread_id` / `conversation_id`. `x-codex-parent-thread-id` (when ThreadSpawn) carries the **parent's** thread_id so the backend can correlate the subagent to its parent.

## Claims & anchors

| Claim | Anchor | Kind |
|---|---|---|
| **C1**: `SessionSource` enum has 8 variants: `Cli`, `VSCode` (default), `Exec`, `Mcp`, `Custom(String)`, `Internal(InternalSessionSource)`, `SubAgent(SubAgentSource)`, `Unknown` (`#[serde(other)]` fallback). Serde rename_all = "lowercase". | [`refs/codex/codex-rs/protocol/src/protocol.rs:2500`](refs/codex/codex-rs/protocol/src/protocol.rs#L2500) | **enum (TYPE)** |
| **C2**: `SubAgentSource` enum has 5 variants: `Review`, `Compact`, `ThreadSpawn { parent_thread_id: ThreadId, depth: i32, agent_path?: Option<AgentPath>, agent_nickname?: Option<String>, agent_role?: Option<String> }`, `MemoryConsolidation`, `Other(String)`. Serde rename_all = "snake_case". | [`refs/codex/codex-rs/protocol/src/protocol.rs:2561`](refs/codex/codex-rs/protocol/src/protocol.rs#L2561) | **enum (TYPE)** |
| **C3**: `InternalSessionSource` enum has 1 variant: `MemoryConsolidation`. Distinct from `SubAgentSource::MemoryConsolidation` (both exist; both produce the same `x-openai-subagent: memory_consolidation` label but the Internal variant also produces `x-openai-memgen-request: true`). | [`refs/codex/codex-rs/protocol/src/protocol.rs:2554`](refs/codex/codex-rs/protocol/src/protocol.rs#L2554) | **enum (TYPE)** |
| **C4**: `ThreadSource` enum has 3 variants: `User`, `Subagent`, `MemoryConsolidation`. Separate from `SessionSource` — used in rollout / thread persistence to classify which kind of thread produced a record. `as_str()` returns the snake_case form. | [`refs/codex/codex-rs/protocol/src/protocol.rs:2516`](refs/codex/codex-rs/protocol/src/protocol.rs#L2516) | **enum (TYPE)** |
| **C5**: `subagent_header_value(&SessionSource) -> Option<String>` returns: `Some("review")` for SubAgent(Review); `Some("compact")` for SubAgent(Compact); `Some("memory_consolidation")` for SubAgent(MemoryConsolidation) OR Internal(MemoryConsolidation); **`Some("collab_spawn")`** for SubAgent(ThreadSpawn{..}); `Some(label.clone())` for SubAgent(Other(label)); **None** for Cli/VSCode/Exec/Mcp/Custom/Unknown. | [`refs/codex/codex-rs/core/src/client.rs:1672`](refs/codex/codex-rs/core/src/client.rs#L1672) | fn |
| **C6**: Non-subagent SessionSource variants (Cli, VSCode, Exec, Mcp, Custom, Unknown) explicitly return None from both `subagent_header_value` and `parent_thread_id_header_value` — no subagent-related header / metadata key is emitted. This is the negative invariant for main-session requests. | [`refs/codex/codex-rs/core/src/client.rs:1684`](refs/codex/codex-rs/core/src/client.rs#L1684) | fn match arm |
| **C7**: `parent_thread_id_header_value(&SessionSource) -> Option<String>` returns `Some(parent_thread_id.to_string())` **only** for `SubAgent(ThreadSpawn { parent_thread_id, .. })`. All other variants — including SubAgent(Review/Compact/MemoryConsolidation/Other), Internal(*), and main-session variants — return None. → `x-codex-parent-thread-id` only emitted on ThreadSpawn. | [`refs/codex/codex-rs/core/src/client.rs:1693`](refs/codex/codex-rs/core/src/client.rs#L1693) | fn |
| **C8**: `build_subagent_headers` (Ch06 C10) inserts `X_OPENAI_SUBAGENT_HEADER` from `subagent_header_value` result, AND inserts `X_OPENAI_MEMGEN_REQUEST_HEADER` value `"true"` (HeaderValue::from_static) **only** when `SessionSource::Internal(InternalSessionSource::MemoryConsolidation)`. SubAgent(MemoryConsolidation) does NOT trigger memgen — only Internal variant does. | [`refs/codex/codex-rs/core/src/client.rs:593`](refs/codex/codex-rs/core/src/client.rs#L593) | fn |
| **C9**: Subagent spawn entry `run_codex_thread_interactive(config, auth_manager, models_manager, parent_session, parent_ctx, cancel_token, subagent_source, initial_history) -> Result<Codex, CodexErr>` is the canonical caller. Identity inheritance documented in D10-2: copies parent's `installation_id` (line 79), `services` (lines 80-85, 88, 94), sets `session_source = SessionSource::SubAgent(subagent_source.clone())` (line 86), `thread_source = Some(ThreadSource::Subagent)` (line 87). | [`refs/codex/codex-rs/core/src/codex_delegate.rs:65`](refs/codex/codex-rs/core/src/codex_delegate.rs#L65) | fn |
| **C10**: ThreadSpawn depth is extracted across the codebase to prevent infinite nesting / enforce limits — e.g. `agent/registry.rs:65` extracts `depth` for nesting checks. Captured in SubAgentSource::ThreadSpawn::depth field (C2). | [`refs/codex/codex-rs/core/src/agent/registry.rs:65`](refs/codex/codex-rs/core/src/agent/registry.rs#L65) | depth read |
| **C11**: Cross-chapter consolidation — D10-1 row for ThreadSpawn is independently verified by Ch08 C12 TEST (`build_ws_client_metadata_includes_window_lineage_and_turn_metadata`) which constructs a ThreadSpawn subagent and asserts: `X_OPENAI_SUBAGENT_HEADER → "collab_spawn"` + `X_CODEX_PARENT_THREAD_ID_HEADER → parent_thread_id.to_string()`. Re-anchoring here as the cross-chapter reference. | [`refs/codex/codex-rs/core/src/client_tests.rs:272`](refs/codex/codex-rs/core/src/client_tests.rs#L272) | **test (TEST, cross-ref)** |
| **C12**: TEST `build_subagent_headers_sets_internal_memory_consolidation_label` constructs ModelClient with `SessionSource::Internal(InternalSessionSource::MemoryConsolidation)`, calls `build_subagent_headers`, asserts `X_OPENAI_SUBAGENT_HEADER` value == `"memory_consolidation"`. Companion to client_tests.rs:248 (Ch06 C12). Pins the Internal-variant label emission AND the memgen flag (since the same fn body emits both — line 602-607 of client.rs covers the memgen insertion). | [`refs/codex/codex-rs/core/src/client_tests.rs:260`](refs/codex/codex-rs/core/src/client_tests.rs#L260) | **test (TEST)** |

Anchor totals: 12 claims, 12 anchors. TEST/TYPE diversity: **4 TYPE** (C1 SessionSource, C2 SubAgentSource, C3 InternalSessionSource, C4 ThreadSource) + **2 TEST** (C11 cross-ref, C12 new). Plus 6 fn / fn-body anchors.

## Cross-diagram traceability (per miatdiagram §4.7)

Walked:
- `protocol/src/protocol.rs::SessionSource + SubAgentSource + InternalSessionSource + ThreadSource` (C1, C2, C3, C4) → A10.1 → D10-1 row enumeration ✓
- `core/src/client.rs::subagent_header_value` (C5) → A10.3 → D10-1 label column ✓
- `core/src/client.rs::parent_thread_id_header_value` (C7) → A10.4 → D10-1 parent_thread_id column ✓
- `core/src/client.rs::build_subagent_headers` (C8) → A10.5 → D10-1 emission cells ✓
- `core/src/codex_delegate.rs::run_codex_thread_interactive` (C9) → A10.2 → D10-2 ✓
- `core/src/agent/registry.rs::depth read` (C10) → A10.1 depth-tracking ✓
- Cross-refs to Ch06 C10 (build_responses_identity_headers), Ch08 C5 (build_ws_client_metadata), Ch09 C7 (compact path identity headers) — all already anchored ✓
- TEST C11 (Ch08 anchor) verifies ThreadSpawn end-to-end ✓
- TEST C12 verifies Internal(MemoryConsolidation) variant ✓

All cross-links verified.

## Open questions

None for Chapter 10. The cache-routing implications of emitting `x-openai-subagent` (does the backend partition cache by subagent label?) belong to Chapter 11. The relationship between `ThreadSource` and rollout/persistence formatting belongs to Chapter 12.

## OpenCode delta map

- **A10.1 SessionSource classification** — OpenCode does not use upstream's `SessionSource` enum. The closest analogues are in `packages/opencode/src/session/index.ts` (`Session.Info` has `agent` + `mode` + `autonomous` fields) and per-task `subagent_source`-like distinctions in [`packages/opencode/src/tool/task.ts`](packages/opencode/src/tool/task.ts). **Aligned**: no — different abstraction. **Drift**: by design.
- **A10.2 Identity inheritance** — OpenCode subagents inherit installation_id (after Ch02-grad spec) and most services via the daemon's shared registry. The Arc-clone-of-services pattern doesn't apply (different runtime model). **Aligned**: functionally yes; mechanically no.
- **A10.3 Subagent label mapping** — OpenCode's codex-provider emits `x-openai-subagent` only when `parentThreadId` is passed. From [`packages/opencode-codex-provider/src/headers.ts:73-76`](packages/opencode-codex-provider/src/headers.ts#L73-L76): `if (options.subagentLabel) { headers["x-openai-subagent"] = options.subagentLabel; }`. The label string is caller-controlled (no centralised mapping like upstream's `subagent_header_value`). **Drift**: OpenCode does not standardise on the 5 upstream-canonical labels ("review" / "compact" / "memory_consolidation" / "collab_spawn" / custom). It accepts whatever the caller passes. For backend classification this MAY matter if upstream's first-party filter checks against the specific 5 labels.
- **A10.4 parent_thread_id emission** — OpenCode emits `x-codex-parent-thread-id` whenever `parentThreadId` option is supplied to `buildHeaders` — caller-controlled, no enforcement that the source variant is ThreadSpawn-equivalent. **Aligned**: structurally yes (header gets emitted); **Drift**: caller can emit parent_thread_id for non-ThreadSpawn variants, which upstream never does.
- **A10.5 Header / metadata emission** — Already covered in Ch06 / Ch08 / Ch09 delta maps. The OpenCode WS path (`x-codex-window-id` in `client_metadata`) is upstream-aligned per Ch08 C5; subagent label keys in `client_metadata` are not currently emitted by OpenCode (gap flagged in Ch08 delta).
- **A10.6 Memory-consolidation special case** — OpenCode does NOT emit `x-openai-memgen-request: true` for any session — there is no equivalent of upstream's `Internal(InternalSessionSource::MemoryConsolidation)` source. **Aligned**: no. **Drift**: feature gap. OpenCode does not currently run upstream-style memory consolidation; if/when it adds memory features, this header must be emitted for the Internal-variant code path.

**Cross-cutting findings for downstream specs:**

1. **OpenCode lacks the centralised `subagent_header_value` mapping**. The bundle-slow-first work and any future OpenCode subagent spec should consider adopting the 5 canonical labels (review/compact/memory_consolidation/collab_spawn/custom) to maintain first-party classification compatibility with backend.

2. **`x-openai-memgen-request` is a backend hint codex relies on for memory-consolidation paths**. Not relevant to OpenCode today but worth recording for the memory-feature roadmap.

3. **parent_thread_id is structurally meaningful only for ThreadSpawn**. OpenCode's caller-controlled emission could send it for variants where upstream doesn't — confirm with backend tolerance test before using it on non-spawn subagents.

4. **D10-2's identity-inheritance contract is upstream-strict**. OpenCode inherits less explicitly via the daemon's shared registry. If OpenCode ever forks a "child session" via something like `task()`, the same installation_id + thread_id distinct invariant should hold; record this when subagent semantics are formalised.
