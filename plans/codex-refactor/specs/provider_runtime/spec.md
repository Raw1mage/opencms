# Spec

## Purpose

定義 codex provider 在 opencode 中的正式 runtime contract：哪些能力已 merge 為既有行為、哪些邊界必須維持、後續若再擴充應沿用哪些架構約束。

## Requirements

### Requirement: AI SDK Path Is The Authority

The system SHALL treat the AI SDK Responses path as the authoritative codex provider data path.

#### Scenario: Request construction
- **GIVEN** codex provider issues an LLM request
- **WHEN** the request is prepared
- **THEN** request body construction flows through AI SDK Responses adapter semantics, with codex-specific augmentation limited to supported providerOptions and fetch-interceptor transport/body adjustments

#### Scenario: No parallel custom loader truth
- **GIVEN** codex provider behavior is changed in future
- **WHEN** the implementation needs request/stream changes
- **THEN** the change must extend the AI SDK path rather than reintroducing a second authoritative CUSTOM_LOADER path

### Requirement: Prompt Cache Continuity

The system SHALL preserve stable request continuity for codex sessions through cache identity and turn continuity signals.

#### Scenario: Stable prompt cache key
- **GIVEN** two requests in the same codex session
- **WHEN** the second request is sent
- **THEN** request continuity keeps a stable prompt cache identity for cache reuse purposes

#### Scenario: Turn-state replay within a turn
- **GIVEN** codex turn-scoped routing state was captured from a prior response in the same turn
- **WHEN** a follow-up request is issued in that same turn
- **THEN** the request reuses the captured turn-scoped continuity metadata

### Requirement: Encrypted Reasoning Reuse Path

The system SHALL preserve the reasoning reuse path compatible with Responses API encrypted reasoning semantics.

#### Scenario: Store-disabled reasoning reuse path
- **GIVEN** codex provider uses the reasoning-capable Responses path
- **WHEN** provider options are constructed
- **THEN** the request keeps the configuration required for encrypted reasoning reuse rather than silently degrading to a plain non-reuse path

#### Scenario: History replay boundary
- **GIVEN** a previous turn produced reusable reasoning state
- **WHEN** later turns are built from preserved session history
- **THEN** the continuity path must not discard the reasoning reuse signal without explicit rationale

### Requirement: Compression And Transport Efficiency

The system SHALL preserve the merged request-efficiency work for codex transport.

#### Scenario: Compression path
- **GIVEN** codex provider sends a sufficiently large request through the supported auth/runtime mode
- **WHEN** compression is available
- **THEN** the request uses the supported compression path with an observable fallback strategy

#### Scenario: Transport extension boundary
- **GIVEN** future work extends transport behavior (for example WebSocket or incremental delta)
- **WHEN** that work is implemented or revised
- **THEN** it must be added as a transport adapter beneath the AI SDK request/stream contract, not as a replacement orchestration stack

### Requirement: Compaction And Context Management Extension Boundary

The system SHALL treat server compaction / inline context management as codex-specific extension surfaces, not as reasons to fork the main orchestration path.

#### Scenario: Inline context management
- **GIVEN** codex request shaping needs server-managed context behavior
- **WHEN** the request body is transformed
- **THEN** codex-specific body augmentation occurs in the fetch-interceptor extension layer with explicit, observable behavior

#### Scenario: Server compaction fallback discipline
- **GIVEN** server-side compaction is unavailable or unsupported
- **WHEN** a compaction attempt fails
- **THEN** the system degrades through the existing explicit fallback path rather than silently pretending compaction succeeded

### Requirement: Runtime Cleanup Stays In Force

The system SHALL preserve the cleanup intent from the merged refactor.

#### Scenario: No unsafe casts reintroduced casually
- **GIVEN** future codex runtime modifications
- **WHEN** implementation reaches language-model/provider integration seams
- **THEN** ad-hoc `as any` restoration or shadow APIs must not be reintroduced without a documented decision

#### Scenario: Per-session state isolation
- **GIVEN** multiple codex sessions run concurrently
- **WHEN** runtime continuity state is tracked
- **THEN** turn/session-scoped state must remain isolated rather than shared through unsafe module-global mutable state

## Canonical References

- `specs/codex/provider_runtime/design.md`
- `specs/codex/provider_runtime/handoff.md`
- `specs/codex/protocol/whitepaper.md`
- Historical execution packages:
  - `plans/codex-efficiency/`
  - `plans/aisdk-refactor/`
