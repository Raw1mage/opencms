# Spec: Claude Code CLI 2.1.144 Reversed Engineering

## Purpose

Document the wire protocol of `@anthropic-ai/claude-code@2.1.144` via static analysis of the minified bundle, producing a single source of truth for OpenCMS provider-claude alignment. This is a documentation-only spec — no code changes are delivered.

## Requirements

### Requirement: R1 — Protocol Datasheet Completeness

The protocol datasheet must cover all 12 sections (§1–§12) of the wire protocol: core constants, authentication, request headers, beta flags, retry/rate-limit handling, request body, SSE transport, tool system, cache control, context management, model routing, and the delta from 2.1.126.

#### Scenario: Verify header coverage

Given the datasheet is complete,
when compared against a live Claude Code 2.1.144 request capture,
then every header present in the capture is documented in §3.

#### Scenario: Verify beta flag count

Given the datasheet §4,
when the U31 array is enumerated,
then exactly 24 active flags are listed with their internal names and header values.

### Requirement: R2 — Retry Architecture Documentation

The two-layer retry architecture (SDK layer + app layer) must be fully documented including all constants, backoff formulas, decision flow, and watchdog mode behavior.

#### Scenario: SDK layer constants

Given the datasheet §5.2,
then maxRetries=2, timeout=600000, backoff base=0.5s, cap=8s are documented.

#### Scenario: App layer constants

Given the datasheet §5.3,
then DEFAULT_MAX_RETRIES=10, BACKOFF_BASE_MS=500, MAX_RETRY_DELAY_NON_WATCHDOG=60000 are documented.

#### Scenario: Watchdog mode

Given the datasheet §5.4 step 6,
then watchdog mode is documented as unlimited retries with 5min backoff cap and 30s yield interval.

### Requirement: R3 — Delta Tracking from 2.1.126

All behavioral changes between 2.1.126 and 2.1.144 must be enumerated.

#### Scenario: Major changes enumerated

Given the datasheet §12,
then at least 10 major changes are listed including beta flag expansion, new headers, and OAuth scope changes.

#### Scenario: Unchanged items confirmed

Given the datasheet §12,
then unchanged items (API version, client ID, core retry constants) are explicitly listed.

## Acceptance Checks

- [ ] `chapters/protocol-datasheets.md` contains §1–§12 with no empty sections
- [ ] All retry constants in §5 match values extracted from cli.js source
- [ ] Beta flag table in §4 lists 24 active entries
- [ ] Delta section §12 lists ≥10 major changes and explicitly states unchanged items
- [ ] IDEF0 diagram models the retry pipeline as decomposed activities
- [ ] GRAFCET diagram models the retry state machine with correct step transitions
- [ ] Sequence diagram shows 429 handling through both retry layers
