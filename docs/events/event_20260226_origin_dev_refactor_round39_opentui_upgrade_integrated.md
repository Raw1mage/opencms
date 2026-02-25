# Event: origin/dev refactor round39 (opentui upgrade)

Date: 2026-02-26
Status: In Progress

## 1) Goal

Evaluate upstream `@opentui/*` dependency bump for cms compatibility and determine port requirement.

## 2) Candidate

- Upstream commit: `125727d09c4482f351ee3e0d448db7efc116213d`
- Subject: `upgrade opentui to 0.1.79`

## 3) Decision + rationale

- Decision: **Integrated**
- Rationale:
  - Current cms `packages/opencode/package.json` already pins:
    - `@opentui/core`: `0.1.79`
    - `@opentui/solid`: `0.1.79`
  - Upstream dependency intent is already satisfied locally.

## 4) File scope reviewed

- `packages/opencode/package.json`

## 5) Validation plan / result

- Validation method: dependency version parity check.
- Result: integrated-equivalent; no code change required.

## Architecture gate

- Checked `docs/ARCHITECTURE.md` before decision.
- No architecture change applied.
