# 2026-04-23 — Autonomous opt-in: main-as-SSOT pivot and Phase 4-7 build

## TL;DR

Completed the verbal-arm / verbal-disarm / auto-refill path for the `autonomous-opt-in` spec, after discovering Phase 1-2 were implemented on a shelf branch (`shelf/autonomous-opt-in`) but never merged. User chose **main as SSOT**: shelf branch abandoned, spec revised to drop the R0+R1+R2+R3 layered gate in favour of main's single `workflow.autonomous.enabled` boolean. Phase 1-3 cancelled as obsolete; Phase 4-8 retargeted and shipped.

## Trigger

A cisopro session (`ses_24bfd7326ffekr4oXOmompwMf4`) surfaced the original problem: `workflow.autonomous.enabled=false` since 2026-04-19 (`1ed57f092` fix on main), UI toggle removed on 2026-03-21 (`4015565cd`), no verbal trigger wired. Session was never armed; every apparent "autonomous" run was plan-agent-driven subagent chains inside a single round. User asked to deliver verbal arming as-originally-intended.

## Discovery — shelf branch had Phase 1+2 unmerged

```
shelf/autonomous-opt-in (local + remote beta):
  ed8e9be2e feat(autorun): Phase 2 — runtime gate replaces always-on loop
  6db33208d feat(autorun): Phase 1 — Storage namespaces, atomic flag, Bus events
```

These built the richer layered gate: `SessionActiveSpec` binding, `AutorunArmed` flag with 50-entry history cap, seven-event Bus vocabulary, `Gate.isAutorunArmed(sessionID)` R0+R1+R2+R3 predicate. Main diverged via `1ed57f092` to a simpler single-flag gate and shelf was stranded.

## Decision — main is the SSOT

User preferred to move forward on main's simpler gate rather than resurrect shelf. Shelf content discarded (local reset of beta worktree to `main`). Spec revised:

- DD-11 added to `specs/autonomous-opt-in/design.md` codifying main-as-SSOT
- DD-1, DD-2, DD-4, DD-5, DD-7 marked `[SUPERSEDED by DD-11]`
- DD-6 and DD-8 marked `[REVISED]`
- Phase 1 / Phase 2 / Phase 3 marked `[-]` cancelled in `tasks.md` with per-task reasons
- `.state.json` gained a `revise` history entry capturing the pivot

Scope shrank from 8 phases / ~30 tasks (2-3 days) to 5 phases / ~15 tasks (≈1 day).

## Build — 5 commits on `beta/autonomous-opt-in-main-ssot`

| Commit | Phase | What |
|---|---|---|
| `723dcb902` | 4.1 | Tweaks config gains `autorun_trigger_phrases` + `autorun_disarm_phrases` (pipe-separated), async + sync accessors |
| `7c76fe925` | 4.2+4.3 | `autorun/detector.ts` (pure) + ingest wiring in `prompt.ts` → `Session.updateAutonomous` |
| `cc029ae69` | 4.4+4.5 | Seed phrases in `templates/system/tweaks.cfg`; 23 new tests (18 detector + 5 parser) |
| `67206e9ff` | 5 | `autorun/observer.ts` — `KillSwitchChanged` subscriber sweeps every armed root session to disarmed; 10 new tests |
| `c04de4498` | 6 | `autorun/refill.ts` + `decideAutonomousContinuation` integration; armed-drained sessions pull next `## N.` phase from active spec's `tasks.md`; if none, disarm with `stopReason: plan_drained`. 12 new pure-logic tests |

Total: 60 new tests (40 autorun + 5 parser + 18 detector - see breakdown above), all passing; 26 existing workflow-runner tests still pass; TypeScript typecheck clean for all new files.

## Behaviour summary after this change

- User types any configured trigger phrase (default: `接著跑`, `自動跑`, `開 autonomous`, `autorun`, `keep going`, `continue autonomously`) → the session is armed, runloop continues after current round
- User types any disarm phrase (default: `停`, `暫停`, `stop`, `halt`) → session disarmed, runloop stops after current round
- Operator hits killswitch → all armed root sessions in the instance disarm via Bus observer
- Armed session finishes all todos → refill pulls the next phase of `tasks.md` from the session's active `specs/<slug>/` (where `.state.json.state === "implementing"`)
- No active implementing-state spec → disarm with `stopReason: plan_drained`; operator explicitly sees autonomous completed
- All phrases are pipe-separated in `/etc/opencode/tweaks.cfg` so operators can extend without rebuilding

## Artifacts that did NOT change

- `permissions.autoaccept.enable/disable` slash commands: spec task 7.2 proposed deletion but the handlers are real and wired (`input.permission.enableAutoAccept`); deletion refused, i18n strings for them kept across 15+ locales.
- UI toggle: not reintroduced per DD-11. Verbal is the sole user arm path.

## Follow-ups deferred

- Phase 8 integration/manual verification pending: `bun test` full suite, chat-latency regression check, live verbal-arm observation in a real session, end-to-end refill on a real `tasks.md`
- Telemetry dashboard for arm / disarm / plan_drained events — not in scope for this build; can be added via existing `bus.session.workflow.updated` event consumers

## Risk register

- Phrase false-positives: "stop talking about autorun" would trigger `autorun` (arm) because it contains the substring. Accepted: user can edit tweaks.cfg to narrow phrases.
- Multi-spec ambiguity: refill declines when >1 spec is in `state=implementing`; observed log `autorun refill: multiple specs in implementing state, declining`. User must resolve by demoting one.
- Plan-drained disarm writes twice (enabled=false + stopReason=plan_drained) across two `Session.update` calls; not atomic. Low risk — both writes are idempotent and converging.

## References

- spec package: `specs/autonomous-opt-in/` (state=implementing after this build; promote to verified after Phase 8)
- beta branch: `beta/autonomous-opt-in-main-ssot` (5 commits on top of main@899fe6fbc)
- superseded design: `shelf/autonomous-opt-in` (abandoned, can be deleted when user confirms)
