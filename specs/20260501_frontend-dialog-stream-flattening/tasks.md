# Tasks

## 1. Plan and contract

- [x] 1.1 Capture product model: one canvas, append-only cards, single turn status line
- [x] 1.2 Map current embedded stream wrappers to product-level layers
- [x] 1.3 Identify wrappers that can be merged without touching data reducers
- [x] 1.4 Walk actual TaskDetail / SessionStreamPanel / TaskSessionOutput / SessionTurn DOM and record concrete wrapper inventory (see design.md "Wrapper inventory")

## 2. Implementation slices

### 2.A Wrapper inventory & scroll-owner audit (read-only)

- [ ] 2.A.1 Snapshot the three current scroll owners in TaskDetail before any change:
  - outer page scroll: `packages/app/src/pages/task-list/task-detail.tsx:343` `<div class="flex-1 overflow-y-auto px-4 py-3 space-y-3">`
  - SessionStreamPanel inner: `packages/app/src/pages/task-list/task-detail.tsx:701` `<div class="overflow-y-auto resize-y" style="height:240px">`
  - ExecLog inner: `packages/app/src/pages/task-list/task-detail.tsx:458` `<div class="border-t ... overflow-y-auto resize-y" style="height:160px">`
- [ ] 2.A.2 Record which scroll owner each card currently lives under (Prompt card, Output card, ExecLog card) — confirm Output card's dialog stream is the only stream targeted by this plan (DD-7)

### 2.B Collapse SessionStreamPanel inner scroll (single owner = outer)

- [ ] 2.B.1 Remove `overflow-y-auto resize-y` + fixed `height/min-height/max-height` from `SessionStreamPanel` inner content div (`task-detail.tsx:701`); keep the rounded-lg border card and Output title row (DD-8). Dialog stream cards now flow in normal layout inside the bordered Output card; the outer `flex-1 overflow-y-auto` (line 343) becomes the single scroll owner per DD-11.
- [ ] 2.B.2 Verify SessionStreamPanel still renders the same content states (testing-only / empty / outputError / sessionId) without inner scroll — they become full-height block sections inside the Output card, no nested viewport.
- [ ] 2.B.3 Confirm no card-internal padding or width changes are introduced; only the wrapper's overflow + height attributes are removed (Layout deformation guardrail in design.md).

### 2.C Merge SessionStreamPanel and TaskSessionOutput public surface

- [ ] 2.C.1 Decide whether to fold `TaskSessionOutput` (`task-detail.tsx:636-677`) into the inner body of `SessionStreamPanel` (`task-detail.tsx:679-715`) so external callers see one component (`<DialogStreamCanvas/>` conceptually). Internal `<For userMessages>` over `<SessionTurn variant="embedded">` stays unchanged.
- [ ] 2.C.2 Rename / re-export the merged component as the single TaskDetail dialog stream entry point. No data-reducer or message/part ID changes (R4, invariants.md).

### 2.D Preserve tool/result card display (no behavioral change)

- [ ] 2.D.1 Keep `<SessionTurn variant="embedded">` unchanged for tool call / tool result rendering; do NOT add expand/collapse behavior here (DD-9).
- [ ] 2.D.2 Spot-check `packages/ui/src/components/session-turn.tsx:984` (`data-slot="session-turn-content"`) and `:992` (`data-slot="session-turn-message-container"`) — embedded variant's existing class chain remains the card-grouping primitive. No edits in this slice.

### 2.E Route TaskDetail live status through turn status line only

- [ ] 2.E.1 Confirm SessionTurn embedded variant currently renders the inline status row (`inlineStatus` default `true`) inside `[data-component="session-turn"]` scope so the existing scoped `[data-slot="session-turn-status-inline"]` CSS applies (`packages/ui/src/components/session-turn.css:591`).
- [ ] 2.E.2 Verify TaskDetail does NOT pass any `statusOverride` / `inlineStatus={false}` / `onStatusLineChange` (it is not the full-session-page dock-anchored flow). Status remains inline at the bottom of the last user message turn.
- [ ] 2.E.3 Search TaskDetail and adjacent files for any other status surface (footer toast, inline banner, prompt-dock fragment) and remove if present (R2 + STATUS_SURFACE_CONFLICT in errors.md). Initial scan: no separate status path exists in TaskDetail today — confirm via grep at execution time.

### 2.F Remove obsolete prompt-dock / status-footer attempts in TaskDetail flow

- [ ] 2.F.1 Grep for `setStatusFooter`, `statusFooter`, `prompt-dock`, `status-footer` references inside `packages/app/src/pages/task-list/` — record findings; remove only those wired to TaskDetail's stream surface. (Out of scope: full session page's `ui.statusFooter` in `packages/app/src/pages/session.tsx`.)
- [ ] 2.F.2 Update [docs/events/](docs/events/) with an event log entry recording the wrapper removal + scroll-owner consolidation.

## 3. Verification and docs

- [ ] 3.1 Static checks (no daemon restart needed):
  - `bun run --cwd packages/app typecheck`
  - `bun run --cwd packages/ui typecheck`
  - `bun run --cwd packages/app build`
  - `git diff --check`
- [ ] 3.2 Manual UI verification (after explicit approved reload):
  - Open a task with an existing session, scroll the TaskDetail panel — verify there is exactly one scrollbar (the outer one, line 343 origin); no nested scroll or `resize-y` handle inside the Output card.
  - Trigger a test run that produces streaming output — verify the Output card grows naturally; cards append in order; the outer scroll auto-pins to bottom only when the user is already at bottom; scrolled-up state does NOT jump.
  - Run a tool that takes >5s — verify the live status appears as the inline turn status line inside the last user message turn (not as a separate footer or toast).
  - Trigger compaction (or simulate via long context) — verify status routes through the same inline turn status line, not a separate surface.
- [ ] 3.3 Update specs sync:
  - `bun run ~/projects/skills/plan-builder/scripts/plan-sync.ts specs/20260501_frontend-dialog-stream-flattening/`
  - Update `specs/architecture.md` if SessionStreamPanel public surface changed (note: this plan slices to a single bounded refactor; arch update may not be required — verify and explicitly mark "No doc changes" if so).
- [ ] 3.4 Promote state `planned → implementing` upon first `- [x]` in section 2; `implementing → verified` only after all section 3 manual checks pass and evidence is recorded in handoff.md or the event log (per plan-builder §16.6).

## Stop gates (mirror handoff.md)

- Stop before any daemon / gateway restart.
- Stop if any slice would require touching message reducers, message/part IDs, or backend event contract (R4, invariants.md).
- Stop if removing the inner scroll causes content to overflow without a clear single-owner replacement — re-evaluate before forcing through.
- Stop if accessibility primitives (Dialog/Kobalte) need removal — that is out of scope (DD-5).
- Stop and ask before changing tool call card visuals or expansion (DD-6, DD-9).
