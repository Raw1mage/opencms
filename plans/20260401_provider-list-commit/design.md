# Design: Recovery Refactor After 2026-04-01 Drift

## Context

- `cms` experienced a confirmed pointer drift on 2026-04-01 that removed a large capability range from the mainline-visible branch history.
- `recovery/cms-codex-20260401-183212` already restored most critical-path behavior, including the provider dialog rename/polish and `claude-cli` provider registration fix.
- The remaining gaps are not best recovered as raw commit replay because multiple slices depend on stale branch topology or old execution surfaces.
- The rewritten beta-workflow contract now forbids treating stale beta/test surfaces as mainline authority, so the recovery strategy must be evidence-first refactor.

## Goals / Non-Goals

**Goals:**

- Restore the remaining high-value capability groups in value order with minimal blast radius.
- Keep each recovery slice independently understandable, testable, and reversible before moving to the next slice.

**Non-Goals:**

- Rebuild historical branch ancestry exactly.
- Mix multiple high-value capability groups into one implementation pass.

## Decisions

- Recover by capability chain, not by original commit order; this reduces coupling to stale branch topology and keeps validation local.
- Start with Claude Native / `claude-provider` because it is the highest-value missing chain and the most product-distinct capability still absent, but decompose it further because the current tree lacks its source scaffold and live native integration surface.
- Treat the already-restored `模型提供者` dialog as done; the remaining provider-manager work is a later product-completion slice, not the next urgent recovery target.
- Use old commits as evidence sources only; do not treat them as merge authority.
- Insert beta bootstrap before all coding slices so implementation happens only on a disposable beta execution surface derived from the authoritative recovery branch.

## Data / State / Control Flow

- Historical lost-range analysis identifies candidate capability slices; the planner converts those slices into ordered refactor work.
- For each slice, current recovery code is the implementation base, while historical commits and refs serve as evidence for expected behavior and missing boundaries.
- Validation evidence flows into `docs/events/event_20260401_cms_codex_recovery.md`, and architecture changes (if any) flow into `specs/architecture.md`.
- Authority and worktree safety remain governed by the rewritten beta-workflow contract; planner/build execution must not re-open stale branch authority.

## Risks / Trade-offs

- Deep dependency risk in the Claude Native chain -> recover it as a bounded first slice and stop if backend/runtime contracts are larger than expected.
- Missing source scaffold risk in the Claude Native chain -> split the work into scaffold, auth bridge, loader wiring, and activation stages so each stage can stop independently.
- Runtime hardening commits may have hidden interactions -> prefer current-code adaptation plus targeted validation over raw cherry-pick.
- Runtime/context hardening is itself a multi-slice area -> split lazy tool loading, compaction truncation, and toolcall guidance into separate bounded slices to avoid cross-subsystem blast radius.
- Session hardening is narrower than first expected -> current evidence says the real missing gap is rebind checkpoint durability/injection, while other continuation protections largely already exist in the current tree; keep the first session slice scoped to that bounded gap.
- Provider-manager recovery is also narrower than first expected -> the main remaining gap is webapp model-manager semantics in `dialog-select-model.tsx` (local visibility state, favorites by connected accounts, no provider-level disabled toggle), while reopen-geometry cleanup should stay separate.
- Provider-manager closure evidence may still be weaker than desired even after semantic validation -> allow one bounded remediation slice for target readiness/type issues and direct hidden-provider execution coverage before finalize.
- Slice-by-slice recovery is slower than bulk merge -> accepted because correctness, traceability, and authority safety are more important than speed.
- Some original SHAs will remain absent from ancestry even when functionality is restored -> accepted because functional recovery is the real goal.

## Critical Files

- `packages/opencode-claude-provider/**`
- `packages/opencode/src/provider/**`
- `packages/opencode/src/session/**`
- `packages/opencode/src/tool/**`
- `packages/opencode/src/auth/**`
- `packages/app/src/components/dialog-select-provider.tsx`
- `packages/app/src/components/dialog-custom-provider.tsx`
- `packages/app/src/hooks/use-providers.ts`
- `docs/events/event_20260401_cms_codex_recovery.md`
- `specs/architecture.md`

## Supporting Docs (Optional)

- `docs/events/event_20260401_cms_codex_recovery.md`
- `specs/architecture.md`
