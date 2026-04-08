# Codex Protocol Whitepaper

## Scope

This document describes the request and transport patterns observed in the official Codex CLI source vendored in `refs/codex/`. It is a source-derived interoperability note for `opencode`, not a normative OpenAI specification.

**Upstream ref**: `refs/codex/` at `origin/main` (fetched 2026-04-08, HEAD = `2250fdd54a`)

## Primary Source Files

- `refs/codex/codex-rs/core/src/client.rs` — transport, headers, WS session management
- `refs/codex/codex-rs/codex-api/src/common.rs` — `ResponsesApiRequest`, `ResponseCreateWsRequest` types
- `refs/codex/codex-rs/core/src/client_common.rs` — input encoding, tool serialization
- `refs/codex/codex-rs/core/src/codex.rs` — session lifecycle, compaction orchestration, subagent
- `refs/codex/codex-rs/core/src/compact.rs` — compaction logic, WS reset after compact
- `refs/codex/codex-rs/core/src/agent/` — agent registry, mailbox, control
- `refs/codex/codex-rs/login/src/auth/default_client.rs` — originator, first-party detection
- `refs/codex/codex-rs/app-server/src/message_processor.rs` — app-server bootstrap, originator routing
- `refs/codex/codex-rs/codex-api/src/endpoint/realtime_call.rs` — WebRTC transport (NEW)
- `refs/codex/codex-rs/core/src/installation_id.rs` — stable installation UUID (NEW)

---

## Protocol Layers

### 1. Instruction Layer

Codex builds a top-level `instructions` string separate from conversational `input`.

- Canonical base instructions from model metadata or prompt templates.
- Personality composed into instruction template before dispatch.
- Request body uses top-level `instructions`, not pseudo-user messages.

### 2. Responses API Request Body

`ResponsesApiRequest` (HTTP) canonical fields:

```json
{
  "model": "string",
  "instructions": "string",
  "input": [],
  "tools": [],
  "tool_choice": "auto",
  "parallel_tool_calls": true,
  "reasoning": {},
  "store": false,
  "stream": true,
  "include": [],
  "service_tier": "priority",
  "prompt_cache_key": "thread-id",
  "text": {},
  "context_management": [],
  "client_metadata": {}
}
```

**Delta from previous whitepaper revision**:

| Field | Change | Source |
|---|---|---|
| `client_metadata` | **NEW** — `HashMap<String, String>`, now on both HTTP and WS requests | `common.rs` #16912 |
| `context_management` | Unchanged — `[{type: "compaction", compact_threshold: N}]` | — |

`ResponseCreateWsRequest` (WS-only) additional fields:

| Field | HTTP | WS |
|---|---|---|
| `previous_response_id` | **absent** | `Option<String>` |
| `generate` | absent | `Option<bool>` |
| `client_metadata` | `Option<HashMap>` (NEW) | `Option<HashMap>` |

**Key finding**: `previous_response_id` remains WS-only in codex-rs. HTTP struct does not have it.

### 3. Input Item Encoding

Observed item families:

- **Conversational**: `system`, `developer`, `user`, `assistant`
- **Tool lifecycle**: `function_call`, `function_call_output`, `local_shell_call`, `local_shell_call_output`, custom tool variants
- **Reasoning/Reference**: `reasoning`, `item_reference`

