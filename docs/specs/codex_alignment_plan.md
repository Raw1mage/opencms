# Codex Alignment Plan

## Goal

Align `opencode` with the observable Codex CLI protocol where doing so improves compatibility, predictability, and model behavior, while preserving an honest third-party identity.

This is not an impersonation plan. It is a compatibility plan.

## Non-Goals

- Do not masquerade as the official Codex CLI client.
- Do not copy official identity-bearing headers or user-agent values in a misleading way.
- Do not reproduce server-trust signals that are only valid for the official client stack.

## Source Basis

Alignment targets in this plan are derived from:

- `docs/specs/codex_protocol_whitepaper.md`
- `refs/codex/codex-rs/core/src/client.rs`
- `refs/codex/codex-rs/codex-api/src/common.rs`
- `refs/codex/codex-rs/core/src/client_common.rs`

## Alignment Summary

`opencode` should align in three categories:

1. request body semantics
2. input item semantics
3. session continuity semantics

It should deliberately remain distinct in:

1. client identity
2. vendor-specific headers
3. trust and observability metadata that imply official provenance

## Work Items

### A. Instruction Contract Alignment

Status: not aligned

Current state:

- `packages/opencode/src/session/llm.ts` builds a large composite system array.
- For OpenAI instruction-capable models, only `SystemPrompt.instructions()` is sent via top-level `instructions`.
- Additional behavioral content remains in system/developer messages.

Target state:

- Construct a single Codex-style top-level instruction contract for OpenAI Responses models.
- Move stable agent identity, collaboration rules, safety rules, and formatting rules into `instructions`.
- Keep `input` focused on conversation history and tool history.

Recommended tasks:

- introduce a dedicated OpenAI/Codex instruction builder
- separate stable instructions from turn-local reminders
- minimize use of synthetic system/developer input items for content that belongs in `instructions`

Relevant files:

- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/session/system.ts`

### B. Request Body Normalization

Status: partially aligned

Current state:

- `opencode` already sends `model`, `input`, `tools`, optional `instructions`, and optional reasoning/text controls.
- Some fields are optional or generic where Codex uses stronger conventions.

Target state:

- standardize OpenAI/Codex mode request body defaults:
  - `tool_choice: "auto"`
  - explicit `parallel_tool_calls`
  - explicit `prompt_cache_key` tied to thread identity
  - consistent `store` policy
  - explicit reasoning controls when supported

Recommended tasks:

- define a Codex-aligned provider option profile for OpenAI Responses
- ensure `prompt_cache_key` is always derived from session/thread identity in this mode
- make `store` handling internally consistent between input conversion and body emission
- avoid emitting extra generic fields unless they are intentionally used

Relevant files:

- `packages/opencode/src/provider/sdk/copilot/responses/openai-responses-language-model.ts`
- `packages/opencode/src/provider/sdk/copilot/responses/openai-responses-api-types.ts`

### C. Input Item Semantics

Status: partially aligned

Current state:

- `opencode` already converts model messages into Responses `input` items.
- It supports `developer` system message mode for reasoning-capable OpenAI models.
- Tool items and reasoning items are reasonably close to official shape.

Target state:

- keep `input` as a clean stream of conversation items and tool lifecycle items
- reduce instruction leakage into `input`
- audit tool and shell output normalization against official Codex behavior

Recommended tasks:

- compare shell/tool output normalization with Codex `client_common.rs`
- add a normalization pass for shell outputs when equivalent tools are active
- preserve OpenAI item references and reasoning item reuse where available

Relevant files:

- `packages/opencode/src/provider/sdk/copilot/responses/convert-to-openai-responses-input.ts`

### D. Session Continuity Alignment

Status: weakly aligned

Current state:

- `opencode` can pass `previous_response_id` and `prompt_cache_key`, but they are generic provider options rather than a core session behavior.

Target state:

- tie OpenAI/Codex mode to stable thread identity
- consistently reuse `prompt_cache_key`
- decide whether to support incremental resend logic at the application layer

Recommended tasks:

- add a session-scoped OpenAI thread identity abstraction
- derive `prompt_cache_key` automatically
- decide whether `previous_response_id` should be user-visible plumbing or an internal session detail

Relevant files:

- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/session/index.ts`
- `packages/opencode/src/provider/sdk/copilot/responses/openai-responses-language-model.ts`

### E. Tool Contract Alignment

Status: partially aligned

Current state:

- `opencode` exposes OpenAI Responses tools through the AI SDK layer.
- Tool payloads are broadly compatible.

Target state:

- ensure tool descriptors and tool result serialization match official Codex expectations where feasible
- keep local shell and patch flows stable and explicit

Recommended tasks:

- audit tool descriptor serialization against official tool spec categories
- verify `local_shell` request/result shape against the Codex source model
- standardize structured output and patch-related formatting where model behavior depends on it

Relevant files:

- `packages/opencode/src/provider/sdk/copilot/responses/openai-responses-language-model.ts`
- `packages/opencode/src/session/prompt.ts`

## Places That Must Intentionally Differ

