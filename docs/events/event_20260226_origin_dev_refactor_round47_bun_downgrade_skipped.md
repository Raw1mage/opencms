# Event: origin/dev refactor round47 (bun downgrade)

Date: 2026-02-26
Status: In Progress

## 1) Goal

Evaluate upstream Bun downgrade commit against current cms toolchain direction.

## 2) Candidate

- Upstream commit: `2db618dea33517a0f36567de28d010ee7770a800`
- Subject: `fix: downgrade bun to 1.3.5`

## 3) Decision + rationale

- Decision: **Skipped**
- Rationale:
  - Current cms stream already aligns on Bun `1.3.9` path (including launcher/cpu-detection related updates).
  - Downgrading toolchain here would conflict with later integrated upstream direction and increase maintenance churn.

## 4) File scope reviewed

- `package.json`
- `bun.lock`

## 5) Validation plan / result

- Validation method: toolchain-version parity check with current cms baseline.
- Result: skipped.

## Architecture gate

- Checked `docs/ARCHITECTURE.md` before decision.
- No architecture change applied.
