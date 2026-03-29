# Handoff

## Status

- Source plan: `plans/20260327_plan-enter-plans-20260327-durable-cron-scheduler/`
- Promotion status: promoted to this semantic spec root after the planning package was completed and the user explicitly requested promotion.
- This root documents the formal first-version trigger framework contract; it is not proof that every downstream implementation slice has already shipped.

## Read Order For Future Work

1. `specs/dialog_trigger_framework/design.md`
2. `specs/dialog_trigger_framework/spec.md`
3. `specs/architecture.md`
4. Historical plan artifacts only when implementation archaeology is needed:
   - `plans/20260327_plan-enter-plans-20260327-durable-cron-scheduler/design.md`
   - `plans/20260327_plan-enter-plans-20260327-durable-cron-scheduler/implementation-spec.md`
   - `plans/20260327_plan-enter-plans-20260327-durable-cron-scheduler/tasks.md`

## What This Package Preserves

- why dialog-trigger behavior needs a named framework
- the v1 detector/policy/action split
- why next-round rebuild is authoritative for the first version
- why `plan_enter` naming repair belongs to framework integrity
- what remains intentionally out of scope in v1

## Maintenance Rules

- Keep the first version deterministic and evidence-based.
- Do not silently widen scope from trigger routing into a full hidden orchestration governor.
- Treat planner naming repair as a bounded, explicit slice unless a broader lifecycle redesign is separately approved.
- Keep framework claims aligned with actual runtime authority; do not document capabilities the runtime does not truly enforce.

## Historical Note

The source plan completed the planning package itself (`tasks.md` all checked), but downstream build work may still remain. Promotion to `/specs/` means the planning knowledge is now formalized, not that every implementation slice is automatically complete.
