# Event: origin/dev refactor round37 (win32 raw input/ctrl+c via ffi)

Date: 2026-02-26
Status: In Progress

## 1) Goal

Evaluate upstream Win32 FFI-based console mode guard for raw input/ctrl+c handling in TUI lifecycle.

## 2) Candidate

- Upstream commit: `8f9742d9886b4bfb5ac36a49810b7533985487ad`
- Subject: `fix(win32): use ffi to get around bun raw input/ctrl+c issues`

## 3) Decision + rationale

- Decision: **Skipped**
- Rationale:
  - Upstream change introduces a new Win32 FFI control layer (`kernel32` console-mode guard + hooking multiple TUI entrypoints).
  - cms TUI runtime already diverges with custom terminal-negotiation and input handling adjustments; adding this large platform-specific layer in current stream raises regression risk beyond the value/risk threshold.
  - Defer to a dedicated Windows-hardening batch where behavior can be validated with focused win32 runtime coverage.

## 4) File scope reviewed

- `packages/opencode/src/cli/cmd/tui/app.tsx`
- `packages/opencode/src/cli/cmd/tui/attach.ts`
- `packages/opencode/src/cli/cmd/tui/context/exit.tsx`
- `packages/opencode/src/cli/cmd/tui/thread.ts`
- `packages/opencode/src/cli/cmd/tui/win32.ts` (new upstream file)

## 5) Validation plan / result

- Validation method: upstream diff inspection and current TUI lifecycle comparison.
- Result: skipped due scope/risk for current round.

## Architecture gate

- Checked `docs/ARCHITECTURE.md` before decision.
- No architecture change applied.
