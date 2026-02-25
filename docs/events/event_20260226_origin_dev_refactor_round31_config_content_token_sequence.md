# Event: origin/dev refactor round31 (config-content token sequence)

Date: 2026-02-26
Status: In Progress

## 1) Goal

Resolve upstream commit sequence around `OPENCODE_CONFIG_CONTENT` token substitution (`fix` then `revert`) using value-first rewrite-only policy for cms.

## 2) Candidate(s)

- `29671c1397b0ecfb9510186a0aae89696896da2a`
  - `fix: token substitution in OPENCODE_CONFIG_CONTENT (#13384)`
- `1fb6c0b5b356e3816398ba71ac1b01485697bc31`
  - `Revert "fix: token substitution in OPENCODE_CONFIG_CONTENT" (#13429)`

## 3) Decision + rationale

- `29671c...`: **Integrated**
  - cms already supports `OPENCODE_CONFIG_CONTENT` token substitution via config load path and test coverage.
- `1fb6c0...`: **Skipped**
  - cms intentionally retains token-substitution behavior; reverting would remove existing capability and break local expectation/tests.

## 4) File scope reviewed

- `packages/opencode/src/config/config.ts`
- `packages/opencode/src/flag/flag.ts` (sequence context)
- `packages/opencode/test/config/config.test.ts`

## 5) Validation plan / result

- Validation method: code-path verification + test fixture presence check.
- Result:
  - integrated for `29671c...` (already present)
  - skipped for `1fb6c0...` (do not regress feature)

## Architecture gate

- Checked `docs/ARCHITECTURE.md` before decision.
- No architecture boundary change applied.
