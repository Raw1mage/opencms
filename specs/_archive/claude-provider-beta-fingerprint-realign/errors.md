# Errors: claude-provider-beta-fingerprint-realign

## Error Catalogue

This refactor introduces no new error codes. `assembleBetas()` is total — every input combination produces a valid output array; no exceptions are thrown.

The two error surfaces this plan touches indirectly:

### Existing Anthropic API errors that may shift after deploy

| Code / shape | Source | Behavior before realign | Behavior after realign |
|---|---|---|---|
| `400 Bad Request: invalid beta header` | Anthropic API | Possible if server rejected unknown beta combinations (e.g. `context-management` on a non-firstParty path that opencode never actually used) | Should not occur; conditions now align with upstream |
| `400 Bad Request: thinking field missing` | Anthropic API | n/a | Possible if `redact-thinking-2026-02-12` is sent without `thinking` block — gate must verify thinking is enabled |
| Server-side fingerprint silent downgrade | Anthropic API (no error returned, just degraded behavior) | Suspected when our beta order didn't match upstream | Should be eliminated; observable as no rate-limit / quota anomalies post-deploy |

### Test-only failure modes (not user-facing)

| Failure | Where it surfaces | Recovery |
|---|---|---|
| `expected output array does not match` | `bun test packages/provider-claude/test/protocol.test.ts` | Re-read spec.md Requirement 4 push order; do not edit the test to match buggy code |
| `MINIMUM_BETAS still imported by X` | `grep` guardrail in Task 5.2 | Find and remove the import; this is a R-2 risk realization |
| `iO_ predicate disagreement` (matrix expects context-management but assembler omits, or vice versa) | unit test | Re-grep `iO_` definition; update `modelSupportsContextManagement` to match; do NOT silently work around |

## No Silent Fallback (AGENTS.md §1)

Per AGENTS.md root rule: any helper that fails to determine a condition (e.g. unknown provider) MUST throw, not silently default to `true` or `false`. The `provider` enum is closed; an out-of-set value to `isFirstPartyish` or `modelSupportsContextManagement` is a programmer error and should fail loudly during development.