These differences are required to preserve honest identity and avoid implying official provenance.

### 1. User-Agent

`opencode` should not reuse the official Codex CLI user-agent or token format.

It should instead send a truthful identifier such as:

- `opencode/<version>`
- optional compatibility token like `codex-compatible/<mode-version>`

It may describe itself as compatible. It must not identify itself as the official Codex CLI.

Relevant file:

- `packages/opencode/src/provider/sdk/copilot/copilot-provider.ts`

### 2. Official `x-codex-*` Headers

`opencode` should not emit official-looking headers such as:

- `x-codex-beta-features`
- `x-codex-turn-state`
- `x-codex-turn-metadata`

unless there is a legitimate, documented interoperability reason and the values are generated by `opencode` for `opencode`, not to mimic official provenance.

Recommended alternative:

- `x-opencode-session-id`
- `x-opencode-turn-state`
- `x-opencode-compat-mode`

### 3. Session Source Identity

The official client sends `session_source` as part of its own runtime model. `opencode` should not claim to be `Codex CLI` or an official subagent origin.

Recommended alternative:

- maintain internal session source semantics for `opencode`
- if mapping to OpenAI transport options is useful, use values that truthfully represent `opencode` roles

### 4. Beta Feature Signaling

Do not copy official beta feature names or beta feature headers unless they are actually part of a published compatibility surface.

Recommended alternative:

- keep `opencode` feature flags internal
- expose compatibility knobs through `opencode` config, not official feature names

### 5. Trust-Bearing Metadata

Any metadata that might cause backend operators or logs to interpret traffic as official Codex traffic must remain distinct.

This includes:

- official naming conventions
- official client metadata envelope formats
- any observability fields whose meaning depends on official infrastructure

## Suggested Execution Order

1. instruction contract refactor
2. request body default normalization
3. prompt cache and thread identity wiring
4. tool and shell output normalization audit
5. explicit honest-identity header and user-agent policy

## Acceptance Criteria

The alignment work is successful when:

- OpenAI Responses requests from `opencode` use a stable Codex-like top-level instruction contract
- request bodies are structurally closer to the official client
- session continuity is explicit and deterministic
- tool payloads are normalized for Codex-like model behavior
- transport identity remains clearly and verifiably third-party

## Proposed Policy Sentence

When `opencode` runs in Codex compatibility mode, it should align request semantics with the official Codex CLI where possible, but it must always identify itself as `opencode` and must not transmit metadata that falsely suggests official Codex provenance.

## Implementation Triage

This section translates the plan into execution policy.

### Must Do

- move the primary OpenAI/Codex behavioral contract into top-level `instructions`
- keep `input` focused on conversation items, tool calls, tool outputs, and reasoning items
- derive a stable `prompt_cache_key` from `opencode` session or thread identity
- make `store` behavior internally consistent between input conversion and final body emission
- standardize OpenAI/Codex mode defaults for `tool_choice`, `parallel_tool_calls`, reasoning, and text controls
- use a truthful `User-Agent` that identifies `opencode`
- document all compatibility-specific transport fields and their ownership

### Should Do

- add a dedicated OpenAI/Codex compatibility request builder instead of relying on scattered provider options
- audit shell output normalization against the official Codex client and adopt compatible formatting where beneficial
- make `previous_response_id` and thread continuity a first-class session concern instead of ad hoc provider plumbing
- add regression fixtures that snapshot the generated OpenAI Responses body for Codex compatibility mode
- separate stable instruction text from turn-local reminders and temporary orchestration hints

### Could Do

- add an `opencode` compatibility metadata header namespace such as `x-opencode-compat-mode`
- add a body diff tool or debug endpoint that compares generated `opencode` requests with source-derived Codex expectations
- add a compatibility report in CI that flags drift in request shape after provider-layer changes
- add optional shell/tool normalization profiles tuned for different model families

### Must Not Do

- do not emit official `x-codex-*` headers
- do not reuse the official Codex CLI user-agent string or token format
- do not claim official `session_source` values or official subagent provenance
- do not copy beta feature keys from official traffic or source as if they were public standards
- do not depend on opaque routing tokens or undocumented server behavior
- do not represent `opencode` traffic as official Codex traffic in logs, headers, body metadata, or telemetry

## Review Gate

Any future compatibility change should be rejected at review time if it does any of the following:

- makes `opencode` identity less explicit
- introduces an official-looking `x-codex-*` header
- relies on an undocumented opaque token from the official client
- couples `opencode` behavior to unofficial beta feature names
- mixes stable instruction contract content back into transient `input` items without a clear reason

## Suggested Milestones

### Milestone 1: Body Alignment

- create a dedicated Codex-compatible instruction builder
- normalize OpenAI Responses body defaults
- add request snapshot tests

### Milestone 2: Session Alignment

- define `opencode` thread identity and `prompt_cache_key` policy
- make continuation behavior explicit and deterministic

### Milestone 3: Honest Differentiation

- standardize truthful `User-Agent`
- define `x-opencode-*` metadata namespace if needed
- add lint or tests preventing official header reuse
