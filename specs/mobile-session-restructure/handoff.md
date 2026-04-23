# Handoff: mobile-session-restructure

## Execution Contract

The build agent picks up at Phase 1 and works phase-by-phase per
`tasks.md`. Per plan-builder §16.5 phase boundaries are rhythmic
checkpoints; only genuine stop gates pause work.

Lifecycle transitions:
- `planned → implementing` on first 1.1 checkbox flip
- `implementing → verified` when all Phase 7 acceptance checks
  documented as evidence in this folder
- `verified → living` after merge to main (Phase 8)

## Required Reads

1. [proposal.md](proposal.md) — RCA v3 (file-body duplication);
   asymmetry principle (client→server ok, server→client no);
   "nice-to-have, no retention" framing
2. [spec.md](spec.md) — 6 Requirements × GWT scenarios + 7
   acceptance checks
3. [design.md](design.md) — DD-1..DD-9 (schema drop, no on-demand,
   no UI viewer, owned-diff via git, migration mechanics)
4. [data-schema.json](data-schema.json) — slim FileDiff shape +
   migration marker + script options
5. [errors.md](errors.md), [observability.md](observability.md) —
   error codes and telemetry

Reference on demand:
- [idef0.json](idef0.json), [grafcet.json](grafcet.json),
  [c4.json](c4.json), [sequence.json](sequence.json)

## Beta Workflow

Implementation runs on the beta worktree
`/home/pkcs12/projects/opencode-beta` on branch
`beta/mobile-session-restructure` (created from `main` HEAD).
Main repo at `/home/pkcs12/projects/opencode` is not touched
until fetch-back at Phase 8.

## Stop Gates In Force

- **SG-1 destructive**: any code change outside
  `packages/opencode/src/{snapshot,session,project,cli,server}/`
  or `packages/{app,ui,enterprise}/src/` requires user approval.
- **SG-2 operator backup missing**: before Phase 8.3 (running
  migration for real), verify the backup directory exists —
  `ls -d ~/.local/share/opencode/storage/session.bak-*`. If
  absent, stop and surface to operator.
- **SG-3 owned-diff regression**: if A3 parity check reveals any
  diverging output, stop Phase 3 and investigate; do NOT proceed
  to Phase 7.
- **SG-4 migration dry-run surprise**: if Phase 8.3 dry-run
  reports unexpected record counts, malformed files > 1 %, or
  any session that cannot be slimmed — stop, surface to operator,
  do NOT run for real.
- **SG-5 UI breakage**: if Phase 4 simplification leaves an
  unreferenced component / type error / runtime crash on load,
  stop and resolve before Phase 5.
- **SG-6 git invocation failure**: during owned-diff testing, if
  git invocations fail on clean fixtures, stop — this invalidates
  the whole derivation approach and spec needs design revisit.

## Per-Task Ritual

After each `- [ ]` → `- [x]`:
1. Mark tasks.md immediately.
2. Run `bun run ~/projects/skills/plan-builder/scripts/plan-sync.ts specs/mobile-session-restructure/`.
3. Read output; apply §16.3 drift decision tree.
4. Update TodoWrite to `completed`.

## Phase-boundary Ritual

At each phase end: append phase-summary block to
`docs/events/event_<YYYYMMDD>_mobile_session_restructure_phase<N>.md`
covering tasks completed, key decisions, validation evidence,
drift resolved, remaining.

## Execution-Ready Checklist

Before Phase 1.1:

- [ ] Read all Required Reads above
- [ ] Beta worktree on `beta/mobile-session-restructure` created from main
- [ ] Main repo at clean commit (operator's own dirty files
  untouched but acknowledged)
- [ ] XDG runtime untouched until Phase 8 rollout

## Out-of-Scope Reminders (do not drift)

- Do NOT build an on-demand diff endpoint (DD-4 is explicit: none).
- Do NOT refactor UI to keep diff-viewing "just differently" — the
  viewer is deleted per DD-5.
- Do NOT extract a shared diff-derive helper — owned-diff calls git
  inline per DD-3.
- Do NOT preserve a feature flag for rollback — DD-7 is explicit:
  no flag.
- Do NOT touch the git snapshot mechanism itself.
- Do NOT touch client-to-server file upload paths.

## Backup Pre-condition (CRITICAL)

Before Phase 8.3 (running migration for real), the operator MUST
execute:

```
cp -a ~/.local/share/opencode/storage/session/ \
      ~/.local/share/opencode/storage/session.bak-$(date +%Y%m%d-%H%M)/
```

The migration script does NOT self-backup. If anything goes wrong,
the backup is the only recovery path.

## Promotion

- `planned → implementing` automatic on first task check
- `implementing → verified` after Phase 7 evidence attached (logs,
  du measurements, parity outputs)
- `verified → living` after fetch-back merge to main + smoke on
  live daemon
