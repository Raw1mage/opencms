# Spec

## Purpose

Deliver a chapter-structured, IDEF0-decomposed, code-anchored reverse-engineering reference of upstream codex-cli's wire-affecting runtime. Each chapter must independently pass an audit before promotion.

## Requirements

### Requirement: Chapter Structure Covers All Wire-Affecting Subsystems
The spec SHALL contain chapters covering: (1) entry points & bootstrap, (2) auth & identity, (3) session & turn lifecycle, (4) context fragment assembly, (5) tools & MCP, (6) Responses API request build, (7) HTTP SSE transport, (8) WebSocket transport, (9) compact sub-endpoint, (10) subagents (review/compact/memory-consolidation/thread-spawn), (11) cache & prefix model, (12) rollout & telemetry. Chapters may merge or split during drafting, but the union of chapters MUST cover all listed subsystems.

#### Scenario: Subsystem coverage complete at graduation
- **GIVEN** the spec reaches state=verified
- **WHEN** the chapter list is enumerated
- **THEN** every wire-affecting subsystem listed above has at least one chapter or sub-chapter covering it
- **AND** no chapter covers an out-of-scope subsystem from the proposal's OUT list

### Requirement: Every Chapter Carries IDEF0 ICOM Decomposition
Each chapter SHALL include an `idef0.<chapter-slug>.json` artifact decomposing its subsystem into A_N activities, each with Inputs / Controls / Outputs / Mechanisms.

#### Scenario: Chapter without IDEF0 fails design gate
- **GIVEN** a draft chapter has prose body only
- **WHEN** `plan_advance` to designed is attempted for that chapter
- **THEN** validation fails with "missing idef0.<chapter-slug>.json"

### Requirement: Every Chapter Carries A Subsystem Architecture Diagram
Each chapter SHALL include an **architecture block diagram OR stack diagram** showing the original upstream module decomposition for the subsystem (which crates, which modules, how they layer). Format: mermaid (preferred — auto-renders) or ascii art (acceptable). One diagram per chapter at minimum; sub-diagrams allowed where helpful.

#### Scenario: Architecture diagram present in chapter
- **GIVEN** chapter N is reviewed
- **WHEN** chapter body is scanned
- **THEN** it contains a `## Module architecture` section with at least one block/stack diagram
- **AND** the diagram labels every cited upstream crate / module by its actual path (e.g. `codex-rs/core/src/client.rs::ModelClientSession`)

### Requirement: GRAFCET Workflow For Every Subfunction
Each chapter's IDEF0 sub-activities SHALL be paired with a GRAFCET workflow describing their runtime evolution. May be one GRAFCET per chapter covering all subfunctions, or one per major subfunction when complex enough to warrant separation.

#### Scenario: GRAFCET present and steps named to IDEF0 A_N
- **GIVEN** chapter N has IDEF0 activities A_N.1, A_N.2, ...
- **WHEN** chapter's grafcet.<chapter-slug>.json is read
- **THEN** every step `ModuleRef` field references an A_N.M id defined in the chapter's idef0
- **AND** transitions between steps describe concrete runtime events / conditions

### Requirement: Controls And Mechanisms Visualised
For every IDEF0 activity in a chapter, the Controls (`config / env / contract / invariants`) and Mechanisms (`code modules / data structures / external services`) SHALL be visualised — either as columns in the IDEF0 diagram (default) or as a separate block diagram when the relationships are non-trivial.

#### Scenario: Mechanism diagram appears when activity has ≥3 mechanisms
- **GIVEN** an IDEF0 activity lists 3 or more mechanisms
- **WHEN** chapter is reviewed
- **THEN** either the IDEF0 SVG renders them clearly OR a separate mechanism block diagram exists alongside

### Requirement: Datasheet For Every Handshake / Protocol Message
Each chapter that touches wire-level handshake or messages (HTTP request/response, WebSocket frames, SSE events, OAuth flows, file formats persisted by the subsystem) SHALL include a **protocol datasheet section**. Each datasheet entry MUST specify, per packet/message type:
- name + direction (client→server / server→client / bidirectional)
- transport (HTTP path+method / WS frame opcode / SSE event name / file-on-disk path)
- per-field table with columns: `Field`, `Type / Encoding`, `Required`, `Source (file:line)`, `Stable / Per-turn`, `Notes`
- example payload (sanitized — no real tokens or PII)

