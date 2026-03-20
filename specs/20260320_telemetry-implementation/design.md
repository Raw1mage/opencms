# Design: Telemetry planning for A111/A112 instrumentation

## Context

- Prompt assembly lifecycle lives in `packages/opencode/src/session/llm.ts` (systemParts construction, policy injection) and is coupled with session control tracked in `processor.ts`, `compaction.ts`, `prompt.ts`, `session/telemetry.ts` (primary instrumentation sink), and monitored downstream by `session/monitor.ts` (UI projection).
- Previous planning (see `specs/20260320_llm`) highlighted the need for measurement before compaction/optimization decisions, motivating dedicated telemetry slices A111/A112.

## Goals / Non-Goals

**Goals:**

- Document concrete instrumentation requirements for A111 prompt blocks and A112 round/session usage.
- Ensure the telemetry plan ties each metric/data field to a file boundary, validation gate, and failure-handling expectation (fail fast, no mutation).
  **Non-Goals:**
- Coding runtime telemetry logic or altering existing prompt/round behaviors.
- Extending planning to Slice A/C sibling tracks beyond telemetry instrumentation.

## Phased Delivery Guardrails

- **P0 (Data Contract & Baseline Planning):** Finalize telemetry field definitions, ownership, and validation expectations so the telemetry sink and monitor projection know what to expect before any data is emitted. Keep UI locked out until P1 completes.
- **P1 (Instrumentation & Projection Readiness):** Define how prompt blocks (A111) and rounds/sessions (A112) emit telemetry to `session/telemetry.ts` and how `session/monitor.ts` projects that data into `sync.data.session_status[sessionID].telemetry` or a dedicated slice. Instrumentation is verified via log inspections/fail-fast guarantees while UI remains passive.
- **P2 (Sidebar/Context Consumption):** Once P1 is stable, map the sidebar and context cards (runner/health reuse, prompt telemetry, round/session summaries, account/quota reuse) to the projected telemetry fields, ensuring cards treat the data as read-only and only render after the backend data layer is proven.

## Decisions

- Introduce `packages/opencode/src/session/telemetry.ts` as the typed telemetry surface; it receives immutable metadata, validates schema, logs failures, and never alters prompt assembly.
- Instrumentation occurs post prompt assembly and post finish-step/compaction decisions, writing telemetry asynchronously so it does not block or mutate the runtime flow.

## Data / State / Control Flow

- Prompt block instrumentation captures:
  - `blockId` / `sourceFile` / `blockKind`
  - `injected` flag vs `skippedReason`
  - `charLength`, `estimatedTokens`, `correlationId`
  - `injectPolicy`, `builderTag`
- Round/session usage instrumentation captures:
  - `sessionId`, `roundIndex`, `requestId`
  - `modelId`, `providerKey`, `accountId`
  - `promptTokens`, `inputTokens`, `responseTokens`, `compactionDraftTokens`
  - `compactionTriggered`, `compactionResult`, `sessionDurationMs`, `cumulativeTokens`
- Data flow: `llm.ts`/`prompt.ts` assemble blocks, emit telemetry via `telemetry.reportPromptBlock(...)`; `processor.ts`/`compaction.ts` call `telemetry.reportRoundUsage(...)` on round end or compaction decision.
- Ownership: `session/telemetry.ts` is the authoritative sink that validates the immutable payloads above, `session/monitor.ts` merely projects those metrics for downstream UI/observability, and `account/monitor.ts` continues as the aggregate/quota monitor that A112 may read without redefining the telemetry contract.

## Sidebar Consumption & Card Taxonomy

- Runner/health overview (existing status card built by `monitor-helper.ts` and rendered via `SessionStatusSections` in `session-side-panel.tsx`) continues to use `session/monitor.ts` projections so it stays read-only. Reuse this card for telemetry-driven health summaries and callouts from A111/A112 when appropriate.
- Prompt telemetry card(s) will surface block-level metadata (source/name, inject policy, tokens, skipped reasons, correlation IDs) derived from the A111 payloads. Place these cards inside the status sidebar so they remain near the runner/health overview, but allow a condensed context tab variant that threads important prompts into the conversation context if space or workflow dictates.
- Round/session telemetry card(s) will summarize A112 data (sessionId, roundIndex, requestId, provider/account, prompt/input/response/compaction tokens, compaction outcomes, cumulative session stats). Keep them inside the status cards or context tab close to round details so they are discoverable before fallback/migration actions. They must never mutate session execution – they simply read the `session/monitor.ts` projection and `sync.data.session_status` entry for display.
- Account/quota reuse card will reference `account/monitor.ts` aggregates (existing quota view) when telemetry needs to highlight quota limits or aggregate health alongside A112 summaries. This card can live in the context tab if account-level detail benefits from longer descriptions, or stay in the status card list if quota pressure needs immediate visibility.

## UI Consumption Contract

- Data pipeline: `session/telemetry.ts` validates and emits prompt/round telemetry -> `session/monitor.ts` aggregates/filters into UI-friendly snapshots -> sync layer exposes telemetry via `sync.data.session_status`, `sync.data.session_telemetry` (new slice), or leverage existing slices (`llm_history`, `session_status`). The plan must define the exact keys `SessionStatusSections` and `SessionSidePanel` will read to render cards without duplication of logic or data ownership.
- Cards must treat telemetry fields as read-only: they only read the slices populated by `session/monitor.ts` (e.g., telemetry-specific entries under `sync.data.session_status[sessionID].telemetry` or a new top-level `sync.data.session_telemetry[sessionID]`), never write or infer them. This keeps the sidebar as a pure consumer and avoids drift from the telemetry source-of-truth.
- Provide mapping examples (e.g., Prompt telemetry card uses `sessionStatus.telemetry.promptBlocks.last` for block names and tokens; Round telemetry section uses `sessionStatus.telemetry.rounds.current` for compaction metrics) so UI implementers know field names and expected shapes.

## Placement Rationale

- Status sidebar is the primary delivery surface for prompt/round telemetry because it already hosts runtime-sensitive cards (runner, monitor, todos). Prompt telemetry cards stay near the runner summary to highlight injection policies without opening context panels.
- The context tab offers more real estate for longitudinal telemetry (full block logs, session history, account quotas), so new cards can mirror the status cards inside the context tab when deeper exploration is needed, maintaining consistency using the same data contract.
- Hybrid placements (card previews in status sidebar with expanded views in the context tab) are encouraged when telemetry data is rich; ensure the UI still reads from the same `session/monitor.ts` output regardless of location.

## Risks / Trade-offs

- Telemetry module failure could surface during prompt assembly -> fail fast to avoid silent schema drift; ensure telemetry errors do not mutate prompt or round flows.
- Detailed instrumentation increases plan complexity; mitigate with traceability matrices and diagrams (IDEF0/GRAFCET) to keep builders oriented.

## Critical Files

- `/home/pkcs12/projects/opencode/packages/opencode/src/session/llm.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/processor.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/compaction.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/telemetry.ts` (primary telemetry sink for A111/A112 instrumentation)
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/monitor.ts` (downstream UI projection/consumer of the telemetry sink)
- `/home/pkcs12/projects/opencode/packages/opencode/src/account/monitor.ts` (aggregate/quota monitor that A112 may read without redefining the telemetry contract)

## Supporting Docs (Optional)

- `specs/20260320_llm/implementation-spec.md` (context on telemetry/optimization sequencing)
- Event ledger entry: `docs/events/event_20260320_telemetry_plan.md` once instrumentation plan is finalized.
