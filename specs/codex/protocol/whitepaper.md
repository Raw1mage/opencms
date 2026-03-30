# Codex Protocol Whitepaper

## Scope

This document describes the request and transport patterns observed in the official Codex CLI source that is vendored in `refs/codex/`. It is not a normative OpenAI specification. It is a source-derived interoperability note for `opencode`.

The focus is:

- Responses API request body shape
- Input item encoding rules
- Tool encoding rules
- Session and transport metadata attached by the official client
- Areas where `opencode` is currently aligned vs misaligned

This document intentionally does not recommend client impersonation. Where the official client emits identity-bearing metadata, this paper treats it as transport context, not something a third-party client should copy verbatim.

## Primary Source Files

- `refs/codex/codex-rs/core/src/client.rs`
- `refs/codex/codex-rs/codex-api/src/common.rs`
- `refs/codex/codex-rs/core/src/client_common.rs`
- `refs/codex/codex-rs/core/src/models_manager/model_info.rs`
- `refs/codex/codex-rs/core/prompt.md`
- `refs/codex/codex-rs/core/templates/model_instructions/gpt-5.2-codex_instructions_template.md`
- `refs/codex/codex-rs/core/templates/personalities/gpt-5.2-codex_pragmatic.md`

## Protocol Layers

The official Codex CLI behavior is easier to reason about as four layers:

1. Instruction layer
2. Responses API request body
3. Session-scoped transport metadata
4. Incremental continuation behavior

### 1. Instruction Layer

Codex builds a large top-level `instructions` string and keeps it separate from normal conversational `input`.

Observed properties:

- The canonical base instructions come from model metadata or prompt templates.
- Personality is composed into the instruction template before request dispatch.
- The request body uses top-level `instructions`, not a pseudo-user message, to carry the main agent contract.

Key references:

- `refs/codex/codex-rs/core/src/client.rs`
- `refs/codex/codex-rs/core/src/models_manager/model_info.rs`

### 2. Responses API Request Body

The official request body is represented by `ResponsesApiRequest`.

