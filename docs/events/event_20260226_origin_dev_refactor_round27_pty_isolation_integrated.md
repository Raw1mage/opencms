# Event: origin/dev refactor round27 (pty isolation)

Date: 2026-02-26
Status: In Progress

## 1) Goal

Continue rewrite-only refactor flow by evaluating PTY output-isolation upstream fix and deciding whether cms needs a behavioral port.

## 2) Candidate

- Upstream commit: `548608b7ad1252af3181201ef764b16c05d0b786`
- Subject: `fix(app): terminal pty isolation`

## 3) Decision + rationale

- Decision: **Integrated**
- Rationale:
  - Current cms `Pty` implementation already includes equivalent and stronger isolation guards:
    - subscriber map keyed by socket with per-connection identity token,
    - stale/raw socket reuse rejection,
    - safe send/close cleanup paths,
    - route-side raw socket narrowing + error cleanup hook.
  - Regression coverage already exists in `packages/opencode/test/pty/pty-output-isolation.test.ts` with both wrapper-token and socket-reuse scenarios.

## 4) File scope reviewed

- `packages/opencode/src/pty/index.ts`
- `packages/opencode/src/server/routes/pty.ts`
- `packages/opencode/test/pty/pty-output-isolation.test.ts`

## 5) Validation plan / result

- Validation method: upstream-vs-current behavioral diff review.
- Result: integrated-equivalent (plus additional hardening) confirmed; no code port required.

## Architecture gate

- Checked `docs/ARCHITECTURE.md` before execution.
- No architecture boundary change; no architecture doc update required.