#### Scenario: Wire-touching chapter without datasheet fails audit
- **GIVEN** a chapter on a wire-touching subsystem (transports, request build, compact, subagents)
- **WHEN** audit reviews the chapter
- **THEN** at least one protocol datasheet exists per distinct message type
- **AND** every field row has a non-empty `Source (file:line)`

#### Scenario: Non-wire-touching chapter may omit datasheet
- **GIVEN** a chapter on a purely-internal subsystem (e.g. session state machine that does not emit wire bytes)
- **WHEN** audit reviews
- **THEN** datasheet section may be replaced with a `## Protocol datasheet` heading noting "N/A — this subsystem produces no wire-level messages directly; see chapter N for downstream wire emission"

### Requirement: Every Factual Claim Has A Code Anchor
The spec SHALL pin every behavioural claim to a `spec_add_code_anchor` entry referencing `refs/codex/codex-rs/...:N`. Claims without anchors are inadmissible.

#### Scenario: Audit lists every claim with its anchor
- **GIVEN** chapter N is audited
- **WHEN** the audit event is recorded
- **THEN** the event body lists every claim Cn with its anchor file:line:symbol
- **AND** the anchor count equals the claim count

### Requirement: Audit Pass Required Before Chapter Marked Complete
The spec SHALL require an audit pass for every chapter, recorded via `spec_record_event` with audit-checklist evidence, before the chapter is considered complete.

#### Scenario: Failed audit returns chapter to draft
- **GIVEN** audit finds a claim with no supporting anchor content
- **WHEN** audit-pass event is recorded
- **THEN** the event marks the chapter as "audit-failed"
- **AND** the chapter is not cited by any other spec until re-audit passes

### Requirement: OpenCode Delta Map Per Chapter
Each chapter SHALL end with a "## OpenCode delta map" section describing what OpenCode currently does for the same subsystem, aligned points, drift points, and links to controlling local specs.

#### Scenario: Delta map cites local spec
- **GIVEN** chapter on "context fragment assembly"
- **WHEN** delta map section is read
- **THEN** it links to `provider_codex-prompt-realign/` and `provider_codex-installation-id/` and notes alignment / drift status

### Requirement: Drift Guard Active Across Submodule Bumps
The spec SHALL be subject to `wiki_validate drift_code_anchors` so submodule bumps surface anchor breakage as warnings.

#### Scenario: Submodule SHA changes → audit warning
- **GIVEN** `refs/codex` HEAD advances and a previously-cited line shifts
- **WHEN** `wiki_validate` runs
- **THEN** the moved anchor is flagged in `drift_code_anchors`
- **AND** the affected chapter is marked "drift-suspect" pending re-audit

## Acceptance Checks

- [ ] Chapter list covers all 12 wire-affecting subsystems from Requirement 1.
- [ ] Each chapter has an `idef0.<chapter-slug>.json` with at least one A0-level activity decomposed.
- [ ] Each chapter has an `## Module architecture` section with a block / stack diagram (mermaid or ascii).
- [ ] Each chapter has a `grafcet.<chapter-slug>.json` whose steps reference A_N.M ids defined in the chapter's idef0.
- [ ] Each chapter visualises Controls and Mechanisms (in the IDEF0 diagram OR a separate block diagram when ≥3 mechanisms exist).
- [ ] Each wire-touching chapter has at least one `## Protocol datasheet` entry with the required field columns (Field, Type/Encoding, Required, Source file:line, Stable/Per-turn, Notes) and a sanitized example payload.
- [ ] Non-wire-touching chapters that omit datasheet explicitly explain why and point to the downstream chapter that emits the bytes.
- [ ] Total code anchors ≥ 50 (rough floor for a thorough reverse-engineering job).
- [ ] At least one code anchor per chapter targets a TEST or TYPE definition (not only a comment).
- [ ] Every chapter has an audit-pass event recording: claim count, anchor count, submodule SHA, open-questions count.
- [ ] Every chapter has a "## OpenCode delta map" section.
- [ ] `wiki_validate` reports zero `broken_links` and zero unresolved `drift_code_anchors` at graduation time.
- [ ] No chapter cites another not-yet-audited chapter (forward-reference discipline).
- [ ] `provider_codex-bundle-slow-first-refinement/` is documented as a downstream consumer of the "context fragment assembly" chapter once that chapter graduates.