Observed canonical fields:

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
  "text": {}
}
```

Field notes:

- `model`: official model slug
- `instructions`: full base instruction contract
- `input`: `ResponseItem[]`
- `tools`: serialized tool specs
- `tool_choice`: currently fixed to `"auto"`
- `parallel_tool_calls`: derived from model/tool support
- `reasoning`: included only when supported
- `store`: provider-dependent
- `stream`: always `true` in the standard turn flow
- `include`: currently used for items like `reasoning.encrypted_content`
- `service_tier`: optional
- `prompt_cache_key`: tied to conversation/thread identity
- `text`: optional verbosity / output schema controls

Key references:

- `refs/codex/codex-rs/codex-api/src/common.rs`
- `refs/codex/codex-rs/core/src/client.rs`

### 3. Input Item Encoding

The official client sends `input` as Responses API items, not plain chat messages.

Observed item families:

- conversational items
  - `system` / `developer`
  - `user`
  - `assistant`
- tool lifecycle items
  - `function_call`
  - `function_call_output`
  - `custom tool` variants
  - `local_shell_call`
  - `local_shell_call_output`
- reasoning and reference items
  - `reasoning`
  - `item_reference`

Notable behavior:

- Tool outputs may be normalized before resend.
- Shell output is specially reserialized when the freeform `apply_patch` path is active, so the model sees structured plain text rather than arbitrary JSON blobs.

Key reference:

- `refs/codex/codex-rs/core/src/client_common.rs`

### 4. Tool Encoding

The official client serializes tools into OpenAI Responses API tool descriptors. Observed tool categories:

- `function`
- `local_shell`
- `image_generation`
- `web_search`
- `custom` freeform tools

Notable behavior:

- Tool serialization is centralized before request creation.
- Tool availability and parallelism are treated as part of the request contract, not inferred ad hoc downstream.

Key reference:

- `refs/codex/codex-rs/core/src/client_common.rs`

### 5. Reasoning and Text Controls

The official client conditionally sends:

- `reasoning.effort`
- `reasoning.summary`
- `include: ["reasoning.encrypted_content"]`
- `text.verbosity`
- `text.format` when structured output is required

This means the official client treats reasoning and output controls as first-class request fields rather than embedding those requirements in prompt text alone.

Key references:

- `refs/codex/codex-rs/core/src/client.rs`
- `refs/codex/codex-rs/codex-api/src/common.rs`

### 6. Session-Scoped Transport Metadata

Beyond the JSON body, the official client attaches extra session metadata.

Observed metadata channels:

- request options:
  - `conversation_id`
  - `session_source`
- extra headers:
  - `x-codex-beta-features`
  - `x-codex-turn-state`
  - `x-codex-turn-metadata`

Observed purposes:

- sticky routing / continuation affinity
- observability
- beta feature gating
- subagent / session source tracking

This metadata is a major part of the official protocol footprint. A client that matches only JSON body shape is still not transport-equivalent to Codex CLI.

Key references:

- `refs/codex/codex-rs/core/src/client.rs`

### 7. Continuation and Incremental Reuse

The official client does not always resend a full logical history.

Observed mechanisms:

- request equality comparison excluding `input`
- incremental item delta generation
- cached websocket session reuse
- thread-bound `prompt_cache_key`

This implies that "Codex protocol" is not just a static body schema. It also includes session continuity behavior.

Key reference:

- `refs/codex/codex-rs/core/src/client.rs`

## Canonical Official Turn Shape

At a high level, a normal Codex turn appears to be:

1. Build a full instruction contract.
2. Build `ResponseItem[]` conversation and tool history.
3. Serialize tools.
4. Add reasoning and text controls if the model supports them.
5. Attach session transport metadata.
6. Reuse thread identity through `prompt_cache_key`.
7. Optionally send only incremental `input` additions when transport state allows it.

## Comparison With `opencode`

Current `opencode` behavior differs in several important ways:

- It uses the AI SDK OpenAI-compatible Responses client rather than Codex's native transport stack.
- It can send `instructions`, but the main system contract is still assembled in `packages/opencode/src/session/llm.ts` and partially injected as system/developer messages.
- It exposes more generic provider options such as `metadata`, `previous_response_id`, `user`, `safety_identifier`, and `top_logprobs`.
- It does not currently mirror official session transport metadata such as `conversation_id`, `session_source`, or `x-codex-turn-state`.
- Its user agent and header stack are those of `ai-sdk/openai-compatible`, not the official Codex client stack.

Relevant local files:

- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/provider/sdk/copilot/copilot-provider.ts`
- `packages/opencode/src/provider/sdk/copilot/responses/openai-responses-language-model.ts`
- `packages/opencode/src/provider/sdk/copilot/responses/convert-to-openai-responses-input.ts`

## Whitepaper Conclusions

- The official Codex client is defined by both body shape and transport behavior.
- The most important body-level invariant is top-level `instructions` plus `ResponseItem[] input`.
- The most important transport-level invariant is thread/session continuity metadata.
- `opencode` can align more closely for compatibility without pretending to be the official client.
- Any third-party compatibility effort should preserve truthful client identity even when request semantics are aligned.

## Internal or Non-Public Surfaces

The following fields and channels are visible in the vendored source, but should not be treated as stable public protocol standards.

They are listed here specifically to help `opencode` avoid accidental misuse.

### A. `x-codex-turn-state`

Observed behavior:

- Used as a sticky-routing token during a turn.
- Replayed across requests within the same turn.

Why it is non-public:

- The token format is not documented as a public standard.
- The generation, rotation, validation, and expiration semantics are not described for third parties.

Implementation guidance:

- Do not attempt to synthesize or imitate this header.
- Do not make `opencode` depend on its presence.
- If `opencode` needs an equivalent mechanism, define an `x-opencode-*` namespace instead.

Primary reference:

- `refs/codex/codex-rs/core/src/client.rs`

### B. `x-codex-turn-metadata`

Observed behavior:

- Optional per-turn metadata header.
- Can also be mapped into websocket `client_metadata`.

Why it is non-public:

- The payload schema is not described as a stable public contract.
- Field meanings appear tied to official observability and runtime plumbing.

Implementation guidance:

- Do not copy the header name or assume schema compatibility.
- Treat the official behavior as informative only.
- Use a separate `opencode` metadata schema if turn-level metadata is required.

Primary reference:

- `refs/codex/codex-rs/core/src/client.rs`

