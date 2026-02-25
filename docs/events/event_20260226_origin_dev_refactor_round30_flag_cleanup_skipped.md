# Event: origin/dev refactor round30 (flag cleanup)

Date: 2026-02-26
Status: In Progress

## 1) Goal

Evaluate upstream `flag.ts` cleanup commit for rewrite-only adoption and confirm whether it provides net value without semantic drift risk.

## 2) Candidate

- Upstream commit: `f66624fe6eba5aa00662c8d0925c5c6795b2b986`
- Subject: `chore: cleanup flag code (#13389)`

## 3) Decision + rationale

- Decision: **Skipped**
- Rationale:
  - Upstream change is primarily stylistic refactor (`truthyValue` removal + minor wiring cleanup).
  - Current cms `flag.ts` has already diverged in env-flag semantics (notably `OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT` handling), so direct port of this cleanup-only commit could unintentionally alter runtime defaults.
  - Under value-driven rewrite-only policy, no user-facing bugfix gain justifies semantic risk.

## 4) File scope reviewed

- `packages/opencode/src/flag/flag.ts`

## 5) Validation plan / result

- Validation method: upstream diff and local file-level semantic comparison.
- Result: skipped due low value + potential behavior drift risk.

## Architecture gate

- Checked `docs/ARCHITECTURE.md` before decision.
- No architecture change applied.