Notable: shell output re-serialized for `apply_patch` path; patches now go through executor filesystem (#17048).

### 4. Tool Encoding

Categories: `function`, `local_shell`, `image_generation`, `web_search`, `custom`.

**New in upstream**:
- Namespace descriptions rendered for tools (#16879)
- Function attribute descriptions rendered (#16880)
- `anyOf` and `enum` support in JsonSchema (#16875, #17052)

### 5. Reasoning and Text Controls

Conditionally sent: `reasoning.effort`, `reasoning.summary`, `include: ["reasoning.encrypted_content"]`, `text.verbosity`, `text.format`.

**New**: `OpenAiVerbosity` type now publicly exported from `codex-api`.

### 6. Session-Scoped Transport Metadata

Headers and metadata channels:

| Channel | Purpose | Notes |
|---|---|---|
| `conversation_id` | Thread identity, prompt_cache_key source | Unchanged |
| `session_source` | CLI/subagent/review origin | Unchanged |
| `x-codex-beta-features` | Feature gating | Unchanged |
| `x-codex-turn-state` | Sticky routing during turn | Unchanged |
| `x-codex-turn-metadata` | Per-turn metadata | Unchanged |
| `x-codex-window-id` | **NEW** — `{conversation_id}:{window_generation}` | #16758 |
| `x-codex-parent-thread-id` | **NEW** — Parent thread for subagents | #16758 |
| `x-openai-subagent` | **NEW** — Subagent identity header | #16758 |
| `x-codex-installation-id` | **NEW** — Stable installation UUID via `client_metadata` | #16912 |

**Context-window lineage model** (#16758): Each session tracks a monotonic `window_generation` counter. After compaction, `window_generation` is advanced. The `x-codex-window-id` header = `"{conversation_id}:{window_generation}"` — this tells the server which "window" of the context the request belongs to, enabling server-side continuity reasoning.

### 7. Continuation and Incremental Reuse

Unchanged mechanisms:
- Request equality comparison excluding `input`
- Incremental item delta generation
- Cached websocket session reuse
- Thread-bound `prompt_cache_key`

**New behavior**: After compaction, `client_session.reset_websocket_session()` is called (#16758). This ensures the WS session is invalidated after context window changes, preventing stale continuation.

### 8. Compaction

Server-side compaction via `context_management`:

```json
{ "context_management": [{ "type": "compaction", "compact_threshold": N }] }
```

Client-side compaction (`compact.rs`):
- Remote compaction preferred for OpenAI providers (`should_use_remote_compact_task`)
- Inline auto-compaction for non-OpenAI
- After compaction: WS session reset + `window_generation` advance
- `InitialContextInjection` enum controls whether system prompt is re-injected after compaction

### 9. Identity and Originator (CHANGED)

**Previous model**: TUI hardcoded `codex_cli_rs` as originator (workaround).

**Current model** (#16116):
- App-server uses `client_name` directly as originator (no TUI workaround)
- `codex-tui` added to first-party whitelist

First-party originator values:
1. `codex_cli_rs` (DEFAULT_ORIGINATOR, direct CLI)
2. `codex-tui` (NEW, TUI via app-server)
3. `codex_vscode` (VS Code extension)
4. `Codex *` (prefix match, any official Codex product)

**Installation ID** (#16912):
- UUID persisted at `$CODEX_HOME/installation_id`
- Sent as `x-codex-installation-id` in `client_metadata`
- File locked (flock), mode 0644, auto-created

### 10. Architecture Changes

#### App-Server Bootstrap (#16582)

Single app-server process bootstraps in TUI — TUI no longer runs the core directly, instead communicates through app-server protocol. This is a fundamental architectural shift:

- `codex-tui` → `app-server` → `codex-core`
- Auth centralized in app-server (#16764)
- Config changes unified (#16961)
- Device-code auth routed through app-server (#16827)

#### Crate Restructuring

- `codex-core` reduced module visibility (#16978)
- Config types extracted to separate crate (#16962)
- Models manager extracted from core (#16508)
- `api_bridge` moved from `core` to `codex-api`
- Many types previously `pub` are now `pub(crate)` — only explicit re-exports

#### Agent Subsystem

- **Mailbox** (`agent/mailbox.rs`): NEW — inter-agent communication via `mpsc` channels with sequence tracking
- **Registry** (renamed from `guards.rs`): Agent role management restructured
- Agent control significantly reworked (#16567 race fixes, state machine rework)

#### WebRTC Transport (#16960)

New `RealtimeCallClient` for WebRTC-based realtime sessions:
- SDP negotiation via multipart POST
- Uses same auth/session infrastructure as WS
- Parallel to existing WS transport, not a replacement

### 11. Analytics

- Subagent analytics tracking (#15915)
- Protocol-native turn timestamps (#16638)
- `installation_id` in `client_metadata` (#16912)
- `AppServerClientMetadata` carries `client_name` + `client_version` for analytics

---

## Comparison With `opencode`

### Currently Aligned

| Aspect | Status |
|---|---|
| Top-level `instructions` | Aligned (via fetch interceptor body transform) |
| `input` as ResponseItem[] | Aligned (via AI SDK Responses adapter) |
| `tools` serialization | Aligned (AI SDK handles) |
| `reasoning` / `text` controls | Aligned (via providerOptions) |
| `prompt_cache_key` | Aligned (set to conversation_id) |
| `context_management` | Aligned (dynamic compact_threshold, compaction-hotfix merged) |
| `previous_response_id` (WS) | Aligned (codex-websocket.ts) |
| WS incremental delta | Aligned (input trimming) |

### Currently Misaligned

| Aspect | Gap | Priority |
|---|---|---|
| **Originator** | We send nothing → third-party on dashboard | HIGH |
| **client_metadata** | Not sent (missing installation_id, window lineage) | HIGH |
| **x-codex-window-id** | Not sent | MEDIUM |
| **x-codex-parent-thread-id** | Not sent (no subagent thread tracking) | LOW |
| **WS reset after compaction** | Not implemented | MEDIUM |
| **window_generation tracking** | Not implemented | MEDIUM |
| **User-agent** | AI SDK default, not codex-compatible | LOW |
| **context_management** via interceptor | Works but not model-switch reactive | DONE (hotfix) |

### Architecture Divergence

| Official | opencode |
|---|---|
| TUI → app-server → core (single process) | Web → AI SDK → fetch interceptor → provider |
| Rust crate boundaries, `pub(crate)` isolation | TypeScript modules, plugin boundary |
| Native Responses API client | AI SDK `@ai-sdk/openai` adapter |
| Mailbox-based inter-agent comm | Bus pub/sub |
| `installation_id` file-based | No equivalent yet |

---

## Internal or Non-Public Surfaces

### Safe to adopt (public Responses API)

- `instructions`, `input`, `tools`, `reasoning`, `text`, `prompt_cache_key`
- `context_management` (compaction)
- `client_metadata` (arbitrary key-value, documented)
- `service_tier`

### Caution — observed but not public

| Surface | Guidance |
|---|---|
| `x-codex-turn-state` | Do not synthesize. Sticky-routing token with undocumented lifecycle. |
| `x-codex-turn-metadata` | Do not copy. Schema tied to official observability. |
| `x-codex-beta-features` | Do not emit. Feature keys coupled to official gates. |
| `x-codex-window-id` | Potentially adoptable (thread:gen format), but verify server acceptance for third-party. |
| `x-codex-parent-thread-id` | Same caution as window-id. |
| `session_source` | Internal enum. Model `opencode` session roles separately. |
| Shell output normalization | Adopt as quality heuristic, not protocol requirement. |
| User-agent tokenization | Use truthful `opencode/...` agent string. |

### Anti-Footgun Checklist

- Do not send official `x-codex-*` headers without verifying server acceptance for non-official clients.
- Do not copy the official user-agent format.
- Do not assume `conversation_id` and `session_source` are public compatibility requirements.
- Do not rely on observed beta feature keys.
- Do not assume incremental websocket behavior can be reproduced by matching body shape alone.
- Do not treat client-side shell normalization details as mandatory wire protocol.
- **NEW**: Do not assume `codex_cli_rs` is the only valid first-party originator — `codex-tui` and `Codex *` prefix are also valid.
- **NEW**: `client_metadata` is propagated from HTTP to WS — use it for analytics, not identity claims.

---

## Changelog

| Date | Change |
|---|---|
| 2026-04-02 | Initial whitepaper from source analysis |
| 2026-04-08 | Major update: context-window lineage, originator architecture change, client_metadata, WebRTC, installation_id, app-server bootstrap, crate restructuring, agent mailbox, compaction WS reset |