### C. `x-codex-beta-features`

Observed behavior:

- Header carries comma-separated beta feature keys.

Why it is non-public:

- Feature key vocabulary, rollout semantics, and compatibility guarantees are not publicly specified.
- Values are likely coupled to official feature gates.

Implementation guidance:

- Do not emit the official header from `opencode`.
- Do not infer that observed feature key names are safe for third-party use.
- Keep compatibility flags in `opencode` config or `x-opencode-*` headers.

Primary reference:

- `refs/codex/codex-rs/core/src/client.rs`

### D. `conversation_id`

Observed behavior:

- Passed as transport/session metadata.
- Also reused as the source for `prompt_cache_key`.

Why it is not fully public:

- The existence of a thread identifier is observable, but the official lifecycle semantics are not fully documented as an external contract.
- The relationship between thread identity, routing, cache reuse, and server-side storage is implementation-specific.

Implementation guidance:

- It is reasonable for `opencode` to maintain its own stable thread identity.
- It is not reasonable to claim official Codex thread identity semantics.
- Reuse the concept, not the official provenance.

Primary references:

- `refs/codex/codex-rs/core/src/client.rs`
- `refs/codex/codex-rs/core/src/thread_manager.rs`

### E. `session_source`

Observed behavior:

- Transport metadata indicates whether the session is CLI, subagent, review, or another internal origin.

Why it is not fully public:

- The enum values and semantics are part of the official runtime model.
- The meaning is tied to Codex's own orchestration system.

Implementation guidance:

- `opencode` can model its own session roles.
- It should not claim official Codex session-source values or origins.
- Any mapping should be internal and clearly third-party.

Primary references:

- `refs/codex/codex-rs/core/src/client.rs`
- `refs/codex/codex-rs/core/src/tools/spec.rs`

### F. Incremental resend and websocket reuse rules

Observed behavior:

- The official client computes deltas against the last request.
- It may reuse websocket session state and only send incremental `input` extensions.

Why it is not fully public:

- The exact server expectations for safe reuse are not defined as a public compatibility contract.
- Equality checks and replay boundaries are internal client logic.

Implementation guidance:

- `opencode` should not assume that matching JSON shape alone reproduces official continuation behavior.
- If incremental transport is implemented, it should be treated as an independent `opencode` feature with its own invariants.

Primary reference:

- `refs/codex/codex-rs/core/src/client.rs`

### G. Shell output normalization rules

Observed behavior:

- The official client rewrites certain shell outputs into structured text before resending them to the model, especially around freeform patch flows.

Why it is not fully public:

- This is an implementation behavior, not an explicitly published wire standard.
- The exact formatting is coupled to tool orchestration choices.

Implementation guidance:

- `opencode` may adopt a similar strategy for model quality.
- It should treat this as a local compatibility heuristic, not a guaranteed official protocol requirement.

Primary reference:

- `refs/codex/codex-rs/core/src/client_common.rs`

### H. Official user-agent tokenization

Observed behavior:

- The official stack has dedicated user-agent token sanitation and terminal metadata handling.

Why it is non-public for compatibility purposes:

- Even when partly visible in source, user-agent composition is identity-bearing metadata.
- Copying it would blur the distinction between compatibility and impersonation.

Implementation guidance:

- `opencode` should use a truthful user-agent string.
- Compatibility claims should be additive and explicit, for example `opencode/... codex-compatible/...`, not substitutive.

Primary reference:

- `refs/codex/codex-rs/core/src/terminal.rs`

## Safe Interpretation Rule

For `opencode`, use the following rule when implementing against observed Codex behavior:

- Treat request body fields that mirror OpenAI Responses API concepts as potentially alignable.
- Treat official `x-codex-*` headers, official identity metadata, routing tokens, and beta feature channels as non-public surfaces.
- When in doubt, reimplement the capability under an `opencode` namespace rather than copying the official field.

## Anti-Footgun Checklist

- Do not send official `x-codex-*` headers from `opencode`.
- Do not copy the official user-agent format.
- Do not assume `conversation_id` and `session_source` are public compatibility requirements.
- Do not rely on observed beta feature keys.
- Do not assume incremental websocket behavior can be reproduced by matching body shape alone.
- Do not treat client-side shell normalization details as mandatory wire protocol.
