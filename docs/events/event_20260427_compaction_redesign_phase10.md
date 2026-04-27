# Event: compaction-redesign phase 10 — UI consumption surface

## Phase

10 — expose `Memory.renderForHuman` to UI consumers and wire DD-10's
`/compact --rich` flag into the existing `/session/:id/summarize`
endpoint.

## What was discovered

There is **no current frontend consumer** of legacy SharedContext.snapshot
or rebind-checkpoint disk file content. `packages/app/` has nothing to
"replace" in the literal sense the original tasks.md task 10.2
described. So phase 10 is reframed: provide a clean **server-side
endpoint** that any future UI can adopt to display the human-readable
form of session memory.

## Done

### 10.2 New endpoint: `GET /session/:id/memory`

Query parameter `form=llm|human` (default `human`). Returns:

```ts
{
  sessionID: string
  form: "llm" | "human"
  text: string             // renderForLLMSync or renderForHumanSync output
  version: number          // Memory.version for cache-busting
  updatedAt: number        // epoch ms
  turnSummariesCount: number
  fileIndexCount: number
  actionLogCount: number
  lastCompactedAt: { round: number; timestamp: number } | null
}
```

A consumer (UI sidebar, debug overlay, scrollable preview) calls this
once and gets both the rendered text and the metadata it needs to
display a "session has N turns / last compacted T ago" badge.

The endpoint is read-only and side-effect-free. It still triggers
Memory's lazy migration on first read of a legacy session (per phase 1
DD-3 fallback), so calling it on a never-touched session post-deploy
also primes the new Storage path.

### 10.4 `/compact rich` flag (DD-10)

`POST /session/:sessionID/summarize` body schema gains
`rich: z.boolean().optional().default(false)`. When `rich: true`:

1. Skip the legacy `SessionCompaction.create` + `SessionPrompt.loop`
   path entirely.
2. Call `SessionCompaction.run({sessionID, observed: "manual",
   step: 0, intent: "rich"})` directly.
3. Inside `run`, the `intent === "rich"` branch (already implemented in
   phase 4) collapses the kind chain to `["llm-agent"]` only.

Result: `/compact rich:true` skips kinds 1-3 + 4 (free narrative /
schema / replay-tail / low-cost-server) and forces a full LLM round
with the compaction agent's narrative-rich prompt template.

The existing `auto: boolean` flag is preserved and unchanged — current
callers who don't pass `rich` see no behavioural difference.

### 10.1 / 10.3 status

- 10.1 No existing UI consumer to replace — see "What was discovered".
- 10.3 Manual smoke deferred to phase 11 acceptance gate (needs
  running daemon + curl).

## Validation

- `bun test packages/opencode/src/session/{compaction,compaction-run,memory,prompt.turn-summary-capture,prompt.observed-condition,compaction.regression-2026-04-27}.test.ts`
  → **77 pass / 0 fail / 252 expectations**.
- `bunx tsc --noEmit` clean for the two newly-modified files
  (compaction.ts, prompt.ts) and the routes file. The 5 pre-existing
  TS errors in `routes/session.ts` (lines 2617-2679, around message
  shape mismatches) predate phase 10 — verified by `git stash` baseline
  test before my edits showed the same errors at lines 2532-2594.
- `plan-validate` PASSES at `state=implementing`.

## Drift

None. The endpoint is purely additive; no spec field was retroactively
changed.

## Out of scope

- Wiring the new endpoint into a specific UI surface (session-list
  card, command palette preview, debug pane). That's frontend work
  better done by whoever owns those surfaces.
- A WebSocket / SSE push for live Memory updates — current pull model
  via the GET endpoint is sufficient for typical UI cadence (refresh
  on session change or user-triggered preview).

## Files changed

- `packages/opencode/src/server/routes/session.ts` — new GET
  `/:sessionID/memory` route; `/:sessionID/summarize` body gains
  `rich` flag.
- `specs/compaction-redesign/tasks.md` — phase 10 boxes checked.

## Remaining

- Phase 9 (deprecation shim documentation) — `process()` already a
  thin shim with `log.warn`; phase 9 is essentially documentation.
- Phase 11 manual smoke + final spec promotion.
- Phase 12 (next-release shim removal) — independent.
