# Handoff

## Scope

Implement toast scope and TTL enforcement across backend toast publishing and frontend display.

## Execution Contract

- Implement only the scoped toast + TTL behavior described in this plan.
- Use existing Bus/SSE infrastructure; do not add polling, replay buffers, or fallback routing.
- Keep frontend state recovery on existing reducer/resync paths.

## Required Reads

- `specs/architecture.md`
- `plans/webapp_toast-sse-ttl/spec.md`
- `plans/webapp_toast-sse-ttl/design.md`
- `plans/webapp_toast-sse-ttl/tasks.md`

## Critical Files

- `packages/opencode/src/cli/cmd/tui/event.ts`
- `packages/opencode/src/server/routes/global.ts`
- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/mcp/index.ts`
- `packages/app/src/context/global-sync.tsx`

## Validation Targets

- Backend schema/helper tests for toast scope and TTL.
- Frontend GlobalSync tests or focused extraction tests for fresh/stale/malformed toast behavior.
- Typecheck focused on touched packages if test harness allows.

## Stop Gates In Force

- Stop if adding a new routing fallback seems necessary.
- Stop if a publisher cannot be safely classified as system/user/workspace/session.

## Execution-Ready Checklist

- [x] Proposal captures original requirement.
- [x] Design defines scope and TTL contract.
- [x] IDEF0 and GRAFCET validate.
- [x] Test vectors cover fresh, stale, missing freshness, and invalid scope.
- [x] Critical files are identified.
